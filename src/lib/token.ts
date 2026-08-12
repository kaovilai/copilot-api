import consola from "consola"
import { setTimeout as delay } from "node:timers/promises"

import { isOpencodeOauthApp } from "~/lib/api-config"
import { getRawProviderConfig, setProviderConfig } from "~/lib/config"
import {
  readCodexCredentials,
  readGitHubToken,
  writeCodexCredentials,
  writeGitHubToken,
} from "~/lib/credential-store"
import {
  isCodexCredentialsExpired,
  refreshCodexCredentials,
  type CodexCredentials,
} from "~/lib/oauth/codex"
import { CODEX_API_BASE_URL } from "~/services/codex/create-responses"
import {
  getCopilotToken,
  type GetCopilotTokenResponse,
} from "~/services/github/get-copilot-token"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"
import { getDeviceCode } from "~/services/github/get-device-code"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError, parseRetryAfterMs } from "./error"
import { state } from "./state"

let copilotRefreshLoopController: AbortController | null = null
let codexRefreshLoopController: AbortController | null = null

export const stopCopilotRefreshLoop = () => {
  if (!copilotRefreshLoopController) {
    return
  }

  copilotRefreshLoopController.abort()
  copilotRefreshLoopController = null
}

export const stopCodexRefreshLoop = () => {
  if (!codexRefreshLoopController) {
    return
  }

  codexRefreshLoopController.abort()
  codexRefreshLoopController = null
}

function applyCodexCredentials(credentials: CodexCredentials): void {
  state.codexAccessToken = credentials.accessToken
  state.codexRefreshToken = credentials.refreshToken
  state.codexExpiresAt = credentials.expiresAt
  state.codexAccountId = credentials.accountId

  consola.debug("Codex credentials loaded successfully")
  if (state.showToken) {
    consola.info("Codex access token:", credentials.accessToken)
  }
}

function getLoadedCodexCredentials(): CodexCredentials | null {
  if (
    !state.codexAccessToken
    || !state.codexRefreshToken
    || !state.codexExpiresAt
    || !state.codexAccountId
  ) {
    return null
  }

  return {
    accessToken: state.codexAccessToken,
    refreshToken: state.codexRefreshToken,
    expiresAt: state.codexExpiresAt,
    accountId: state.codexAccountId,
  }
}

function syncCodexProviderConfig(options?: { enabled?: boolean }): void {
  const existingProviderConfig = getRawProviderConfig("codex") ?? {}
  setProviderConfig("codex", {
    ...existingProviderConfig,
    type: "openai-responses",
    enabled: options?.enabled ?? existingProviderConfig.enabled,
    baseUrl: CODEX_API_BASE_URL,
    authType: "oauth2",
    pricingCurrency: "USD",
  })
}

export async function persistCodexCredentials(
  credentials: CodexCredentials,
  options?: { enableProvider?: boolean },
): Promise<void> {
  await writeCodexCredentials(credentials)
  syncCodexProviderConfig({
    enabled: options?.enableProvider ? true : undefined,
  })
  applyCodexCredentials(credentials)
}

export const applyCopilotTokenResponse = (
  response: GetCopilotTokenResponse,
): void => {
  state.copilotToken = response.token

  // The token exchange response is authoritative for routing the token it just
  // issued: `/copilot_internal/user` can disagree (e.g. enterprise seats via an
  // org entitlement advertise the business host, while the issued token is
  // bound to the enterprise host, causing 421 Misdirected Request).
  if (response.endpoints?.api) {
    state.copilotApiUrl = response.endpoints.api
  }
}

// Concurrent 401s (or a 401 racing the background refresh loop) would each
// call this independently, firing duplicate refresh requests at GitHub.
// Single-flighting means the first caller does the refresh and every
// concurrent caller just awaits that same result.
let inFlightSetup: Promise<void> | null = null

export const setupCopilotToken = async (): Promise<void> => {
  if (inFlightSetup) {
    return inFlightSetup
  }

  inFlightSetup = doSetupCopilotToken().finally(() => {
    inFlightSetup = null
  })

  return inFlightSetup
}

const doSetupCopilotToken = async () => {
  if (isOpencodeOauthApp()) {
    if (!state.githubToken) throw new Error(`opencode token not found`)

    state.copilotToken = state.githubToken

    consola.debug("GitHub Copilot token set from opencode auth token")
    if (state.showToken) {
      consola.info("Copilot token:", state.copilotToken)
    }

    stopCopilotRefreshLoop()
    return
  }

  const response = await getCopilotToken()
  applyCopilotTokenResponse(response)

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", state.copilotToken)
  }

  stopCopilotRefreshLoop()

  const controller = new AbortController()
  copilotRefreshLoopController = controller

  runCopilotRefreshLoop(response.refresh_in, controller.signal)
    .catch(() => {
      consola.warn("Copilot token refresh loop stopped")
    })
    .finally(() => {
      if (copilotRefreshLoopController === controller) {
        copilotRefreshLoopController = null
      }
    })
}

export const setupCodexToken = async (): Promise<void> => {
  const loadedCredentials = getLoadedCodexCredentials()
  if (loadedCredentials && !isCodexCredentialsExpired(loadedCredentials)) {
    if (codexRefreshLoopController) {
      return
    }

    applyCodexCredentials(loadedCredentials)
  }

  const credentials = loadedCredentials ?? (await readCodexCredentials())
  if (!credentials) {
    throw new Error(
      `Codex credentials not found. Run \`copilot-api auth login --provider codex\` first.`,
    )
  }

  syncCodexProviderConfig()

  let nextCredentials = credentials
  if (isCodexCredentialsExpired(credentials)) {
    consola.debug("Refreshing expired Codex credentials")
    nextCredentials = await refreshCodexCredentials(credentials)
    await persistCodexCredentials(nextCredentials)
  }

  applyCodexCredentials(nextCredentials)
  stopCodexRefreshLoop()

  const controller = new AbortController()
  codexRefreshLoopController = controller

  runCodexRefreshLoop(controller.signal)
    .catch(() => {
      consola.warn("Codex token refresh loop stopped")
    })
    .finally(() => {
      if (codexRefreshLoopController === controller) {
        codexRefreshLoopController = null
      }
    })
}

const REFRESH_POLL_INTERVAL_MS = 15_000
const EARLY_REFRESH_BUFFER_MS = 60_000
const RETRY_REFRESH_DELAY_MS = 15_000
const MAX_RETRY_REFRESH_DELAY_MS = 600_000
const RETRY_REFRESH_JITTER_MS = 15_000
const MIN_REFRESH_DELAY_MS = 1_000

// Formats an outage duration for the recovery summary log, e.g. "45s" or
// "12m 5s" -- unlike fetch-timeout's per-request formatRetryDuration, an
// outage here can span many minutes so seconds alone would be unreadable.
const formatDowntime = (ms: number): string => {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export const getRefreshDeadlineMs = (
  refreshIn: number,
  nowMs: number = Date.now(),
) =>
  nowMs
  + Math.max(refreshIn * 1000 - EARLY_REFRESH_BUFFER_MS, MIN_REFRESH_DELAY_MS)

// Use short wall-clock chunks so the next wake after sleep notices elapsed time
// quickly, without relying on the server's absolute expires_at matching local time.
export const getRefreshPollDelayMs = (
  refreshAtMs: number,
  nowMs: number = Date.now(),
) => Math.min(Math.max(refreshAtMs - nowMs, 0), REFRESH_POLL_INTERVAL_MS)

// A 429's Retry-After overrides our own backoff schedule -- the server told
// us exactly how long to wait, so guessing shorter would spam it and
// guessing longer would recover slower than necessary. Returns null when
// there's no Retry-After, so the caller falls back to its jittered backoff.
export const getRetryAfterDelayMs = (
  retryDelayMs: number,
  retryAfterMs: number | null,
): number | null =>
  retryAfterMs === null ? null : (
    Math.min(Math.max(retryAfterMs, retryDelayMs), MAX_RETRY_REFRESH_DELAY_MS)
  )

const runCopilotRefreshLoop = async (
  refreshIn: number,
  signal: AbortSignal,
) => {
  let refreshAtMs = getRefreshDeadlineMs(refreshIn)
  let retryDelayMs = RETRY_REFRESH_DELAY_MS
  let failedAttempts = 0
  let outageStartedAt = 0

  while (!signal.aborted) {
    const nextDelayMs = getRefreshPollDelayMs(refreshAtMs)
    if (nextDelayMs > 0) {
      await delay(nextDelayMs, undefined, { signal })
      continue
    }

    consola.debug("Refreshing Copilot token")

    try {
      const response = await getCopilotToken()
      applyCopilotTokenResponse(response)
      refreshAtMs = getRefreshDeadlineMs(response.refresh_in)
      retryDelayMs = RETRY_REFRESH_DELAY_MS
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", state.copilotToken)
      }

      if (failedAttempts > 0) {
        consola.info(
          `Copilot token refresh recovered after ${failedAttempts} failed attempt${failedAttempts === 1 ? "" : "s"}`
            + ` (${formatDowntime(Date.now() - outageStartedAt)} offline)`,
        )
        failedAttempts = 0
      }
    } catch (error) {
      failedAttempts++
      const retryAfterMs =
        error instanceof HTTPError ?
          parseRetryAfterMs(error.response.headers)
        : null
      const delayMs =
        getRetryAfterDelayMs(retryDelayMs, retryAfterMs)
        ?? Math.min(
          retryDelayMs + Math.floor(Math.random() * RETRY_REFRESH_JITTER_MS),
          MAX_RETRY_REFRESH_DELAY_MS,
        )
      refreshAtMs = Date.now() + delayMs
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_REFRESH_DELAY_MS)

      // Only the first failure of a streak is logged -- an extended outage
      // would otherwise print this same error every retry (every 15s-10min).
      // Subsequent identical failures stay quiet until the recovery summary
      // above.
      if (failedAttempts === 1) {
        outageStartedAt = Date.now()
        consola.error("Failed to refresh Copilot token:", error)
        consola.warn(
          `Retrying Copilot token refresh in ${Math.round(delayMs / 1000)}s`,
        )
      }
    }
  }
}

const runCodexRefreshLoop = async (signal: AbortSignal) => {
  let refreshAtMs = Math.max(
    (state.codexExpiresAt ?? Date.now()) - EARLY_REFRESH_BUFFER_MS,
    Date.now(),
  )

  while (!signal.aborted) {
    const expiresAt = state.codexExpiresAt
    const refreshToken = state.codexRefreshToken
    if (!expiresAt || !refreshToken) {
      return
    }

    const nextDelayMs = getRefreshPollDelayMs(refreshAtMs)
    if (nextDelayMs > 0) {
      await delay(nextDelayMs, undefined, { signal })
      continue
    }

    consola.debug("Refreshing Codex credentials")

    try {
      const credentials = await refreshCodexCredentials({
        accessToken: state.codexAccessToken ?? "",
        refreshToken,
        expiresAt,
        accountId: state.codexAccountId ?? "",
      })
      await persistCodexCredentials(credentials)
      refreshAtMs = Math.max(
        credentials.expiresAt - EARLY_REFRESH_BUFFER_MS,
        Date.now(),
      )
      consola.debug("Codex credentials refreshed")
    } catch (error) {
      consola.error("Failed to refresh Codex credentials:", error)
      refreshAtMs = Date.now() + RETRY_REFRESH_DELAY_MS
      consola.warn(
        `Retrying Codex token refresh in ${RETRY_REFRESH_DELAY_MS / 1000}s`,
      )
    }
  }
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGitHubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGitHubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

export async function logUser() {
  const copilotUser = await getCopilotUsage()
  if (!copilotUser) {
    throw new Error("GitHub token not found")
  }

  state.userName = copilotUser.login
  consola.info(`Logged in as ${copilotUser.login}`)

  state.copilotApiUrl = copilotUser.endpoints.api
  state.tokenBasedBilling = copilotUser.token_based_billing
}
