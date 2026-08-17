import consola from "consola"
import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { HTTPError, parseRetryAfterMs } from "~/lib/error"
import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"

export type CopilotAccountType = "individual" | "business" | "enterprise"

// GitHub's copilot_internal/user endpoint intermittently returns transient
// server errors ("No server is currently available to service your request").
// Retry those forever with capped exponential backoff so startup waits out an
// outage instead of crashing, and ring the terminal bell once it recovers so
// an unattended operator knows it's back. Auth/client errors (4xx except 429)
// are not retriable and throw immediately.
const USAGE_RETRY_BASE_DELAY_MS = 1_000
const USAGE_MAX_RETRY_DELAY_MS = 30_000

const isRetriableStatus = (status: number): boolean =>
  status === 429 || status >= 500

// GitHub's public Statuspage (githubstatus.com) exposes the Copilot component's
// live health with no auth and is served from a CDN built to be polled. When a
// GitHub API call fails and the status page reports a known Copilot outage, we
// stop hitting GitHub entirely and poll only this cheap endpoint until it turns
// green -- then retry GitHub immediately. That waits out the outage without
// spamming GitHub's servers, yet resumes the instant service is restored.
const GITHUB_STATUS_COMPONENTS_URL =
  "https://www.githubstatus.com/api/v2/components.json"
const GITHUB_STATUS_TIMEOUT_MS = 5_000
// Cadence for polling the status page while waiting out a known outage.
const STATUS_POLL_INTERVAL_MS = 15_000

type CopilotHealth = "operational" | "outage" | "unknown"

interface StatusComponent {
  name: string
  status: string
}

interface CopilotHealthResult {
  health: CopilotHealth
  // Human-readable component status when in outage, e.g. "major outage".
  label: string
}

// Best-effort read of the Copilot component's live health. Own short timeout,
// never throws: any failure is reported as "unknown" so callers fall back to
// retrying GitHub directly rather than trusting a status page we couldn't reach.
const getCopilotHealth = async (): Promise<CopilotHealthResult> => {
  try {
    const response = await fetch(GITHUB_STATUS_COMPONENTS_URL, {
      signal: AbortSignal.timeout(GITHUB_STATUS_TIMEOUT_MS),
    })
    if (!response.ok) return { health: "unknown", label: "" }

    const { components } = (await response.json()) as {
      components?: Array<StatusComponent>
    }
    const copilot = components?.find((c) => c.name === "Copilot")
    if (!copilot) return { health: "unknown", label: "" }
    if (copilot.status === "operational") {
      return { health: "operational", label: "" }
    }
    // e.g. "major_outage" -> "major outage"
    return { health: "outage", label: copilot.status.replace(/_/g, " ") }
  } catch {
    return { health: "unknown", label: "" }
  }
}

// Poll only the status page until Copilot is operational again, so we ride out a
// known outage without touching GitHub. Returns true once green; returns false
// if health becomes undeterminable, so the caller can fall back to GitHub
// backoff instead of polling a status page it can no longer read.
const waitForCopilotOperational = async (): Promise<boolean> => {
  for (;;) {
    await sleep(STATUS_POLL_INTERVAL_MS)
    const { health } = await getCopilotHealth()
    if (health === "operational") return true
    if (health === "unknown") return false
    // still in outage -- keep polling the cheap status page, not GitHub.
  }
}

// Decide how long to wait before the next GitHub attempt. During a known Copilot
// outage this polls the status page (not GitHub) and returns the moment it
// recovers; otherwise it sleeps the normal capped exponential backoff.
const waitBeforeRetry = async (
  attempt: number,
  retryAfterMs: number | null,
): Promise<void> => {
  const { health, label } = await getCopilotHealth()

  if (health === "outage") {
    consola.warn(
      `githubstatus.com reports Copilot: ${label}; polling the status page instead of GitHub until it recovers`,
    )
    const recovered = await waitForCopilotOperational()
    if (recovered) {
      consola.info(
        "githubstatus.com reports Copilot operational again; retrying GitHub now",
      )
      return
    }
    consola.warn(
      "Could not confirm Copilot status; falling back to GitHub backoff",
    )
  }

  const delayMs = getUsageRetryDelayMs(attempt, retryAfterMs)
  consola.warn(
    `Retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt})`,
  )
  await sleep(delayMs)
}

// Emit the ASCII BEL so the macOS Terminal rings/bounces when service recovers.
const ringBell = (): void => {
  process.stdout.write("")
}

export const getCopilotUsage = async (
  githubToken?: string,
): Promise<CopilotUsageResponse | null> => {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    return null
  }

  const authState = { ...state, githubToken: resolvedGithubToken }

  let attempt = 0
  for (;;) {
    attempt++
    let response: Response
    try {
      response = await fetch(`${getGitHubApiBaseUrl()}/copilot_internal/user`, {
        headers: githubHeaders(authState),
      })
    } catch (error) {
      // Network-level failure (connect/DNS/reset) -- retriable, retry forever.
      consola.warn(
        `Failed to reach Copilot usage endpoint (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`,
      )
      await waitBeforeRetry(attempt, null)
      continue
    }

    if (response.ok) {
      if (attempt > 1) {
        ringBell()
        consola.success(
          `Copilot usage endpoint recovered after ${attempt} attempts`,
        )
      }
      return (await response.json()) as CopilotUsageResponse
    }

    const errorText = await response.clone().text()

    if (!isRetriableStatus(response.status)) {
      consola.error("Failed to get Copilot user response body", errorText)
      throw new HTTPError("Failed to get Copilot usage", response)
    }

    consola.warn(
      `Failed to get Copilot usage (status ${response.status}, attempt ${attempt}): ${errorText}`,
    )
    await waitBeforeRetry(attempt, parseRetryAfterMs(response.headers))
  }
}

// Exponential backoff with jitter, capped, overridden by a server Retry-After.
const getUsageRetryDelayMs = (
  attempt: number,
  retryAfterMs: number | null,
): number => {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, USAGE_MAX_RETRY_DELAY_MS)
  }
  const base = Math.min(
    USAGE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    USAGE_MAX_RETRY_DELAY_MS,
  )
  return base + Math.floor(Math.random() * USAGE_RETRY_BASE_DELAY_MS)
}

export const getCopilotAccountType = async (
  githubToken?: string,
): Promise<CopilotAccountType> => {
  const usage = await getCopilotUsage(githubToken)
  if (!usage) {
    throw new Error("GitHub token not found")
  }

  const plan = (usage.copilot_plan ?? "").toLowerCase()

  if (plan.includes("enterprise")) return "enterprise"
  if (plan.includes("business")) return "business"
  return "individual"
}

export interface QuotaDetail {
  entitlement: number
  overage_count: number
  overage_permitted: boolean
  percent_remaining: number
  quota_id: string
  quota_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

interface CopilotUsageResponse {
  login: string
  access_type_sku: string
  analytics_tracking_id: string
  assigned_date: string
  can_signup_for_limited: boolean
  chat_enabled: boolean
  copilot_plan?: string
  organization_login_list: Array<unknown>
  organization_list: Array<unknown>
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
  endpoints: {
    api: string
    telemetry: string
  }
  token_based_billing?: boolean
}
