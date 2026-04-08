import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  macMachineId?: string
  vsCodeSessionId?: string
  vsCodeDeviceId: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Primary provider rate limit tracking
  isPrimaryRateLimited: boolean
  primaryRateLimitResetTime: number
  primaryRateLimitClaim?: string

  // Proxy metrics
  primaryRequestCount: number
  copilotRequestCount: number
  lastBackendUsed: "primary" | "copilot" | "none"
  startTime: number

  verbose: boolean

  copilotApiUrl?: string
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  isPrimaryRateLimited: false,
  primaryRateLimitResetTime: 0,
  primaryRequestCount: 0,
  copilotRequestCount: 0,
  lastBackendUsed: "none",
  startTime: Date.now(),
  verbose: false,
  vsCodeDeviceId: randomUUID(),
}
