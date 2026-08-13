import { describe, expect, it } from "@effect/vitest"
import { visibleContentRows } from "./system-prompt.js"

describe("visibleContentRows", () => {
  it("returns a fallback for invalid terminal heights", () => {
    expect(visibleContentRows(0)).toBe(30)
    expect(visibleContentRows(-1)).toBe(30)
  })

  it("computes content rows from 80% of the terminal minus 6 chrome rows", () => {
    expect(visibleContentRows(50)).toBe(34)
    expect(visibleContentRows(100)).toBe(74)
  })

  it("clamps to at least one row on tiny terminals", () => {
    expect(visibleContentRows(8)).toBe(1)
  })
})
