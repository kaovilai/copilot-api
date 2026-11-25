import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"

import { state } from "~/lib/state"

const fetchCopilotWithReauth = mock(
  (_url: string, _init: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "msg_1" }), {
        headers: { "content-type": "application/json" },
      }),
    ),
)

void mock.module("~/services/copilot/fetch-with-reauth", () => ({
  fetchCopilotWithReauth,
}))

const { createMessages } = await import("~/services/copilot/create-messages")

const basePayload = (
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "claude-sonnet-4-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
  ...overrides,
})

describe("buildAnthropicBetaHeader (via createMessages)", () => {
  beforeEach(() => {
    state.copilotToken = "test-token"
  })

  afterEach(() => {
    fetchCopilotWithReauth.mockClear()
  })

  const capturedHeaders = () => {
    const calls = fetchCopilotWithReauth.mock.calls
    const [, init] = calls[calls.length - 1]
    return init.headers as Record<string, string>
  }

  test("passes through advanced-tool-use-2025-11-20 unstripped", async () => {
    await createMessages(basePayload(), "advanced-tool-use-2025-11-20", {
      requestId: "req-1",
    })

    expect(capturedHeaders()["anthropic-beta"]).toBe(
      "advanced-tool-use-2025-11-20",
    )
  })

  test("passes through all allowed betas combined", async () => {
    await createMessages(
      basePayload(),
      "interleaved-thinking-2025-05-14,context-management-2025-06-27,advanced-tool-use-2025-11-20",
      { requestId: "req-2" },
    )

    expect(capturedHeaders()["anthropic-beta"]).toBe(
      "interleaved-thinking-2025-05-14,context-management-2025-06-27,advanced-tool-use-2025-11-20",
    )
  })

  test("strips unknown beta flags while keeping allowed ones", async () => {
    await createMessages(
      basePayload(),
      "some-unknown-beta-2099-01-01,advanced-tool-use-2025-11-20",
      { requestId: "req-3" },
    )

    expect(capturedHeaders()["anthropic-beta"]).toBe(
      "advanced-tool-use-2025-11-20",
    )
  })

  test("omits the header entirely when every requested beta is unknown", async () => {
    await createMessages(basePayload(), "some-unknown-beta-2099-01-01", {
      requestId: "req-4",
    })

    expect(capturedHeaders()["anthropic-beta"]).toBeUndefined()
  })

  test("falls back to interleaved-thinking beta for non-adaptive thinking when no header sent", async () => {
    await createMessages(
      basePayload({ thinking: { type: "enabled", budget_tokens: 1024 } }),
      undefined,
      { requestId: "req-5" },
    )

    expect(capturedHeaders()["anthropic-beta"]).toBe(
      "interleaved-thinking-2025-05-14",
    )
  })
})
