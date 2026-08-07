// Bounds only the time to establish a connection and receive response headers.
// The abort timer is cleared as soon as fetch() resolves, so a signal is never
// left armed against an in-progress (possibly long-lived, streaming) response
// body -- unlike `signal: AbortSignal.timeout(ms)`, which stays bound to body
// reads too and would kill a legitimate long stream once the deadline passes.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export const fetchWithConnectTimeout = async (
  input: string | URL,
  init: RequestInit = {},
  connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Connection timed out after ${connectTimeoutMs}ms`),
    )
  }, connectTimeoutMs)

  const signal =
    init.signal ?
      AbortSignal.any([init.signal, controller.signal])
    : controller.signal

  try {
    return await fetch(input, { ...init, signal })
  } finally {
    clearTimeout(timer)
  }
}
