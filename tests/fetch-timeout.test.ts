import { afterEach, expect, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import { retryPreResponseFailures } from "../src/lib/fetch-timeout"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

class TestAmbiguousTimeoutError extends Error {}

const isAmbiguousTimeout = (error: unknown): boolean =>
  error instanceof TestAmbiguousTimeoutError

const hardTransportError = (): Error => {
  const error = new Error(
    "Unable to connect. Is the computer able to access the url?",
  )
  ;(error as Error & { code?: string }).code = "ConnectionRefused"
  return error
}

test("retryPreResponseFailures retries a hard transport error until it succeeds", async () => {
  let calls = 0
  const response = new Response("ok")
  globalThis.fetch = (() => {
    calls++
    return calls < 3 ?
        Promise.reject(hardTransportError())
      : Promise.resolve(response)
  }) as unknown as typeof fetch

  const result = await retryPreResponseFailures(
    () => fetch("https://example.com"),
    undefined,
    isAmbiguousTimeout,
    { firstRetryDelayMs: 1, steadyRetryDelayMs: 1 },
  )

  expect(result.status).toBe(response.status)
  expect(await result.text()).toBe("ok")
  expect(calls).toBe(3)
})

test("retryPreResponseFailures gives up once the retry budget elapses and throws an HTTPError", async () => {
  let calls = 0
  globalThis.fetch = (() => {
    calls++
    return Promise.reject(hardTransportError())
  }) as unknown as typeof fetch

  let thrown: unknown
  try {
    await retryPreResponseFailures(
      () => fetch("https://example.com"),
      undefined,
      isAmbiguousTimeout,
      { firstRetryDelayMs: 1, steadyRetryDelayMs: 1, retryBudgetMs: 5 },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(HTTPError)
  expect((thrown as HTTPError).response.status).toBe(502)
  expect(calls).toBeGreaterThan(1)
})

test("retryPreResponseFailures caps retries when only ambiguous timeouts occur", async () => {
  let calls = 0

  let thrown: unknown
  try {
    await retryPreResponseFailures(
      () => {
        calls++
        return Promise.reject(new TestAmbiguousTimeoutError("timed out"))
      },
      undefined,
      isAmbiguousTimeout,
      {
        ambiguousTimeoutBudgetMs: 12,
        firstRetryDelayMs: 1,
        steadyRetryDelayMs: 1,
      },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(HTTPError)
  expect((thrown as HTTPError).response.status).toBe(502)
  // capped by ambiguousTimeoutBudgetMs: 12 -- each attempt is near-instant
  // here, so several retries fit before the 12ms ambiguous budget is
  // exceeded, but the loop still terminates well short of retryBudgetMs.
  expect(calls).toBeGreaterThan(1)
})

test("retryPreResponseFailures stops immediately once the downstream signal aborts", async () => {
  let calls = 0
  const downstreamController = new AbortController()
  const attempt = () => {
    calls++
    // Simulate the caller (e.g. Claude Code) disconnecting right after the
    // first attempt fails, before any retry would otherwise happen.
    downstreamController.abort(new Error("client disconnected"))
    return Promise.reject(hardTransportError())
  }

  let thrown: unknown
  try {
    await retryPreResponseFailures(
      attempt,
      downstreamController.signal,
      isAmbiguousTimeout,
      { firstRetryDelayMs: 5, steadyRetryDelayMs: 5 },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect(calls).toBe(1)
})

test("retryPreResponseFailures does not retry once any response has been received", async () => {
  let calls = 0
  const errorResponse = new Response("bad", { status: 500 })
  const attempt = () => {
    calls++
    return Promise.resolve(errorResponse)
  }

  const result = await retryPreResponseFailures(
    attempt,
    undefined,
    isAmbiguousTimeout,
  )

  expect(result.status).toBe(500)
  expect(calls).toBe(1)
})

test("retryPreResponseFailures recognizes a Node/undici-style nested cause code as a hard transport error", async () => {
  let calls = 0
  const response = new Response("ok")
  const attempt = () => {
    calls++
    if (calls < 2) {
      const undiciStyleError = new Error("fetch failed")
      ;(undiciStyleError as Error & { cause?: unknown }).cause = {
        code: "ECONNRESET",
      }
      return Promise.reject(undiciStyleError)
    }
    return Promise.resolve(response)
  }

  const result = await retryPreResponseFailures(
    attempt,
    undefined,
    isAmbiguousTimeout,
    { firstRetryDelayMs: 1, steadyRetryDelayMs: 1 },
  )

  expect(result.status).toBe(response.status)
  expect(calls).toBe(2)
})

test("retryPreResponseFailures does not retry an unrecognized error", async () => {
  let calls = 0
  const attempt = () => {
    calls++
    return Promise.reject(new Error("something unrelated broke"))
  }

  let thrown: unknown
  try {
    await retryPreResponseFailures(attempt, undefined, isAmbiguousTimeout)
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect(thrown).not.toBeInstanceOf(HTTPError)
  expect(calls).toBe(1)
})
