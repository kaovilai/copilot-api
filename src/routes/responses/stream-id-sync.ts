/**
 * Stream ID Synchronization for @ai-sdk/openai compatibility
 *
 * Problem: GitHub Copilot's Responses API returns different IDs for the same
 * item in 'added' vs 'done' events. This breaks @ai-sdk/openai which expects
 * consistent IDs across the stream lifecycle.
 *
 * Errors without this fix:
 * - "activeReasoningPart.summaryParts" undefined
 * - "text part not found"
 *
 * Use case: OpenCode (AI coding assistant) using Codex models (gpt-5.2-codex)
 * via @ai-sdk/openai provider requires the Responses API endpoint.
 */

import type {
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"

interface StreamIdTracker {
  outputItems: Map<number, string>
}

export const createStreamIdTracker = (): StreamIdTracker => ({
  outputItems: new Map(),
})

/**
 * Applies the ID fix in place on an already-parsed event and reports whether
 * the event was actually mutated. Callers should only re-serialize the event
 * (JSON.stringify) when this returns true, and can forward the original raw
 * string unchanged otherwise -- avoids a parse+stringify round-trip on every
 * streamed token when the upstream IDs already happen to match.
 */
export const applyStreamIdFix = (
  parsed: ResponseStreamEvent,
  event: string | undefined,
  tracker: StreamIdTracker,
): boolean => {
  switch (event) {
    case "response.output_item.added": {
      return handleOutputItemAdded(
        parsed as ResponseOutputItemAddedEvent,
        tracker,
      )
    }
    case "response.output_item.done": {
      return handleOutputItemDone(
        parsed as ResponseOutputItemDoneEvent,
        tracker,
      )
    }
    default: {
      return handleItemId(
        parsed as ResponseStreamEvent & {
          output_index?: number
          item_id?: string
        },
        tracker,
      )
    }
  }
}

const handleOutputItemAdded = (
  parsed: ResponseOutputItemAddedEvent,
  tracker: StreamIdTracker,
): boolean => {
  let changed = false
  if (!parsed.item.id) {
    let randomSuffix = ""
    while (randomSuffix.length < 16) {
      randomSuffix += Math.random().toString(36).slice(2)
    }
    parsed.item.id = `oi_${parsed.output_index}_${randomSuffix.slice(0, 16)}`
    changed = true
  }

  tracker.outputItems.set(parsed.output_index, parsed.item.id)
  return changed
}

const handleOutputItemDone = (
  parsed: ResponseOutputItemDoneEvent,
  tracker: StreamIdTracker,
): boolean => {
  const originalId = tracker.outputItems.get(parsed.output_index)
  if (originalId && parsed.item.id !== originalId) {
    parsed.item.id = originalId
    return true
  }
  return false
}

const handleItemId = (
  parsed: ResponseStreamEvent & { output_index?: number; item_id?: string },
  tracker: StreamIdTracker,
): boolean => {
  const outputIndex = parsed.output_index
  if (outputIndex !== undefined) {
    const itemId = tracker.outputItems.get(outputIndex)
    if (itemId && parsed.item_id !== itemId) {
      parsed.item_id = itemId
      return true
    }
  }
  return false
}
