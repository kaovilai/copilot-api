import { setTimeout as delay } from "node:timers/promises"

import consola from "consola"

import { HTTPError } from "~/lib/error"

// Bounds only the time to establish a connection and receive response headers.
// The abort timer is cleared as soon as fetch() resolves, so a signal is never
// left armed against an in-progress (possibly long-lived, streaming) response
// body -- unlike `signal: AbortSignal.timeout(ms)`, which stays bound to body
// reads too and would kill a legitimate long stream once the deadline passes.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

// Tags an abort caused by fetchWithConnectTimeout's own deadline, distinct from
// any other Error a caller's combined signal might produce -- lets
// fetchWithConnectRetry tell "our timeout fired, ambiguous" apart from
// "downstream disconnected" or "hard transport failure" without string-sniffing.
export class ConnectTimeoutError extends Error {}

// A silently-dead connection that dies AFTER headers arrive (mid-stream, e.g.
// during an SSE generation) needs its own detection, separate from the connect
// timeout above. Same two-tier reasoning as the websocket pool's stall timeout
// (src/services/responses-websocket.ts): tight before any data has arrived,
// generous afterward since models can pause a long time inside thinking blocks.
const DEFAULT_BODY_FIRST_CHUNK_TIMEOUT_MS = 20_000
const DEFAULT_BODY_INTER_CHUNK_TIMEOUT_MS = 180_000

export interface FetchWithConnectTimeoutOptions {
  connectTimeoutMs?: number
  firstChunkTimeoutMs?: number
  interChunkTimeoutMs?: number
}

export const fetchWithConnectTimeout = async (
  input: string | URL,
  init: RequestInit = {},
  timeouts: FetchWithConnectTimeoutOptions = {},
): Promise<Response> => {
  const connectTimeoutMs =
    timeouts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      new ConnectTimeoutError(
        `Connection timed out after ${connectTimeoutMs}ms`,
      ),
    )
  }, connectTimeoutMs)

  const signal =
    init.signal ?
      AbortSignal.any([init.signal, controller.signal])
    : controller.signal

  let response: Response
  try {
    response = await fetch(input, { ...init, signal })
  } finally {
    clearTimeout(timer)
  }

  return withBodyStallTimeout(response, {
    firstChunkTimeoutMs:
      timeouts.firstChunkTimeoutMs ?? DEFAULT_BODY_FIRST_CHUNK_TIMEOUT_MS,
    interChunkTimeoutMs:
      timeouts.interChunkTimeoutMs ?? DEFAULT_BODY_INTER_CHUNK_TIMEOUT_MS,
  })
}

// Detection only, no retry: unlike the websocket pool, a plain HTTP request has
// no "resurrected from a shared pool" case to distinguish, and blindly retrying
// a POST that may have already started generating server-side risks double
// billing. Erroring the stream lets the caller's existing error handling take
// over, the same as any other upstream failure.
const withBodyStallTimeout = (
  response: Response,
  options: { firstChunkTimeoutMs: number; interChunkTimeoutMs: number },
): Response => {
  if (!response.body) {
    return response
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let receivedChunk = false

  const clearStallTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const armStallTimer = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    const timeoutMs =
      receivedChunk ? options.interChunkTimeoutMs : options.firstChunkTimeoutMs
    timer = setTimeout(() => {
      controller.error(
        new Error(`Response body stalled: no data received for ${timeoutMs}ms`),
      )
    }, timeoutMs)
    if (
      typeof timer === "object"
      && "unref" in timer
      && typeof timer.unref === "function"
    ) {
      timer.unref()
    }
  }

  // Bun's own Transformer type omits `cancel` (unlike lib.dom.d.ts), even
  // though Bun's runtime does invoke it per the WHATWG streams spec -- widen
  // the type here rather than dropping the handler, since it's what clears
  // the stall timer when a downstream consumer cancels the stream early.
  const transformer: Transformer<Uint8Array, Uint8Array> & {
    cancel?: () => void
  } = {
    flush: clearStallTimer,
    cancel: clearStallTimer,
    start: armStallTimer,
    transform: (chunk, controller) => {
      clearStallTimer()
      receivedChunk = true
      controller.enqueue(chunk)
      armStallTimer(controller)
    },
  }

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>(transformer),
  )

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

// Pre-response-only retry: safe because nothing has been sent-and-processed
// yet from the server's perspective, unlike a body stall (see
// withBodyStallTimeout above), which may mean generation already started.
//
// Two error buckets, per a design review that settled on gating retry by
// "did we get a response" rather than "was this a pooled/reused connection"
// (undici/Bun's fetch is a black box here, unlike the websocket pool, which
// can observe connection provenance directly):
//   - "hard" transport errors (connection refused/reset/unreachable, DNS
//     failure -- the TCP handshake itself never completed) get the full
//     retry budget.
//   - "ambiguous" errors (our own connect timeout fired) might mean a true
//     blackhole, or might mean the server is just slow but already has the
//     request -- capped by their own shorter time budget (rather than the
//     full retry budget) so a slow-not-dead upstream isn't hammered with
//     duplicate POSTs indefinitely. The budget is time-based, not a raw
//     attempt count, so it scales with wifi/network-handoff outages (which
//     commonly run 10-60s+ for DHCP renewal or AP roam) instead of expiring
//     after a fixed number of round-trips regardless of how long each one
//     actually took.
// The numeric budgets below are a safety net, not the real gate: the real
// gate is the caller's own signal (e.g. the downstream client's disconnect)
// -- checked between attempts and during the backoff wait, so retrying stops
// immediately once nobody is left to answer, independent of the budget.
const DEFAULT_PER_ATTEMPT_CONNECT_TIMEOUT_MS = 8_000
const DEFAULT_AMBIGUOUS_TIMEOUT_BUDGET_MS = 90_000
const DEFAULT_RETRY_BUDGET_MS = 30 * 60_000
const DEFAULT_FIRST_RETRY_DELAY_MS = 250
const DEFAULT_STEADY_RETRY_DELAY_MS = 2_000

// Bun's own fetch error codes for pre-connect failures (from Bun's binary --
// no public enum reference), plus Node/undici-style codes in case a caller
// ever runs this under a non-Bun fetch. Bun does not reliably distinguish
// DNS failure from connection-refused at this level (both observed to throw
// the same code in testing), so both are treated as one "never connected"
// bucket.
const HARD_TRANSPORT_ERROR_CODES = new Set([
  "ConnectionClosed",
  "ConnectionFailed",
  "ConnectionRefused",
  "ConnectionResetByPeer",
  "ConnectionTimedOut",
  "ConnectionTimeout",
  "DNSResolutionFailed",
  "DNSException",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
])

// Bun's generic message for any pre-connect failure, observed identically for
// both connection-refused and DNS-failure -- a more stable signal than
// `.code` alone, which Bun does not document as a stable enum.
const BUN_UNABLE_TO_CONNECT_MESSAGE =
  "Unable to connect. Is the computer able to access the url?"

const isHardTransportError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }

  if (error.message === BUN_UNABLE_TO_CONNECT_MESSAGE) {
    return true
  }

  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === "string" && HARD_TRANSPORT_ERROR_CODES.has(code)) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }

  return false
}

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value))

// Generic pre-response-only retry loop, factored out so it can drive both
// fetchWithConnectRetry below (attempt = fetchWithConnectTimeout) and callers
// that need the same retry semantics around a different "get a Response"
// primitive (e.g. fetchResponsesWithLifecycle in ~/services/responses-http,
// which has its own headers-timeout error type instead of ConnectTimeoutError).
// `isAmbiguousTimeout` lets each caller say which error class represents
// "our own per-attempt deadline fired" for their specific attempt() shape.
export interface RetryPreResponseFailuresOptions {
  ambiguousTimeoutBudgetMs?: number
  firstRetryDelayMs?: number
  retryBudgetMs?: number
  steadyRetryDelayMs?: number
}

// Tracked globally (not per-request) so a fresh request that starts mid-outage
// can report how long the upstream has actually been unreachable, not just
// its own retry duration -- this is the "was the wifi actually down, and for
// how long" signal, not shown by any single request's own timing.
let lastSuccessfulConnectionAt: number | null = null

const formatRetryDuration = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`

export const retryPreResponseFailures = async (
  attempt: () => Promise<Response>,
  downstreamSignal: AbortSignal | undefined,
  isAmbiguousTimeout: (error: unknown) => boolean,
  options: RetryPreResponseFailuresOptions = {},
): Promise<Response> => {
  const ambiguousTimeoutBudgetMs =
    options.ambiguousTimeoutBudgetMs ?? DEFAULT_AMBIGUOUS_TIMEOUT_BUDGET_MS
  const retryBudgetMs = options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS
  const firstRetryDelayMs =
    options.firstRetryDelayMs ?? DEFAULT_FIRST_RETRY_DELAY_MS
  const steadyRetryDelayMs =
    options.steadyRetryDelayMs ?? DEFAULT_STEADY_RETRY_DELAY_MS

  const requestStartedAt = Date.now()
  // Snapshot before this request can overwrite it with its own success below.
  const previousSuccessAt = lastSuccessfulConnectionAt
  const sinceLastSuccessText = (): string =>
    previousSuccessAt === null ? "" : (
      `, ${formatRetryDuration(Date.now() - previousSuccessAt)} since last successful connection`
    )

  const deadline = requestStartedAt + retryBudgetMs
  const ambiguousDeadline = requestStartedAt + ambiguousTimeoutBudgetMs
  let attemptNumber = 0

  for (;;) {
    attemptNumber++

    if (downstreamSignal?.aborted) {
      throw toError(downstreamSignal.reason)
    }

    try {
      const response = await attempt()

      lastSuccessfulConnectionAt = Date.now()
      if (attemptNumber > 1) {
        const retries = attemptNumber - 1
        consola.log(
          `--> upstream reconnected after ${retries} ${retries === 1 ? "retry" : "retries"}`
            + ` (${formatRetryDuration(Date.now() - requestStartedAt)} retrying)${sinceLastSuccessText()}`,
        )
      }

      return response
    } catch (error) {
      if (downstreamSignal?.aborted) {
        throw toError(error)
      }

      const isAmbiguous = isAmbiguousTimeout(error)
      const isHard = !isAmbiguous && isHardTransportError(error)

      if (!isAmbiguous && !isHard) {
        throw toError(error)
      }

      const exhausted =
        (isAmbiguous && Date.now() >= ambiguousDeadline)
        || Date.now() >= deadline

      if (exhausted) {
        consola.error(
          `--> upstream unreachable after ${attemptNumber} attempt(s)`
            + ` (${formatRetryDuration(Date.now() - requestStartedAt)} retrying)${sinceLastSuccessText()}:`,
          toError(error).message,
        )
        throw new HTTPError(
          `Upstream unreachable after ${attemptNumber} attempt(s): ${toError(error).message}`,
          new Response(
            `Upstream unreachable after ${attemptNumber} retries -- last error: ${toError(error).message}`,
            { status: 502 },
          ),
        )
      }

      const waitMs =
        attemptNumber === 1 ? firstRetryDelayMs : steadyRetryDelayMs
      try {
        await delay(waitMs, undefined, { signal: downstreamSignal })
      } catch {
        throw toError(error)
      }
    }
  }
}

export interface FetchWithConnectRetryOptions
  extends FetchWithConnectTimeoutOptions,
    RetryPreResponseFailuresOptions {
  perAttemptConnectTimeoutMs?: number
}

export const fetchWithConnectRetry = async (
  input: string | URL,
  init: RequestInit = {},
  options: FetchWithConnectRetryOptions = {},
): Promise<Response> => {
  const downstreamSignal = init.signal ?? undefined
  const perAttemptConnectTimeoutMs =
    options.perAttemptConnectTimeoutMs ?? DEFAULT_PER_ATTEMPT_CONNECT_TIMEOUT_MS

  return retryPreResponseFailures(
    () =>
      fetchWithConnectTimeout(input, init, {
        connectTimeoutMs: perAttemptConnectTimeoutMs,
        firstChunkTimeoutMs: options.firstChunkTimeoutMs,
        interChunkTimeoutMs: options.interChunkTimeoutMs,
      }),
    downstreamSignal,
    (error) => error instanceof ConnectTimeoutError,
    options,
  )
}
