import consola from "consola"
import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import { resolveMappedModel } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import {
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  normalizeOptionalToken,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID, isNullish } from "~/lib/utils"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/lib/types/chat-completions"
import { createChatCompletions as createCopilotChatCompletions } from "~/services/copilot/create-chat-completions"

const logger = createHandlerLogger("chat-completions-handler")

export const chatCompletionsHandlerDependencies = {
  createChatCompletions: createCopilotChatCompletions,
}

export async function handleCompletion(c: Context) {
  let payload = await c.req.json<ChatCompletionsPayload>()
  const requestedModel = payload.model
  payload.model = resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerModelAlias = await resolveConfiguredProviderModelAlias(
    payload.model,
  )
  if (providerModelAlias) {
    payload.model = providerModelAlias.model
    return await handleProviderChatCompletionsForProvider(c, {
      payload,
      provider: providerModelAlias.provider,
    })
  }

  debugJson(logger, "Request payload:", payload)

  const selectedModel = findEndpointModel(payload.model)
  payload.model = selectedModel?.id ?? payload.model

  if (
    isNullish(payload.max_tokens)
    && isNullish(payload.max_completion_tokens)
  ) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    debugJson(logger, "Set max_tokens to:", payload.max_tokens)
  }

  if (payload.model.includes("gpt")) {
    if (isNullish(payload.max_completion_tokens)) {
      payload.max_completion_tokens = payload.max_tokens
    }
    delete payload.max_tokens
  }

  // not support subagent marker for now , set sessionId = getUUID(requestId)
  const requestId = generateRequestIdFromPayload(payload)
  logger.debug("Generated request ID:", requestId)

  const sessionId = getUUID(requestId)
  logger.debug("Extracted session ID:", sessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: payload.model,
  })

  const response =
    await chatCompletionsHandlerDependencies.createChatCompletions(payload, {
      requestId,
      sessionId,
      signal: c.req.raw.signal,
    })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response:", response)
    recordUsage({
      ...normalizeOpenAIUsage(response.usage),
      total_nano_aiu: normalizeOptionalToken(
        response.copilot_usage?.total_nano_aiu,
      ),
    })
    return c.json(normalizeChatCompletionResponse(response))
  }

  logger.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const toolCallIndexMap = new Map<number, number>()

    try {
      for await (const chunk of response) {
        debugJson(logger, "Streaming chunk:", chunk)
        const parsedChunk = parseChatCompletionChunk(chunk)
        if (parsedChunk?.usage || parsedChunk?.copilot_usage) {
          usage = {
            ...normalizeOpenAIUsage(parsedChunk.usage),
            total_nano_aiu: normalizeOptionalToken(
              parsedChunk.copilot_usage?.total_nano_aiu,
            ),
          }
        }

        const remapped = remapToolCallChunkIndices(chunk, toolCallIndexMap)
        await stream.writeSSE((remapped ?? chunk) as SSEMessage)
      }
    } catch (error) {
      // A client disconnect (or the request otherwise being cancelled) aborts
      // the upstream stream mid-read -- expected, not a bug. Previously
      // unhandled here: route.ts's try/catch only wraps handleCompletion's
      // synchronous return of the streamSSE Response, not this async
      // callback, which streamSSE invokes AFTER that Response has already
      // been returned. An uncaught abort here surfaced as a raw, unformatted
      // DOMException dump in logs and left the connection just stop instead
      // of closing cleanly -- confirmed live. Log quietly for an abort
      // (matching forwardError's existing handling for the non-streaming
      // path), loudly for anything else, and still record whatever partial
      // usage was captured either way rather than silently dropping it.
      if (c.req.raw.signal.aborted || isAbortError(error)) {
        logger.debug("Streaming response aborted (client disconnected)")
      } else {
        consola.error("Error in streaming response:", error)
      }
    }

    recordUsage(usage)
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createCopilotChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError"

/**
 * GitHub Copilot's upstream chat-completions response omits `object` on the
 * top-level response and `index`/`logprobs` on each choice -- fields this
 * type already declares as required, and fields the OpenAI spec (and strict
 * clients like the official `@ai-sdk/openai` package, used by e.g. n8n's
 * "Connect a model" verification) actually require. Without this, such
 * clients reject an otherwise-valid response with a generic
 * "Invalid JSON response" error, since their Zod schema validation fails on
 * the missing required fields -- confirmed live against n8n 2.37.10.
 * Fills in only what's missing, so a response that already has these (e.g.
 * from a future upstream change, or a different provider routed through
 * this same handler) passes through unchanged.
 */
function normalizeChatCompletionResponse(
  response: ChatCompletionResponse,
): ChatCompletionResponse {
  return {
    ...response,
    object: response.object ?? "chat.completion",
    choices: response.choices.map((choice, index) => ({
      ...choice,
      index: choice.index ?? index,
      logprobs: choice.logprobs ?? null,
    })),
  }
}

const parseChatCompletionChunk = (
  chunk: unknown,
): ChatCompletionChunk | null => {
  const data = (chunk as { data?: string }).data
  // Only the final chunk of a stream carries usage/copilot_usage, which is
  // all this parses for -- skip the JSON.parse on every other token.
  if (!data || data === "[DONE]" || !data.includes("usage")) {
    return null
  }

  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}

/**
 * GitHub Copilot's upstream stream reuses Anthropic content-block indices
 * for `tool_calls[].index` -- when a text block precedes a tool call, the
 * text consumes "block 0", so the first tool call streams with `index: 1`
 * instead of `0`, leaving a hole at index 0. Streaming AI SDK clients (n8n's
 * bundled @ai-sdk/provider-utils among them, per vercel/ai#18333) track
 * streamed tool calls in an array positioned BY this index, and their
 * flush() handler iterates that array with a bare `for...of` (which does
 * not skip holes), crashing with "Cannot read properties of undefined
 * (reading 'hasFinished')" on the empty slot. Confirmed live: n8n 2.37.10's
 * AI Assistant crashed on exactly this pattern (a one-sentence preamble
 * before a tool call) against this gateway.
 *
 * Remaps each tool call's raw index to a sequential, zero-based one (in
 * order of first appearance in this stream) before forwarding, matching
 * what OpenAI's own real API always does. `indexMap` is fresh per request/
 * stream (see caller). Returns null (pass the original chunk through
 * unchanged) when there's nothing to remap or the chunk doesn't parse.
 */
function remapToolCallChunkIndices(
  chunk: unknown,
  indexMap: Map<number, number>,
): { data: string } | null {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]" || !data.includes("tool_calls")) {
    return null
  }

  let parsed: ChatCompletionChunk
  try {
    parsed = JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }

  let changed = false
  for (const choice of parsed.choices) {
    const toolCalls = choice.delta.tool_calls
    if (!toolCalls) continue
    for (const toolCall of toolCalls) {
      if (toolCall.index == null) continue
      let mapped = indexMap.get(toolCall.index)
      if (mapped == null) {
        mapped = indexMap.size
        indexMap.set(toolCall.index, mapped)
      }
      if (mapped !== toolCall.index) {
        toolCall.index = mapped
        changed = true
      }
    }
  }

  return changed ? { ...(chunk as object), data: JSON.stringify(parsed) } : null
}
