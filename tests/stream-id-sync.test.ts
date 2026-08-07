import { describe, expect, test } from "bun:test"

import type {
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
} from "../src/lib/types/responses"

import {
  applyStreamIdFix,
  createStreamIdTracker,
} from "../src/routes/responses/stream-id-sync"

describe("applyStreamIdFix", () => {
  test("assigns a synthetic id on added when item has none and reports a change", () => {
    const tracker = createStreamIdTracker()
    const event: ResponseOutputItemAddedEvent = {
      item: {
        id: "",
        role: "assistant",
        status: "in_progress",
        type: "message",
      },
      output_index: 0,
      sequence_number: 1,
      type: "response.output_item.added",
    }

    const changed = applyStreamIdFix(
      event,
      "response.output_item.added",
      tracker,
    )

    expect(changed).toBe(true)
    expect(event.item.id).toMatch(/^oi_0_/)
    expect(tracker.outputItems.get(0)).toBe(event.item.id)
  })

  test("added does not report a change when the item already has an id", () => {
    const tracker = createStreamIdTracker()
    const event: ResponseOutputItemAddedEvent = {
      item: {
        id: "item-added-1",
        role: "assistant",
        status: "in_progress",
        type: "message",
      },
      output_index: 2,
      sequence_number: 1,
      type: "response.output_item.added",
    }

    const changed = applyStreamIdFix(
      event,
      "response.output_item.added",
      tracker,
    )

    expect(changed).toBe(false)
    expect(event.item.id).toBe("item-added-1")
    expect(tracker.outputItems.get(2)).toBe("item-added-1")
  })

  test("rewrites the done event id back to the tracked added id and reports a change", () => {
    const tracker = createStreamIdTracker()
    tracker.outputItems.set(1, "item-added-1")

    const event: ResponseOutputItemDoneEvent = {
      item: {
        id: "item-done-mismatch",
        role: "assistant",
        status: "completed",
        type: "message",
      },
      output_index: 1,
      sequence_number: 5,
      type: "response.output_item.done",
    }

    const changed = applyStreamIdFix(
      event,
      "response.output_item.done",
      tracker,
    )

    expect(changed).toBe(true)
    expect(event.item.id).toBe("item-added-1")
  })

  test("done is a no-op when the id already matches the tracked id", () => {
    const tracker = createStreamIdTracker()
    tracker.outputItems.set(1, "item-added-1")

    const event: ResponseOutputItemDoneEvent = {
      item: {
        id: "item-added-1",
        role: "assistant",
        status: "completed",
        type: "message",
      },
      output_index: 1,
      sequence_number: 5,
      type: "response.output_item.done",
    }

    const changed = applyStreamIdFix(
      event,
      "response.output_item.done",
      tracker,
    )

    expect(changed).toBe(false)
    expect(event.item.id).toBe("item-added-1")
  })

  test("rewrites item_id on delta events when it disagrees with the tracked id", () => {
    const tracker = createStreamIdTracker()
    tracker.outputItems.set(0, "item-added-1")

    const event: ResponseTextDeltaEvent = {
      content_index: 0,
      delta: "hello",
      item_id: "item-upstream-mismatch",
      output_index: 0,
      sequence_number: 3,
      type: "response.output_text.delta",
    }

    const changed = applyStreamIdFix(event, event.type, tracker)

    expect(changed).toBe(true)
    expect(event.item_id).toBe("item-added-1")
  })

  test("delta events are a no-op when item_id already matches the tracked id", () => {
    const tracker = createStreamIdTracker()
    tracker.outputItems.set(0, "item-added-1")

    const event: ResponseTextDeltaEvent = {
      content_index: 0,
      delta: "hello",
      item_id: "item-added-1",
      output_index: 0,
      sequence_number: 3,
      type: "response.output_text.delta",
    }

    const changed = applyStreamIdFix(event, event.type, tracker)

    expect(changed).toBe(false)
  })

  test("events without a tracked output_index are left untouched", () => {
    const tracker = createStreamIdTracker()
    const event = {
      sequence_number: 1,
      type: "response.created",
    } as unknown as ResponseStreamEvent

    const changed = applyStreamIdFix(event, "response.created", tracker)

    expect(changed).toBe(false)
  })
})
