import { Hono } from "hono"

import { getPrimaryProviderConfig } from "~/lib/config"
import { state } from "~/lib/state"

export const proxyStatusRoute = new Hono()

function getCurrentBackend(primaryConfigured: boolean): string {
  if (!primaryConfigured) {
    return "copilot"
  }
  if (state.isPrimaryRateLimited) {
    return "copilot"
  }
  return "primary"
}

proxyStatusRoute.get("/", (c) => {
  const primaryConfig = getPrimaryProviderConfig()
  const now = Date.now()

  const primaryConfigured = Boolean(primaryConfig)
  const currentBackend = getCurrentBackend(primaryConfigured)

  let rateLimitResetIn = 0
  if (state.isPrimaryRateLimited) {
    rateLimitResetIn = Math.max(
      0,
      Math.ceil((state.primaryRateLimitResetTime - now) / 1000),
    )
  }

  return c.json({
    currentBackend,
    primaryConfigured,
    primaryRequestCount: state.primaryRequestCount,
    copilotRequestCount: state.copilotRequestCount,
    totalRequestCount: state.primaryRequestCount + state.copilotRequestCount,
    lastBackendUsed: state.lastBackendUsed,
    rateLimit: {
      isPrimaryRateLimited: state.isPrimaryRateLimited,
      resetTime: state.primaryRateLimitResetTime,
      resetIn: rateLimitResetIn,
      claim: state.primaryRateLimitClaim ?? null,
    },
    uptime: Math.floor((now - state.startTime) / 1000),
  })
})
