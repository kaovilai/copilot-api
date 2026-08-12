import { afterEach, beforeEach, expect, mock, test } from "bun:test"

let getCopilotTokenCallCount = 0
let blockCalls = false
let pendingResolvers: Array<() => void> = []

await mock.module("~/services/github/get-copilot-token", () => ({
  getCopilotToken: mock(async () => {
    getCopilotTokenCallCount++
    const callIndex = getCopilotTokenCallCount
    if (blockCalls) {
      await new Promise<void>((resolve) => {
        pendingResolvers.push(resolve)
      })
    }
    return { token: `token-${callIndex}`, refresh_in: 1_800 }
  }),
}))

const { setupCopilotToken, stopCopilotRefreshLoop } = await import(
  "../src/lib/token"
)
const { state } = await import("../src/lib/state")

const originalCopilotToken = state.copilotToken

beforeEach(() => {
  getCopilotTokenCallCount = 0
  blockCalls = false
  pendingResolvers = []
})

afterEach(() => {
  stopCopilotRefreshLoop()
  state.copilotToken = originalCopilotToken
})

test("concurrent setupCopilotToken calls single-flight to one refresh", async () => {
  blockCalls = true
  const first = setupCopilotToken()
  const second = setupCopilotToken()

  expect(getCopilotTokenCallCount).toBe(1)

  blockCalls = false
  for (const resolve of pendingResolvers) resolve()
  await Promise.all([first, second])

  expect(getCopilotTokenCallCount).toBe(1)
  expect(state.copilotToken).toBe("token-1")
})

test("a later call after the first completes triggers a fresh refresh", async () => {
  await setupCopilotToken()
  expect(getCopilotTokenCallCount).toBe(1)

  await setupCopilotToken()
  expect(getCopilotTokenCallCount).toBe(2)
  expect(state.copilotToken).toBe("token-2")
})
