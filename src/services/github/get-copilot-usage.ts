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
// live health with no auth. When a retry fires we best-effort check it so the
// log tells the operator whether this is a known GitHub outage or something
// local. It has its own short timeout and never throws -- a status lookup must
// not interfere with the retry loop it annotates.
const GITHUB_STATUS_COMPONENTS_URL =
  "https://www.githubstatus.com/api/v2/components.json"
const GITHUB_STATUS_TIMEOUT_MS = 5_000

interface StatusComponent {
  name: string
  status: string
}

const getCopilotOutageNote = async (): Promise<string> => {
  try {
    const response = await fetch(GITHUB_STATUS_COMPONENTS_URL, {
      signal: AbortSignal.timeout(GITHUB_STATUS_TIMEOUT_MS),
    })
    if (!response.ok) return ""

    const { components } = (await response.json()) as {
      components?: Array<StatusComponent>
    }
    const copilot = components?.find((c) => c.name === "Copilot")
    if (!copilot || copilot.status === "operational") return ""

    // e.g. "major_outage" -> "major outage"
    const readable = copilot.status.replace(/_/g, " ")
    return ` (githubstatus.com reports Copilot: ${readable})`
  } catch {
    // Status page unreachable/slow -- annotate nothing, keep retrying.
    return ""
  }
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
      const delayMs = getUsageRetryDelayMs(attempt, null)
      const outageNote = await getCopilotOutageNote()
      consola.warn(
        `Failed to reach Copilot usage endpoint, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}${outageNote}`,
      )
      await sleep(delayMs)
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

    const delayMs = getUsageRetryDelayMs(
      attempt,
      parseRetryAfterMs(response.headers),
    )
    const outageNote = await getCopilotOutageNote()
    consola.warn(
      `Failed to get Copilot usage (status ${response.status}), retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}): ${errorText}${outageNote}`,
    )
    await sleep(delayMs)
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
