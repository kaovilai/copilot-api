import { afterEach, expect, mock, test } from "bun:test"

import { pollAccessToken } from "../src/services/github/poll-access-token"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const jsonResponse = (
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

test("returns the access token once granted", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(jsonResponse(200, { access_token: "tok" })),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const token = await pollAccessToken({
    device_code: "d",
    user_code: "u",
    verification_uri: "https://example.test",
    expires_in: 900,
    interval: 0,
  })

  expect(token).toBe("tok")
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("keeps polling through authorization_pending", async () => {
  let calls = 0
  const fetchMock = mock(() => {
    calls++
    return Promise.resolve(
      calls < 3 ?
        jsonResponse(200, { error: "authorization_pending" })
      : jsonResponse(200, { access_token: "tok" }),
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const token = await pollAccessToken({
    device_code: "d",
    user_code: "u",
    verification_uri: "https://example.test",
    expires_in: 900,
    interval: 0,
  })

  expect(token).toBe("tok")
  expect(calls).toBe(3)
})

test("widens the poll interval on slow_down and keeps it widened", async () => {
  const callTimes: Array<number> = []
  let calls = 0
  const fetchMock = mock(() => {
    callTimes.push(Date.now())
    calls++
    if (calls === 1) {
      return Promise.resolve(jsonResponse(200, { error: "slow_down" }))
    }
    if (calls === 2) {
      return Promise.resolve(
        jsonResponse(200, { error: "authorization_pending" }),
      )
    }
    return Promise.resolve(jsonResponse(200, { access_token: "tok" }))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const token = await pollAccessToken({
    device_code: "d",
    user_code: "u",
    verification_uri: "https://example.test",
    expires_in: 900,
    interval: 0,
  })

  expect(token).toBe("tok")
  expect(calls).toBe(3)
  // interval starts at 1000ms; slow_down bumps it to 6000ms and it stays
  // widened for the next wait too.
  expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(5900)
  expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(5900)
}, 20_000)

test("honors Retry-After on a 429 instead of the default interval", async () => {
  const callTimes: Array<number> = []
  let calls = 0
  const fetchMock = mock(() => {
    callTimes.push(Date.now())
    calls++
    if (calls === 1) {
      return Promise.resolve(
        jsonResponse(429, { message: "rate limited" }, { "Retry-After": "2" }),
      )
    }
    return Promise.resolve(jsonResponse(200, { access_token: "tok" }))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const token = await pollAccessToken({
    device_code: "d",
    user_code: "u",
    verification_uri: "https://example.test",
    expires_in: 900,
    interval: 0,
  })

  expect(token).toBe("tok")
  expect(calls).toBe(2)
  expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(1900)
}, 20_000)
