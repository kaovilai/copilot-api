import consola from "consola"

import { state } from "~/lib/state"
import { getModels as getCopilotModels } from "~/services/copilot/get-models"

// Periodically refresh models so long-running daemons pick up new SKUs.
const MODELS_REFRESH_BASE_MS = 30 * 60 * 1000
let modelsRefreshTimer: ReturnType<typeof setTimeout> | null = null
// This loop runs on a plain timer that no AbortController owns, so stopping it
// cannot cancel a response that is already on the wire. The generation lets a
// stopped loop neither write state.models nor schedule itself again.
let refreshGeneration = 0
let modelsRefreshFailedAttempts = 0
let modelsRefreshOutageStartedAt = 0

// Formats an outage duration for the recovery summary log, e.g. "45s" or
// "12m 5s".
const formatDowntime = (ms: number): string => {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

const cancelModelsRefreshTimer = () => {
  if (modelsRefreshTimer) {
    clearTimeout(modelsRefreshTimer)
    modelsRefreshTimer = null
  }
}

export const stopModelsRefreshLoop = () => {
  // Bump before cancelling so a refresh already awaiting its response sees a
  // different generation and drops both its result and its next tick.
  refreshGeneration++
  cancelModelsRefreshTimer()
}

type ModelsFetcher = typeof getCopilotModels

const refreshModels = async (fetcher: ModelsFetcher, generation: number) => {
  const prevIds = new Set(state.models?.data.map((m) => m.id) ?? [])
  const models = await fetcher()
  if (generation !== refreshGeneration) return

  state.models = {
    ...models,
    data: models.data.filter(
      (model) =>
        model.policy?.state !== "disabled"
        && (model.model_picker_enabled
          || model.capabilities.type === "embeddings"),
    ),
  }
  const nextIds = state.models.data.map((m) => m.id)
  const added = nextIds.filter((id) => !prevIds.has(id))
  if (added.length > 0) {
    consola.info(`Models refresh: ${added.length} new`)
  } else {
    consola.debug(`Models refresh: no changes (${nextIds.length} total)`)
  }
}

const scheduleModelsRefresh = (fetcher: ModelsFetcher, intervalMs: number) => {
  const generation = refreshGeneration
  const jitter = Math.floor(Math.random() * (intervalMs / 6))
  const delay = intervalMs + jitter
  consola.debug(
    `Scheduling next models refresh in ${Math.round(delay / 1000)} seconds`,
  )

  cancelModelsRefreshTimer()
  modelsRefreshTimer = setTimeout(async () => {
    try {
      await refreshModels(fetcher, generation)
      if (generation === refreshGeneration && modelsRefreshFailedAttempts > 0) {
        consola.info(
          `Models refresh recovered after ${modelsRefreshFailedAttempts} failed attempt${modelsRefreshFailedAttempts === 1 ? "" : "s"}`
            + ` (${formatDowntime(Date.now() - modelsRefreshOutageStartedAt)} offline)`,
        )
        modelsRefreshFailedAttempts = 0
      }
    } catch (error) {
      if (generation === refreshGeneration) {
        modelsRefreshFailedAttempts++
        // Only the first failure of a streak is logged -- subsequent identical
        // failures stay quiet until the recovery summary above.
        if (modelsRefreshFailedAttempts === 1) {
          modelsRefreshOutageStartedAt = Date.now()
          consola.warn(
            "Failed to refresh models, keeping previous cache.",
            error,
          )
        }
      }
    } finally {
      if (generation === refreshGeneration) {
        scheduleModelsRefresh(fetcher, intervalMs)
      }
    }
  }, delay)
}

export async function cacheModels(
  fetcher: ModelsFetcher = getCopilotModels,
  intervalMs: number = MODELS_REFRESH_BASE_MS,
): Promise<void> {
  // A fresh population supersedes whatever the previous loop was doing. This
  // is the path a config reload takes when the GitHub token changes, so a
  // request still in flight for the old account must not join this generation
  // and overwrite state.models once it comes back.
  refreshGeneration++
  const generation = refreshGeneration
  modelsRefreshFailedAttempts = 0
  modelsRefreshOutageStartedAt = 0
  await refreshModels(fetcher, generation)
  if (generation !== refreshGeneration) return

  scheduleModelsRefresh(fetcher, intervalMs)
}
