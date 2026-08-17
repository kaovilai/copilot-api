import { afterEach, beforeEach, expect, mock, test } from "bun:test"

// Keep backoff instant so retry tests don't sleep real seconds.
await mock.module("~/lib/utils", () => ({
  sleep: () => Promise.resolve(),
}))

const { state } = await import("../src/lib/state")
const { getCopilotUsage } = await import(
  "../src/services/github/get-copilot-usage"
)
const { HTTPError } = await import("../src/lib/error")

const captureError = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error("expected function to throw")
}

const originalFetch = globalThis.fetch
const originalGithubToken = state.githubToken

const usageBody = {
  login: "octocat",
  endpoints: { api: "https://api.example.test", telemetry: "" },
} as unknown as Awaited<ReturnType<typeof getCopilotUsage>>

const makeResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    clone: () => makeResponse(status, body, headers),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as Response

beforeEach(() => {
  state.githubToken = "gh-token"
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.githubToken = originalGithubToken
})

test("returns null when no github token is available", async () => {
  state.githubToken = ""
  const result = await getCopilotUsage()
  expect(result).toBeNull()
})

test("returns usage on first success", async () => {
  const fetchMock = mock(() => makeResponse(200, usageBody))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("retries transient 503 many times then succeeds (never gives up)", async () => {
  let calls = 0
  const fetchMock = mock(() => {
    calls++
    return calls < 12 ?
        makeResponse(503, { message: "No server available" })
      : makeResponse(200, usageBody)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(fetchMock).toHaveBeenCalledTimes(12)
})

test("rings the terminal bell when service recovers after failures", async () => {
  let calls = 0
  const fetchMock = mock(() => {
    calls++
    return calls < 3 ?
        makeResponse(503, { message: "down" })
      : makeResponse(200, usageBody)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const written: Array<string> = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    await getCopilotUsage()
  } finally {
    process.stdout.write = originalWrite
  }

  expect(written).toContain("")
})

test("does not ring the bell on first-try success", async () => {
  const fetchMock = mock(() => makeResponse(200, usageBody))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const written: Array<string> = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  try {
    await getCopilotUsage()
  } finally {
    process.stdout.write = originalWrite
  }

  expect(written).not.toContain("")
})

test("retries network errors then succeeds", async () => {
  let calls = 0
  const fetchMock = mock(() => {
    calls++
    if (calls === 1) return Promise.reject(new Error("ECONNRESET"))
    return Promise.resolve(makeResponse(200, usageBody))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test("does not retry on non-retriable 401", async () => {
  const fetchMock = mock(() => makeResponse(401, { message: "bad creds" }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const error = await captureError(() => getCopilotUsage())
  expect(error).toBeInstanceOf(HTTPError)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("retries network errors indefinitely until success", async () => {
  let calls = 0
  const fetchMock = mock(() => {
    calls++
    if (calls < 6) return Promise.reject(new Error("ENOTFOUND"))
    return Promise.resolve(makeResponse(200, usageBody))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(fetchMock).toHaveBeenCalledTimes(6)
})
