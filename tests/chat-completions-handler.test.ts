import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { createChatCompletions as createCopilotChatCompletions } from "../src/services/copilot/create-chat-completions"

const { state } = await import("../src/lib/state")
const { closeUsageStore } = await import("../src/lib/token-usage")
const { tokenUsageRoute } = await import("../src/routes/token-usage/route")
const { chatCompletionsHandlerDependencies } = await import(
  "../src/routes/chat-completions/handler"
)
const { completionRoutes } = await import(
  "../src/routes/chat-completions/route"
)

const defaultChatCompletionsHandlerDependencies = {
  ...chatCompletionsHandlerDependencies,
}

const createChatCompletions = mock((() =>
  Promise.resolve(streamChunks([]))) as typeof createCopilotChatCompletions)

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  models: state.models,
  vsCodeVersion: state.vsCodeVersion,
}

function createApp(): Hono {
  const app = new Hono()
  app.route("/v1/chat/completions", completionRoutes)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function* streamChunks(items: Array<Record<string, unknown>>) {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()

  state.copilotToken = "test-token"
  state.accountType = "individual"
  state.vsCodeVersion = "1.120.0"
  state.models = {
    object: "list",
    data: [
      {
        capabilities: {
          limits: {},
        },
        id: "gpt-test",
        supported_endpoints: ["/chat/completions"],
      },
    ],
  } as typeof state.models

  chatCompletionsHandlerDependencies.createChatCompletions =
    createChatCompletions
  createChatCompletions.mockClear()
})

afterEach(() => {
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.models = originalState.models
  state.vsCodeVersion = originalState.vsCodeVersion
  Object.assign(
    chatCompletionsHandlerDependencies,
    defaultChatCompletionsHandlerDependencies,
  )
})

describe("chat completions streaming usage pre-check", () => {
  test("forwards every chunk unchanged and still records usage carried on the final chunk", async () => {
    createChatCompletions.mockImplementation(() =>
      Promise.resolve(
        streamChunks([
          {
            data: JSON.stringify({
              choices: [
                { delta: { content: "hel" }, finish_reason: null, index: 0 },
              ],
              created: 0,
              id: "chatcmpl-1",
              model: "gpt-test",
              object: "chat.completion.chunk",
            }),
          },
          {
            data: JSON.stringify({
              choices: [
                { delta: { content: "lo" }, finish_reason: null, index: 0 },
              ],
              created: 0,
              id: "chatcmpl-1",
              model: "gpt-test",
              object: "chat.completion.chunk",
            }),
          },
          {
            data: JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
              copilot_usage: { total_nano_aiu: 42 },
              created: 0,
              id: "chatcmpl-1",
              model: "gpt-test",
              object: "chat.completion.chunk",
              usage: {
                completion_tokens: 2,
                prompt_tokens: 3,
                total_tokens: 5,
              },
            }),
          },
          {
            data: "[DONE]",
          },
        ]),
      ),
    )

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hi", role: "user" }],
        model: "gpt-test",
        stream: true,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const body = await response.text()

    const dataLines = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())

    expect(dataLines).toHaveLength(4)
    expect(dataLines[3]).toBe("[DONE]")
    const firstChunk = JSON.parse(dataLines[0]) as {
      choices: Array<{ delta: { content?: string } }>
    }
    expect(firstChunk.choices[0]?.delta.content).toBe("hel")

    const eventsResponse = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    const page = (await eventsResponse.json()) as {
      items: Array<{
        input_tokens: number
        output_tokens: number
        total_nano_aiu: number | null
        total_tokens: number
      }>
    }
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.input_tokens).toBe(3)
    expect(page.items[0]?.output_tokens).toBe(2)
    expect(page.items[0]?.total_tokens).toBe(5)
    expect(page.items[0]?.total_nano_aiu).toBe(42)
  })
})
