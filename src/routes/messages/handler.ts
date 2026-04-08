import type { Context } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import {
  getSmallModel,
  isMessagesApiEnabled,
  getPrimaryProviderConfig,
  getModelForCopilotFallback,
} from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { generateRequestIdFromPayload, getRootSessionId } from "~/lib/utils"
import {
  createPrimaryProxyResponse,
  forwardToPrimaryProvider,
  isPrimaryAvailable,
  markPrimaryRateLimited,
  parseRateLimitHeaders,
} from "~/services/primary-provider"

import type { SubagentMarker } from "./subagent-marker"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  handleWithChatCompletions,
  handleWithMessagesApi,
  handleWithResponsesApi,
} from "./api-flows"
import {
  isCompactRequest,
  mergeToolResultForClaude,
  stripToolReferenceTurnBoundary,
} from "./preprocess"
import { parseSubagentMarkerFromFirstUser } from "./subagent-marker"

const logger = createHandlerLogger("messages-handler")

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  debugJson(logger, "Anthropic request payload:", anthropicPayload)

  // Try primary provider (e.g., Anthropic API direct) before Copilot backend
  const primaryResult = await tryPrimaryProvider(c, anthropicPayload)
  if (primaryResult) {
    return primaryResult
  }

  // Falling through to Copilot backend
  state.copilotRequestCount++
  state.lastBackendUsed = "copilot"

  // Remap models for Copilot (e.g. claude-haiku → gpt-5-mini) per primaryFallbackModelMap config
  if (getPrimaryProviderConfig()) {
    anthropicPayload.model = getModelForCopilotFallback(anthropicPayload.model)
  }

  const subagentMarker = parseSubagentMarkerFromFirstUser(anthropicPayload)
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const sessionId = getRootSessionId(anthropicPayload, c)
  logger.debug("Extracted session ID:", sessionId)

  // claude code and opencode compact request detection
  const isCompact = isCompactRequest(anthropicPayload)

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  logger.debug("Anthropic Beta header:", anthropicBeta)
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools && !isCompact) {
    anthropicPayload.model = getSmallModel()
  }

  if (isCompact) {
    logger.debug("Is compact request:", isCompact)
  } else {
    stripToolReferenceTurnBoundary(anthropicPayload)

    // Merge tool_result and text blocks into tool_result to avoid consuming premium requests
    // (caused by skill invocations, edit hooks, plan or to do reminders)
    // e.g. {"role":"user","content":[{"type":"tool_result","content":"Launching skill: xxx"},{"type":"text","text":"xxx"}]}
    // not only for claude, but also for opencode
    // compact requests are excluded from this processing
    mergeToolResultForClaude(anthropicPayload)
  }

  const requestId = generateRequestIdFromPayload(anthropicPayload, sessionId)
  logger.debug("Generated request ID:", requestId)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const selectedModel = findEndpointModel(anthropicPayload.model)
  anthropicPayload.model = selectedModel?.id ?? anthropicPayload.model

  if (shouldUseMessagesApi(selectedModel)) {
    return await handleWithMessagesApi(c, anthropicPayload, {
      anthropicBetaHeader: anthropicBeta,
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact,
      logger,
    })
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return await handleWithResponsesApi(c, anthropicPayload, {
      subagentMarker,
      selectedModel,
      requestId,
      sessionId,
      isCompact,
      logger,
    })
  }

  return await handleWithChatCompletions(c, anthropicPayload, {
    subagentMarker,
    requestId,
    sessionId,
    isCompact,
    logger,
  })
}

const RESPONSES_ENDPOINT = "/responses"
const MESSAGES_ENDPOINT = "/v1/messages"

const shouldUseResponsesApi = (selectedModel: Model | undefined): boolean => {
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

const shouldUseMessagesApi = (selectedModel: Model | undefined): boolean => {
  const useMessagesApi = isMessagesApiEnabled()
  if (!useMessagesApi) {
    return false
  }
  return (
    selectedModel?.supported_endpoints?.includes(MESSAGES_ENDPOINT) ?? false
  )
}

const isClaudeModel = (model: string): boolean =>
  model.toLowerCase().startsWith("claude")

async function tryPrimaryProvider(
  c: Context,
  payload: AnthropicMessagesPayload,
): Promise<Response | null> {
  const primaryConfig = getPrimaryProviderConfig()
  if (!primaryConfig) {
    return null
  }

  if (!isClaudeModel(payload.model)) {
    logger.info(`[Primary] Skipping non-Claude model: ${payload.model}`)
    return null
  }

  if (!isPrimaryAvailable(state)) {
    logger.info("[Primary] Rate limited, skipping primary provider")
    return null
  }

  try {
    logger.info(
      `[Primary] Forwarding ${payload.model} to ${primaryConfig.baseUrl}`,
    )
    const upstreamResponse = await forwardToPrimaryProvider(
      primaryConfig,
      payload,
      c.req.raw.headers,
    )

    if (upstreamResponse.ok) {
      logger.info("[Primary] Success, returning response")
      state.primaryRequestCount++
      state.lastBackendUsed = "primary"
      return createPrimaryProxyResponse(upstreamResponse)
    }

    if (upstreamResponse.status === 429) {
      const rateLimitInfo = parseRateLimitHeaders(upstreamResponse)
      if (rateLimitInfo.isQuotaLimit) {
        markPrimaryRateLimited(state, rateLimitInfo.resetTime)
        state.primaryRateLimitClaim = rateLimitInfo.claim ?? undefined
      } else {
        logger.info(
          "[Primary] Transient rate limit (not quota), falling back to Copilot for this request",
        )
      }
      return null
    }

    // Other errors (401, 500, etc.) — log and fall through to Copilot
    const errorText = await upstreamResponse.text().catch(() => "")
    logger.warn(
      `[Primary] Error ${upstreamResponse.status}, falling back to Copilot: ${errorText.slice(0, 200)}`,
    )
    return null
  } catch (error) {
    logger.warn("[Primary] Network error, falling back to Copilot:", error)
    return null
  }
}
