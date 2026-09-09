import consola from "consola"

import { UpstreamHeadersTimeoutError } from "~/lib/error"
import { retryPreResponseFailures } from "~/lib/fetch-timeout"
import { state } from "~/lib/state"
import { setupCopilotToken } from "~/lib/token"
import {
  fetchUpstreamWithLifecycle,
  type UpstreamHttpLifecycleOptions,
} from "~/services/upstream-http"

// A 401 here means the Copilot-internal token was rejected mid-flight (e.g. it
// expired during a long connect-retry stall). Neither the connect-retry loop
// nor the upstream-lifecycle timeout retries auth responses, so this handles
// that case generically: redo the same token fetch setupCopilotToken() runs
// at startup, update the request's Authorization header, then retry the
// attempt once. `attempt` is re-invoked as-is, so callers whose attempt reads
// `state.copilotToken` (or a header object mutated by `onReauth`) will pick up
// the refreshed value automatically.
export async function withCopilotReauth(
  attempt: () => Promise<Response>,
  onReauth: () => void,
): Promise<Response> {
  let response = await attempt()

  if (response.status === 401) {
    consola.warn(
      "Copilot request unauthorized (401); refreshing Copilot token and retrying once",
    )
    try {
      await setupCopilotToken()
      onReauth()
      response = await attempt()
    } catch (error) {
      consola.error("Failed to refresh Copilot token after 401:", error)
    }
  }

  return response
}

export async function fetchCopilotWithReauth(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
  lifecycleOptions: UpstreamHttpLifecycleOptions,
): Promise<Response> {
  return withCopilotReauth(
    () =>
      retryPreResponseFailures(
        () => fetchUpstreamWithLifecycle(url, init, lifecycleOptions),
        lifecycleOptions.clientSignal,
        (error) => error instanceof UpstreamHeadersTimeoutError,
      ),
    () => {
      init.headers.Authorization = `Bearer ${state.copilotToken}`
    },
  )
}
