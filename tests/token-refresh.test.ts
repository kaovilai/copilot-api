import { expect, test } from "bun:test"

import {
  getRefreshDeadlineMs,
  getRefreshPollDelayMs,
  getRetryAfterDelayMs,
} from "~/lib/token"

test("builds refresh deadline from refresh_in and local time", () => {
  const nowMs = 1_000_000

  expect(getRefreshDeadlineMs(1_800, nowMs)).toBe(nowMs + 1_740_000)
})

test("clamps refresh deadline to avoid a hot loop", () => {
  const nowMs = 1_000_000

  expect(getRefreshDeadlineMs(30, nowMs)).toBe(nowMs + 1_000)
})

test("caps poll delay at 15 seconds while waiting", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs + 120_000, nowMs)).toBe(15_000)
})

test("uses remaining delay when refresh is close", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs + 8_000, nowMs)).toBe(8_000)
})

test("returns zero when refresh is already due", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs - 1, nowMs)).toBe(0)
})

test("returns null when there's no Retry-After, falling back to jittered backoff", () => {
  expect(getRetryAfterDelayMs(15_000, null)).toBeNull()
})

test("honors a Retry-After longer than the current backoff", () => {
  expect(getRetryAfterDelayMs(15_000, 300_000)).toBe(300_000)
})

test("doesn't shrink the delay below the current backoff for a short Retry-After", () => {
  expect(getRetryAfterDelayMs(15_000, 1_000)).toBe(15_000)
})

test("clamps an extreme Retry-After to the max refresh retry delay", () => {
  expect(getRetryAfterDelayMs(15_000, 100 * 60_000)).toBe(600_000)
})
