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

const STATUS_URL = "https://www.githubstatus.com/api/v2/components.json"

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

// Route the githubstatus.com call to `statusHandler` and everything else
// (the usage endpoint) to `usageHandler`, so per-test call counters only
// observe usage-endpoint requests.
const installFetch = (
  usageHandler: () => Response | Promise<Response>,
  statusHandler: () => Response | Promise<Response> = () =>
    makeResponse(200, {
      components: [{ name: "Copilot", status: "operational" }],
    }),
): ReturnType<typeof mock> => {
  const usageMock = mock(usageHandler)
  globalThis.fetch = ((url: string | URL) => {
    if (String(url) === STATUS_URL) return statusHandler()
    return usageMock()
  }) as unknown as typeof fetch
  return usageMock
}

const captureStdout = async (
  fn: () => Promise<unknown>,
): Promise<Array<string>> => {
  const written: Array<string> = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = originalWrite
  }
  return written
}

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
  const usageMock = installFetch(() => makeResponse(200, usageBody))

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(usageMock).toHaveBeenCalledTimes(1)
})

test("retries transient 503 many times then succeeds (never gives up)", async () => {
  let calls = 0
  const usageMock = installFetch(() => {
    calls++
    return calls < 12 ?
        makeResponse(503, { message: "No server available" })
      : makeResponse(200, usageBody)
  })

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(usageMock).toHaveBeenCalledTimes(12)
})

test("rings the terminal bell when service recovers after failures", async () => {
  let calls = 0
  installFetch(() => {
    calls++
    return calls < 3 ?
        makeResponse(503, { message: "down" })
      : makeResponse(200, usageBody)
  })

  const written = await captureStdout(() => getCopilotUsage())
  expect(written).toContain("\x07")
})

test("does not ring the bell on first-try success", async () => {
  installFetch(() => makeResponse(200, usageBody))

  const written = await captureStdout(() => getCopilotUsage())
  expect(written).not.toContain("\x07")
})

test("retries network errors then succeeds", async () => {
  let calls = 0
  const usageMock = installFetch(() => {
    calls++
    if (calls === 1) return Promise.reject(new Error("ECONNRESET"))
    return Promise.resolve(makeResponse(200, usageBody))
  })

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(usageMock).toHaveBeenCalledTimes(2)
})

test("does not retry on non-retriable 401", async () => {
  const usageMock = installFetch(() =>
    makeResponse(401, { message: "bad creds" }),
  )

  const error = await captureError(() => getCopilotUsage())
  expect(error).toBeInstanceOf(HTTPError)
  expect(usageMock).toHaveBeenCalledTimes(1)
})

test("retries network errors indefinitely until success", async () => {
  let calls = 0
  const usageMock = installFetch(() => {
    calls++
    if (calls < 6) return Promise.reject(new Error("ENOTFOUND"))
    return Promise.resolve(makeResponse(200, usageBody))
  })

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(usageMock).toHaveBeenCalledTimes(6)
})

// Route GitHub calls and status-page calls separately, with the named status
// component reporting outage until `pollsUntilGreen` reads have elapsed, then
// operational. All other watched components stay operational throughout.
const installOutageFetch = (
  pollsUntilGreen: number,
  outageComponent = "Copilot",
): { ghCalls: () => number; statusCalls: () => number } => {
  let ghCalls = 0
  let statusPolls = 0
  globalThis.fetch = ((url: string | URL) => {
    if (String(url) === STATUS_URL) {
      statusPolls++
      const down = statusPolls < pollsUntilGreen
      const components = [
        "Copilot",
        "Copilot AI Model Providers",
        "API Requests",
      ].map((name) => ({
        name,
        status:
          down && name === outageComponent ? "major_outage" : "operational",
      }))
      return makeResponse(200, { components })
    }
    ghCalls++
    return ghCalls === 1 ?
        makeResponse(503, { message: "down" })
      : makeResponse(200, usageBody)
  }) as unknown as typeof fetch
  return { ghCalls: () => ghCalls, statusCalls: () => statusPolls }
}

test("during a known outage, polls the status page and does not hit GitHub until green", async () => {
  // Status page: initial check + two outage polls, then operational (4th read).
  const { ghCalls } = installOutageFetch(4)

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  // GitHub hit exactly twice: the initial 503, then the immediate retry on
  // recovery -- never during the outage window.
  expect(ghCalls()).toBe(2)
})

test("waits out an API Requests (auth) outage, not just Copilot", async () => {
  const { ghCalls } = installOutageFetch(4, "API Requests")

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(ghCalls()).toBe(2)
})

test("logs Copilot outage and recovery when polling the status page", async () => {
  installOutageFetch(2)

  const { default: consola } = await import("consola")
  const messages: Array<string> = []
  const originalWarn = consola.warn
  const originalInfo = consola.info
  consola.warn = ((m: string) => {
    messages.push(String(m))
  }) as typeof consola.warn
  consola.info = ((m: string) => {
    messages.push(String(m))
  }) as typeof consola.info

  try {
    await getCopilotUsage()
  } finally {
    consola.warn = originalWarn
    consola.info = originalInfo
  }

  expect(messages.some((m) => m.includes("Copilot: major outage"))).toBe(true)
  expect(messages.some((m) => m.includes("operational again"))).toBe(true)
})

test("falls back to GitHub backoff when the status page is unreachable", async () => {
  let calls = 0
  const usageMock = installFetch(
    () => {
      calls++
      return calls < 3 ?
          makeResponse(503, { message: "down" })
        : makeResponse(200, usageBody)
    },
    () => Promise.reject(new Error("status page down")),
  )

  const result = await getCopilotUsage()
  expect(result).toEqual(usageBody)
  expect(usageMock).toHaveBeenCalledTimes(3)
})
