import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import { server } from "../src/server"

describe("GET /usage-viewer", () => {
  test("serves the usage viewer HTML consistently across repeated requests", async () => {
    const expected = readFileSync(
      new URL("../pages/index.html", import.meta.url),
      "utf8",
    )

    const first = await server.request("/usage-viewer")
    const second = await server.request("/usage-viewer")

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.text()).toBe(expected)
    expect(await second.text()).toBe(expected)
  })

  test("redirects the trailing-slash variant to the canonical path", async () => {
    const response = await server.request("/usage-viewer/", {
      redirect: "manual",
    })

    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe("/usage-viewer")
  })
})
