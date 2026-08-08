import { afterEach, expect, test } from "bun:test"

import { HTTPError } from "../src/lib/error"
import {
  fetchWithConnectRetry,
  fetchWithConnectTimeout,
} from "../src/lib/fetch-timeout"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("fetchWithConnectTimeout resolves normally when headers arrive quickly", async () => {
  const response = new Response("ok")
  globalThis.fetch = (() =>
    Promise.resolve(response)) as unknown as typeof fetch

  const result = await fetchWithConnectTimeout(
    "https://example.com",
    {},
    { connectTimeoutMs: 50 },
  )

  expect(result.status).toBe(response.status)
  expect(await result.text()).toBe("ok")
})

test("fetchWithConnectTimeout aborts when the connection never resolves in time", async () => {
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const reason: unknown = init.signal?.reason
        reject(reason instanceof Error ? reason : new Error("aborted"))
      })
    })) as unknown as typeof fetch

  let thrown: unknown
  try {
    await fetchWithConnectTimeout(
      "https://example.com",
      {},
      { connectTimeoutMs: 10 },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe("Connection timed out after 10ms")
})

test("fetchWithConnectTimeout clears its timer once headers arrive, leaving the stream unarmed", async () => {
  let capturedSignal: AbortSignal | undefined
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    capturedSignal = init?.signal ?? undefined
    return Promise.resolve(new Response("ok"))
  }) as unknown as typeof fetch

  await fetchWithConnectTimeout(
    "https://example.com",
    {},
    { connectTimeoutMs: 10 },
  )

  // Give the timer that would have fired well past its original deadline a
  // chance to run -- it must not, since a live stream body must never be
  // aborted just because the connect window elapsed.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 30)
  })

  expect(capturedSignal?.aborted).toBe(false)
})

test("fetchWithConnectTimeout still honors a caller-provided signal", async () => {
  const callerController = new AbortController()
  let capturedSignal: AbortSignal | undefined
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    capturedSignal = init?.signal ?? undefined
    return Promise.resolve(new Response("ok"))
  }) as unknown as typeof fetch

  await fetchWithConnectTimeout(
    "https://example.com",
    { signal: callerController.signal },
    { connectTimeoutMs: 1000 },
  )

  expect(capturedSignal?.aborted).toBe(false)
  callerController.abort(new Error("caller cancelled"))
  expect(capturedSignal?.aborted).toBe(true)
})

const hardTransportError = (): Error => {
  const error = new Error(
    "Unable to connect. Is the computer able to access the url?",
  )
  ;(error as Error & { code?: string }).code = "ConnectionRefused"
  return error
}

test("fetchWithConnectRetry retries a hard transport error until it succeeds", async () => {
  let calls = 0
  const response = new Response("ok")
  globalThis.fetch = (() => {
    calls++
    return calls < 3 ?
        Promise.reject(hardTransportError())
      : Promise.resolve(response)
  }) as unknown as typeof fetch

  const result = await fetchWithConnectRetry(
    "https://example.com",
    {},
    { firstRetryDelayMs: 1, steadyRetryDelayMs: 1 },
  )

  expect(result.status).toBe(response.status)
  expect(await result.text()).toBe("ok")
  expect(calls).toBe(3)
})

test("fetchWithConnectRetry gives up once the retry budget elapses and throws an HTTPError", async () => {
  let calls = 0
  globalThis.fetch = (() => {
    calls++
    return Promise.reject(hardTransportError())
  }) as unknown as typeof fetch

  let thrown: unknown
  try {
    await fetchWithConnectRetry(
      "https://example.com",
      {},
      { firstRetryDelayMs: 1, steadyRetryDelayMs: 1, retryBudgetMs: 5 },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(HTTPError)
  expect((thrown as HTTPError).response.status).toBe(502)
  expect(calls).toBeGreaterThan(1)
})

test("fetchWithConnectRetry caps retries when only ambiguous connect-timeouts occur", async () => {
  let calls = 0
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    calls++
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const reason: unknown = init.signal?.reason
        reject(reason instanceof Error ? reason : new Error("aborted"))
      })
    })
  }) as unknown as typeof fetch

  let thrown: unknown
  try {
    await fetchWithConnectRetry(
      "https://example.com",
      {},
      {
        perAttemptConnectTimeoutMs: 5,
        ambiguousTimeoutMaxAttempts: 1,
        firstRetryDelayMs: 1,
        steadyRetryDelayMs: 1,
      },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(HTTPError)
  expect((thrown as HTTPError).response.status).toBe(502)
  // initial attempt + 1 retry, capped by ambiguousTimeoutMaxAttempts: 1
  expect(calls).toBe(2)
})

test("fetchWithConnectRetry stops immediately once the downstream signal aborts", async () => {
  let calls = 0
  const downstreamController = new AbortController()
  globalThis.fetch = (() => {
    calls++
    // Simulate the caller (e.g. Claude Code) disconnecting right after the
    // first attempt fails, before any retry would otherwise happen.
    downstreamController.abort(new Error("client disconnected"))
    return Promise.reject(hardTransportError())
  }) as unknown as typeof fetch

  let thrown: unknown
  try {
    await fetchWithConnectRetry(
      "https://example.com",
      { signal: downstreamController.signal },
      { firstRetryDelayMs: 5, steadyRetryDelayMs: 5 },
    )
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect(calls).toBe(1)
})

test("fetchWithConnectRetry does not retry once any response has been received", async () => {
  let calls = 0
  const errorResponse = new Response("bad", { status: 500 })
  globalThis.fetch = (() => {
    calls++
    return Promise.resolve(errorResponse)
  }) as unknown as typeof fetch

  const result = await fetchWithConnectRetry("https://example.com", {})

  expect(result.status).toBe(500)
  expect(calls).toBe(1)
})

test("fetchWithConnectRetry recognizes a Node/undici-style nested cause code as a hard transport error", async () => {
  let calls = 0
  const response = new Response("ok")
  globalThis.fetch = (() => {
    calls++
    if (calls < 2) {
      const undiciStyleError = new Error("fetch failed")
      ;(undiciStyleError as Error & { cause?: unknown }).cause = {
        code: "ECONNRESET",
      }
      return Promise.reject(undiciStyleError)
    }
    return Promise.resolve(response)
  }) as unknown as typeof fetch

  const result = await fetchWithConnectRetry(
    "https://example.com",
    {},
    { firstRetryDelayMs: 1, steadyRetryDelayMs: 1 },
  )

  expect(result.status).toBe(response.status)
  expect(calls).toBe(2)
})

test("fetchWithConnectRetry does not retry an unrecognized error", async () => {
  let calls = 0
  globalThis.fetch = (() => {
    calls++
    return Promise.reject(new Error("something unrelated broke"))
  }) as unknown as typeof fetch

  let thrown: unknown
  try {
    await fetchWithConnectRetry("https://example.com", {})
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect(thrown).not.toBeInstanceOf(HTTPError)
  expect(calls).toBe(1)
})
