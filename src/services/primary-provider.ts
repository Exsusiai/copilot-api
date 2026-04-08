import consola from "consola"

import type { PrimaryProviderConfig } from "~/lib/config"
import type { State } from "~/lib/state"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

const FORWARDABLE_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
  "accept",
  "user-agent",
  "x-app",
  "x-claude-code-session-id",
  "x-client-request-id",
  "x-anthropic-additional-protection",
] as const

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const

export function isPrimaryAvailable(state: State): boolean {
  if (!state.isPrimaryRateLimited) {
    return true
  }

  if (Date.now() >= state.primaryRateLimitResetTime) {
    state.isPrimaryRateLimited = false
    state.primaryRateLimitResetTime = 0
    consola.info(
      "[Primary] Rate limit reset, switching back to primary provider",
    )
    return true
  }

  return false
}

export function markPrimaryRateLimited(state: State, resetTime: number): void {
  state.isPrimaryRateLimited = true
  state.primaryRateLimitResetTime = resetTime
  const resetDate = new Date(resetTime)
  consola.warn(
    `[Primary] Rate limited, falling back to Copilot. Reset at: ${resetDate.toLocaleString()}`,
  )
}

export function buildPrimaryHeaders(
  config: PrimaryProviderConfig,
  incomingHeaders: Headers,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  }

  if (config.authMode === "apiKey" && config.apiKey) {
    headers["x-api-key"] = config.apiKey
  } else {
    // Forward auth headers from the incoming request (OAuth token or API key)
    const authorization = incomingHeaders.get("authorization")
    if (authorization) {
      headers["authorization"] = authorization
      consola.info(
        `[Primary] Forwarding authorization header (${authorization.slice(0, 20)}...)`,
      )
    }
    const xApiKey = incomingHeaders.get("x-api-key")
    if (xApiKey) {
      headers["x-api-key"] = xApiKey
      consola.info(
        `[Primary] Forwarding x-api-key header (${xApiKey.slice(0, 10)}...)`,
      )
    }
    if (!authorization && !xApiKey) {
      consola.warn(
        "[Primary] No auth headers found in incoming request — Anthropic will likely reject",
      )
    }
  }

  for (const headerName of FORWARDABLE_HEADERS) {
    const headerValue = incomingHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  return headers
}

export function createPrimaryProxyResponse(
  upstreamResponse: Response,
): Response {
  const headers = new Headers(upstreamResponse.headers)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return new Response(upstreamResponse.body, {
    headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

export async function forwardToPrimaryProvider(
  config: PrimaryProviderConfig,
  payload: AnthropicMessagesPayload,
  incomingHeaders: Headers,
): Promise<Response> {
  // Copilot uses dotted names (claude-opus-4.6) but Anthropic API requires dashes (claude-opus-4-6)
  const normalizedPayload = {
    ...payload,
    model: payload.model.replaceAll(".", "-"),
  }

  return await fetch(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: buildPrimaryHeaders(config, incomingHeaders),
    body: JSON.stringify(normalizedPayload),
  })
}

export interface RateLimitInfo {
  isQuotaLimit: boolean
  resetTime: number
  claim: string | null
}

export function parseRateLimitHeaders(response: Response): RateLimitInfo {
  const claim = response.headers.get(
    "anthropic-ratelimit-unified-representative-claim",
  )
  const resetHeader = response.headers.get("anthropic-ratelimit-unified-reset")
  const retryAfter = response.headers.get("retry-after")

  const isQuotaLimit =
    claim === "five_hour"
    || claim === "seven_day"
    || claim === "seven_day_opus"
    || claim === "seven_day_sonnet"

  let resetTime: number
  if (resetHeader) {
    resetTime = Number(resetHeader) * 1000
  } else if (retryAfter) {
    resetTime = Date.now() + Number(retryAfter) * 1000
  } else {
    resetTime = Date.now() + 30 * 60 * 1000
  }

  return { isQuotaLimit, resetTime, claim }
}
