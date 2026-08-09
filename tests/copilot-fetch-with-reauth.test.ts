import { afterEach, beforeEach, expect, mock, test } from "bun:test"

const actualTokenModule = await import("../src/lib/token")

let setupCopilotTokenMock = mock(() => {})

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCopilotToken: () => setupCopilotTokenMock(),
}))

const { state } = await import("../src/lib/state")
const { fetchCopilotWithReauth } = await import(
  "../src/services/copilot/fetch-with-reauth"
)

const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken

const jsonResponse = (status: number) =>
  ({
    status,
    ok: status >= 200 && status < 300,
  }) as Response

beforeEach(() => {
  state.copilotToken = "stale-token"
  setupCopilotTokenMock = mock(() => {
    state.copilotToken = "refreshed-token"
  })
})

afterEach(() => {
  state.copilotToken = originalCopilotToken
  globalThis.fetch = originalFetch
})

test("refreshes token and retries once on 401, then succeeds", async () => {
  const seenAuthHeaders: Array<string> = []
  const fetchMock = mock((_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    seenAuthHeaders.push(headers.Authorization)
    return jsonResponse(seenAuthHeaders.length === 1 ? 401 : 200)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const init = { headers: { Authorization: "Bearer stale-token" } }
  const response = await fetchCopilotWithReauth("https://example.test", init)

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(setupCopilotTokenMock).toHaveBeenCalledTimes(1)
  expect(seenAuthHeaders).toEqual([
    "Bearer stale-token",
    "Bearer refreshed-token",
  ])
})

test("returns second 401 response when refresh doesn't fix it, without looping", async () => {
  const fetchMock = mock(() => jsonResponse(401))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const init = { headers: { Authorization: "Bearer stale-token" } }
  const response = await fetchCopilotWithReauth("https://example.test", init)

  expect(response.status).toBe(401)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(setupCopilotTokenMock).toHaveBeenCalledTimes(1)
})

test("returns original 401 response when reauth itself throws", async () => {
  setupCopilotTokenMock = mock(() => {
    throw new Error("github token invalid")
  })
  const fetchMock = mock(() => jsonResponse(401))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const init = { headers: { Authorization: "Bearer stale-token" } }
  const response = await fetchCopilotWithReauth("https://example.test", init)

  expect(response.status).toBe(401)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("does not reauth or retry on a non-401 response", async () => {
  const fetchMock = mock(() => jsonResponse(500))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const init = { headers: { Authorization: "Bearer stale-token" } }
  const response = await fetchCopilotWithReauth("https://example.test", init)

  expect(response.status).toBe(500)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(setupCopilotTokenMock).toHaveBeenCalledTimes(0)
})
