import { expect, test } from "bun:test"

import { parseRetryAfterMs } from "../src/lib/error"

test("parses Retry-After as delta-seconds", () => {
  const headers = new Headers({ "Retry-After": "120" })

  expect(parseRetryAfterMs(headers)).toBe(120_000)
})

test("parses Retry-After as an HTTP-date", () => {
  const futureDate = new Date(Date.now() + 60_000)
  const headers = new Headers({ "Retry-After": futureDate.toUTCString() })

  const result = parseRetryAfterMs(headers)

  expect(result).not.toBeNull()
  expect(result).toBeGreaterThan(55_000)
  expect(result).toBeLessThanOrEqual(60_000)
})

test("clamps a past HTTP-date to zero", () => {
  const pastDate = new Date(Date.now() - 60_000)
  const headers = new Headers({ "Retry-After": pastDate.toUTCString() })

  expect(parseRetryAfterMs(headers)).toBe(0)
})

test("returns null when the header is absent", () => {
  const headers = new Headers()

  expect(parseRetryAfterMs(headers)).toBeNull()
})

test("returns null for an unparseable value", () => {
  const headers = new Headers({ "Retry-After": "not-a-date-or-number" })

  expect(parseRetryAfterMs(headers)).toBeNull()
})
