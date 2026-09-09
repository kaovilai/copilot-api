import { setTimeout as delay } from "node:timers/promises"

import consola from "consola"

import { HTTPError } from "~/lib/error"

// Pre-response-only retry: safe because nothing has been sent-and-processed
// yet from the server's perspective, unlike a body stall (already handled by
// the caller's upstream-lifecycle stream-inactivity timeout), which may mean
// generation already started.
//
// Two error buckets, per a design review that settled on gating retry by
// "did we get a response" rather than "was this a pooled/reused connection"
// (undici/Bun's fetch is a black box here, unlike the websocket pool, which
// can observe connection provenance directly):
//   - "hard" transport errors (connection refused/reset/unreachable, DNS
//     failure -- the TCP handshake itself never completed) get the full
//     retry budget.
//   - "ambiguous" errors (the caller's own headers-timeout fired) might mean a
//     true blackhole, or might mean the server is just slow but already has
//     the request -- capped by their own shorter time budget (rather than the
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

// Generic pre-response-only retry loop, factored out so it can drive any
// caller that needs this retry semantics around a "get a Response" primitive
// (e.g. fetchUpstreamWithLifecycle in ~/services/upstream-http).
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
