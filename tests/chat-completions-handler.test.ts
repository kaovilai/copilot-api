import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ChatCompletionChunk } from "../src/lib/types/chat-completions"
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

  test("remaps a non-zero starting tool_calls index to zero-based, sequential indices", async () => {
    // Mirrors what GitHub Copilot's upstream actually streams when a text
    // preamble precedes a tool call: the text consumes Anthropic content-
    // block "index 0", so the tool call arrives at index 1 -- confirmed live
    // against copilot-api. Left unfixed, streaming AI SDK clients that
    // position tracked tool calls by this raw index (n8n's bundled
    // @ai-sdk/provider-utils among them, see vercel/ai#18333) leave a hole
    // at index 0 and crash on stream flush with "Cannot read properties of
    // undefined (reading 'hasFinished')".
    createChatCompletions.mockImplementation(() =>
      Promise.resolve(
        streamChunks([
          {
            data: JSON.stringify({
              choices: [
                {
                  delta: { content: "One moment.", role: "assistant" },
                  finish_reason: null,
                  index: 0,
                },
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
                {
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: "", name: "get_weather" },
                        id: "call_1",
                        index: 1,
                        type: "function",
                      },
                    ],
                  },
                  finish_reason: null,
                  index: 0,
                },
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
                {
                  delta: {
                    tool_calls: [
                      { function: { arguments: '{"city":"Paris"}' }, index: 1 },
                    ],
                  },
                  finish_reason: null,
                  index: 0,
                },
              ],
              created: 0,
              id: "chatcmpl-1",
              model: "gpt-test",
              object: "chat.completion.chunk",
            }),
          },
          {
            data: JSON.stringify({
              choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
              created: 0,
              id: "chatcmpl-1",
              model: "gpt-test",
              object: "chat.completion.chunk",
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
        messages: [{ content: "weather in Paris?", role: "user" }],
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
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as ChatCompletionChunk)

    const toolCallIndices = dataLines
      .flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? [])
      .map((toolCall) => toolCall.index)

    expect(toolCallIndices).toEqual([0, 0])
  })
})

describe("chat completions non-streaming response normalization", () => {
  test("fills in object/index/logprobs that upstream Copilot omits, matching what strict OpenAI clients require", async () => {
    // Mirrors the actual shape confirmed live from GitHub Copilot's own
    // chat-completions response -- it omits `object` and per-choice
    // `index`/`logprobs`, which this repo's own ChatCompletionResponse type
    // (and the OpenAI spec) declare as required. Strict clients like the
    // official @ai-sdk/openai package (used by e.g. n8n's "Connect a model"
    // verification) reject a response missing these with a generic
    // "Invalid JSON response" error.
    createChatCompletions.mockImplementation(() =>
      Promise.resolve({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "OK", role: "assistant" },
          },
        ],
        created: 0,
        id: "chatcmpl-1",
        model: "gpt-test",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately missing required fields to test the fill-in
      } as any),
    )

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hi", role: "user" }],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      choices: Array<{ index?: number; logprobs?: object | null }>
      object?: string
    }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]?.index).toBe(0)
    expect(body.choices[0]?.logprobs).toBeNull()
  })

  test("leaves object/index/logprobs unchanged when upstream already includes them", async () => {
    createChatCompletions.mockImplementation(() =>
      Promise.resolve({
        choices: [
          {
            finish_reason: "stop",
            index: 5,
            logprobs: { content: [] },
            message: { content: "OK", role: "assistant" },
          },
        ],
        created: 0,
        id: "chatcmpl-1",
        model: "gpt-test",
        object: "chat.completion",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    )

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hi", role: "user" }],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    const body = (await response.json()) as {
      choices: Array<{ index?: number; logprobs?: object | null }>
      object?: string
    }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]?.index).toBe(5)
    expect(body.choices[0]?.logprobs).toEqual({ content: [] })
  })
})
