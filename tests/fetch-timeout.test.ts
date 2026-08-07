import { afterEach, expect, test } from "bun:test"

import { fetchWithConnectTimeout } from "../src/lib/fetch-timeout"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("fetchWithConnectTimeout resolves normally when headers arrive quickly", async () => {
  const response = new Response("ok")
  globalThis.fetch = (() =>
    Promise.resolve(response)) as unknown as typeof fetch

  const result = await fetchWithConnectTimeout("https://example.com", {}, 50)

  expect(result).toBe(response)
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
    await fetchWithConnectTimeout("https://example.com", {}, 10)
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

  await fetchWithConnectTimeout("https://example.com", {}, 10)

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
    1000,
  )

  expect(capturedSignal?.aborted).toBe(false)
  callerController.abort(new Error("caller cancelled"))
  expect(capturedSignal?.aborted).toBe(true)
})
