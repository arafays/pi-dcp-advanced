import type { ContextUsage } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "@effect/vitest"
import { createEmptySessionState } from "../core/state.js"
import {
  countPrunedMessages,
  formatBlockList,
  formatContextUsage,
  manualModeLabel,
  parseSubcommand,
  toggleManualMode
} from "./dcp-tui.js"

describe("parseSubcommand", () => {
  it("returns empty subcommand for no args", () => {
    expect(parseSubcommand("")).toEqual({ subcommand: "", subArgs: [] })
    expect(parseSubcommand("   ")).toEqual({ subcommand: "", subArgs: [] })
  })

  it("splits subcommand from trailing args", () => {
    expect(parseSubcommand("stats")).toEqual({ subcommand: "stats", subArgs: [] })
    expect(parseSubcommand("manual on")).toEqual({ subcommand: "manual", subArgs: ["on"] })
    expect(parseSubcommand("context")).toEqual({ subcommand: "context", subArgs: [] })
  })

  it("lowercases the subcommand and collapses whitespace", () => {
    expect(parseSubcommand("  MANUAL   OFF  ")).toEqual({ subcommand: "manual", subArgs: ["OFF"] })
  })

  it("preserves the raw case of trailing args", () => {
    expect(parseSubcommand("manual On")).toEqual({ subcommand: "manual", subArgs: ["On"] })
  })
})

describe("toggleManualMode", () => {
  it("'on' -> active, 'off' -> false", () => {
    expect(toggleManualMode(false, "on")).toBe("active")
    expect(toggleManualMode("active", "on")).toBe("active")
    expect(toggleManualMode("active", "off")).toBe(false)
    expect(toggleManualMode(false, "off")).toBe(false)
  })

  it("no arg toggles (false -> active, active -> false)", () => {
    expect(toggleManualMode(false)).toBe("active")
    expect(toggleManualMode("active")).toBe(false)
  })

  it("no arg collapses compress-pending back to false (source semantics)", () => {
    expect(toggleManualMode("compress-pending")).toBe(false)
  })
})

describe("manualModeLabel", () => {
  it("maps the three manual-mode states", () => {
    expect(manualModeLabel(false)).toBe("OFF")
    expect(manualModeLabel("active")).toBe("ON")
    expect(manualModeLabel("compress-pending")).toBe("PENDING")
  })
})

describe("formatBlockList", () => {
  it("sorts ascending and prefixes b", () => {
    expect(formatBlockList([3, 1, 2])).toBe("b1, b2, b3")
  })

  it("returns none for an empty set", () => {
    expect(formatBlockList([])).toBe("none")
    expect(formatBlockList(new Set<number>())).toBe("none")
  })

  it("filters non-positive / non-integer ids", () => {
    expect(formatBlockList([0, -1, 2, 1.5])).toBe("b2")
  })
})

describe("formatContextUsage", () => {
  it("handles undefined usage", () => {
    expect(formatContextUsage(undefined)).toBe("unavailable")
  })

  it("handles unknown tokens (null)", () => {
    const usage: ContextUsage = { tokens: null, contextWindow: 200000, percent: null }
    expect(formatContextUsage(usage)).toBe("200000 window (unknown usage)")
  })

  it("formats a known token count + percentage", () => {
    const usage: ContextUsage = { tokens: 50000, contextWindow: 100000, percent: 50 }
    expect(formatContextUsage(usage)).toBe("50000 / 100000 tokens (50%)")
  })
})

describe("countPrunedMessages", () => {
  it("counts only entries with an active compression block", () => {
    const state = createEmptySessionState()
    state.prune.messages.byMessageId.set("e1", { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] })
    state.prune.messages.byMessageId.set("e2", { tokenCount: 10, allBlockIds: [1], activeBlockIds: [] })
    state.prune.messages.byMessageId.set("e3", { tokenCount: 10, allBlockIds: [2], activeBlockIds: [2] })

    expect(countPrunedMessages(state)).toBe(2)
  })

  it("returns 0 for a fresh state", () => {
    expect(countPrunedMessages(createEmptySessionState())).toBe(0)
  })
})
