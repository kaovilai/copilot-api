import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { requestContext, type RequestTiming } from "~/lib/request-context"
import { requestEventsMiddleware } from "~/lib/request-events"
import { traceIdMiddleware } from "~/lib/trace"
import type { ChatCompletionChunk } from "../src/lib/types/chat-completions"

process.env.COPILOT_API_HOME = mkdtempSync(
  path.join(tmpdir(), "copilot-api-chat-"),
)
process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
import type { createChatCompletions as createCopilotChatCompletions } from "../src/services/copilot/create-chat-completions"

const { state } = await import("../src/lib/state")
const { closeUsageStore, getTokenUsageEventsPage } = await import(
  "../src/lib/token-usage"
)
const { tokenUsageRoute } = await import("../src/routes/token-usage/route")
const { chatCompletionsHandlerDependencies, handleCompletion } = await import(
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
let requestTiming: RequestTiming | undefined

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

async function* streamChunks(
  chunks: Array<{ data?: string; error?: Error }>,
): AsyncGenerator<{ data: string }> {
  for (const chunk of chunks) {
    await Promise.resolve()
    if (chunk.error) {
      throw chunk.error
    }
    yield { data: chunk.data ?? "" }
  }
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
  requestTiming = undefined

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

afterEach(async () => {
  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.models = originalState.models
  state.vsCodeVersion = originalState.vsCodeVersion
  Object.assign(
    chatCompletionsHandlerDependencies,
    defaultChatCompletionsHandlerDependencies,
  )
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
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

  test("does not throw on a chunk whose raw text mentions tool_calls but has no usable choices/delta", async () => {
    // The remap guard only substring-checks the raw data for "tool_calls"
    // before parsing (a cheap fast-path to skip JSON.parse on plain content
    // chunks) -- a malformed or unexpected upstream chunk that happens to
    // contain that substring without a real choices/delta shape must not
    // crash the remap function itself, or it kills the whole stream (caught
    // by the outer try/catch now, but still ends the response early and
    // logs as an unexpected error for what should just be a no-op).
    createChatCompletions.mockImplementation(() =>
      Promise.resolve(
        streamChunks([
          {
            // No `choices` field at all.
            data: JSON.stringify({
              created: 0,
              id: "chatcmpl-1",
              model: "gpt-test",
              note: "mentions tool_calls but carries no real payload",
              object: "chat.completion.chunk",
            }),
          },
          {
            // `choices` present, but the choice has no `delta`.
            data: JSON.stringify({
              choices: [{ finish_reason: "stop", index: 0 }],
              created: 0,
              id: "chatcmpl-1",
              model: "gpt-test",
              note: "tool_calls",
              object: "chat.completion.chunk",
            }),
          },
          {
            data: JSON.stringify({
              choices: [{ delta: { content: "still works" }, index: 0 }],
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

    // All 4 chunks (including "[DONE]") made it through unchanged -- the
    // malformed ones were passed through as-is (remap returns null), not
    // dropped or used to abort the stream early.
    expect(dataLines).toHaveLength(4)
    expect(dataLines[3]).toBe("[DONE]")
    const lastContentChunk = JSON.parse(dataLines[2]) as {
      choices: Array<{ delta: { content?: string } }>
    }
    expect(lastContentChunk.choices[0]?.delta.content).toBe("still works")
  })

  test("gracefully ends the stream on client abort instead of crashing", async () => {
    // Simulates a client disconnect mid-stream (or the request otherwise
    // being cancelled) aborting the upstream read. Previously unhandled:
    // route.ts's try/catch only wraps handleCompletion's synchronous return
    // of the streamSSE Response, not this async generator loop -- an
    // uncaught abort here surfaced as a raw, unformatted error dump and left
    // the connection just stop instead of closing cleanly.
    async function* streamThenAbort() {
      await Promise.resolve()
      yield {
        data: JSON.stringify({
          choices: [
            { delta: { content: "partial" }, finish_reason: null, index: 0 },
          ],
          created: 0,
          id: "chatcmpl-1",
          model: "gpt-test",
          object: "chat.completion.chunk",
        }),
      }
      const abortError = new Error("The connection was closed.")
      abortError.name = "AbortError"
      throw abortError
    }

    createChatCompletions.mockImplementation(() =>
      Promise.resolve(streamThenAbort()),
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
    // Must not throw/hang -- this is exactly what an uncaught abort in the
    // generator loop previously broke.
    const body = await response.text()

    const dataLines = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())

    expect(dataLines).toHaveLength(1)
    const firstChunk = JSON.parse(dataLines[0]) as {
      choices: Array<{ delta: { content?: string } }>
    }
    expect(firstChunk.choices[0]?.delta.content).toBe("partial")
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

test("native chat completions stream records usage when the upstream iterator throws", async () => {
  createChatCompletions.mockImplementationOnce(() =>
    Promise.resolve(
      streamChunks([
        chunk({
          content: "partial",
          usage: {
            completion_tokens: 2,
            prompt_tokens: 5,
            total_tokens: 7,
          },
        }),
        { error: new Error("upstream connection reset") },
      ]),
    ),
  )
  const response = await requestCompletion()
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain("partial")
  expect(body).toContain("event: error")
  expect(body).toContain('"code":"upstream_stream_error"')
  expect(body).not.toContain("[DONE]")
  expect(requestTiming?.outcome).toBe("error")

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    endpoint: "chat_completions",
    input_tokens: 5,
    model: "gpt-test",
    output_tokens: 2,
    total_tokens: 7,
  })
})

test("native chat completions stream records usage after an invalid JSON chunk", async () => {
  createChatCompletions.mockImplementationOnce(() =>
    Promise.resolve(
      streamChunks([
        { data: "not-json" },
        chunk({
          content: "after",
          usage: {
            completion_tokens: 3,
            prompt_tokens: 8,
            total_tokens: 11,
          },
        }),
        { data: "[DONE]" },
      ]),
    ),
  )

  const response = await requestCompletion()
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain("after")
  expect(body).not.toContain("event: error")
  expect(requestTiming?.outcome).toBe("completed")

  const usageEvents = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(usageEvents.items).toHaveLength(1)
  expect(usageEvents.items[0]).toMatchObject({
    input_tokens: 8,
    output_tokens: 3,
    total_tokens: 11,
  })
})

test("native chat completions reports missing DONE and retains partial usage", async () => {
  createChatCompletions.mockResolvedValueOnce(
    streamChunks([
      chunk({
        content: "partial",
        usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
      }),
    ]),
  )
  const response = await requestCompletion()
  const body = await response.text()
  expect(body).toContain("partial")
  expect(body).toContain("event: error")
  expect(body).toContain('"code":"incomplete_stream"')
  expect(requestTiming?.outcome).toBe("error")
  const events = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(events.items).toHaveLength(1)
  expect(events.items[0]).toMatchObject({ input_tokens: 6, output_tokens: 3 })
})

test("native chat completions tracks JSON-only upstream errors as failures", async () => {
  createChatCompletions.mockResolvedValueOnce(
    streamChunks([
      { data: '{"error":{"message":"overloaded","type":"api_error"}}' },
      { data: "[DONE]" },
    ]),
  )
  const response = await requestCompletion()
  const body = await response.text()
  expect(body).toContain("event: error")
  expect(body).toContain("overloaded")
  expect(body).not.toContain("incomplete_stream")
  expect(requestTiming?.outcome).toBe("error")
})

test("native chat completions drains final usage after the client disconnects", async () => {
  let releaseUsage = () => {}
  const usageReady = new Promise<void>((resolve) => {
    releaseUsage = resolve
  })
  let finishUpstream = () => {}
  const upstreamFinished = new Promise<void>((resolve) => {
    finishUpstream = resolve
  })
  async function* upstream() {
    try {
      yield { data: '{"choices":[{"delta":{"content":"partial"}}]}' }
      await usageReady
      yield chunk({
        content: "",
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      })
      yield { data: "[DONE]" }
    } finally {
      finishUpstream()
    }
  }
  createChatCompletions.mockResolvedValueOnce(upstream())
  const response = await requestCompletion()
  const reader = response.body!.getReader()
  try {
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
  } finally {
    releaseUsage()
  }
  await upstreamFinished
  // The route records usage after the source iterator has returned.
  for (let attempt = 0; attempt < 50 && !requestTiming?.hasUsage; attempt++) {
    await Bun.sleep(1)
  }
  expect(requestTiming?.hasUsage).toBe(true)
  expect(requestTiming?.outcome).toBe("cancelled")
  const events = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "today",
  })
  expect(events.items).toHaveLength(1)
  expect(events.items[0]).toMatchObject({ input_tokens: 12, output_tokens: 7 })
})

const requestCompletion = async (): Promise<Response> => {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(requestEventsMiddleware(undefined, 4141))
  app.use(async (_c, next) => {
    requestTiming = requestContext.getStore()?.requestTiming
    await next()
  })
  app.post("/v1/chat/completions", handleCompletion)
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-test",
      stream: true,
    }),
  })
}

const chunk = (input: {
  content: string
  usage: {
    completion_tokens: number
    prompt_tokens: number
    total_tokens: number
  }
}): { data: string } => {
  const payload: ChatCompletionChunk = {
    choices: [
      {
        delta: { content: input.content },
        finish_reason: null,
        index: 0,
        logprobs: null,
      },
    ],
    created: 0,
    id: "chatcmpl-test",
    model: "gpt-test",
    object: "chat.completion.chunk",
    usage: input.usage,
  }
  return { data: JSON.stringify(payload) }
}
