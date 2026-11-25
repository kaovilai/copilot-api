export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export class UpstreamHeadersTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Upstream did not return headers within ${timeoutMs}ms`)
    this.name = "UpstreamHeadersTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export class UpstreamStreamInactivityTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Upstream stream was inactive for ${timeoutMs}ms`)
    this.name = "UpstreamStreamInactivityTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

// Parses Retry-After per RFC 9110: either delta-seconds or an HTTP-date.
// Callers use this to pace their own retry loops against a 429/503 instead of
// a fixed backoff that may retry sooner (spamming) or later (needlessly slow)
// than what the server actually asked for.
export function parseRetryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after")
  if (!value) {
    return null
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds) && value.trim() !== "") {
    return Math.max(0, seconds * 1000)
  }

  const dateMs = Date.parse(value)
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now())
  }

  return null
}
