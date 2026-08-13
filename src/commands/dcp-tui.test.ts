import type { ContextUsage } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "@effect/vitest"
import { createEmptySessionState } from "../core/state.js"
import {
  computeSessionStats,
  countPrunedMessages,
  formatBlockList,
  formatCompressionRatio,
  formatContextUsage,
  formatDuration,
  formatTokenCount,
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

describe("formatTokenCount", () => {
  it("keeps sub-1000 token counts verbatim", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(999)).toBe("999")
  })

  it("abbreviates >= 1000 tokens", () => {
    expect(formatTokenCount(1000)).toBe("1K")
    expect(formatTokenCount(1500)).toBe("1.5K")
    expect(formatTokenCount(123456)).toBe("123.5K")
  })
})

describe("formatDuration", () => {
  it("formats sub-second and second-scale durations", () => {
    expect(formatDuration(0)).toBe("0 ms")
    expect(formatDuration(900)).toBe("900 ms")
    expect(formatDuration(1500)).toBe("1.5 s")
  })

  it("formats minute and hour scale durations", () => {
    expect(formatDuration(125000)).toBe("2m 5s")
    expect(formatDuration(3723000)).toBe("1h 2m 3s")
  })

  it("clamps negative inputs", () => {
    expect(formatDuration(-500)).toBe("0 ms")
  })
})

describe("formatCompressionRatio", () => {
  it("returns 0:1 when nothing saved", () => {
    expect(formatCompressionRatio(0, 100)).toBe("0:1")
  })

  it("returns ∞:1 when there is no summary size", () => {
    expect(formatCompressionRatio(500, 0)).toBe("∞:1")
  })

  it("rounds the saved:summary ratio", () => {
    expect(formatCompressionRatio(1000, 250)).toBe("4:1")
    expect(formatCompressionRatio(1000, 300)).toBe("3:1")
  })
})

describe("computeSessionStats", () => {
  it("aggregates totals, summary tokens, and duration from active blocks", () => {
    const state = createEmptySessionState()
    state.stats.totalPruneTokens = 5000
    state.prune.tools.set("t1", 100)
    state.prune.messages.byMessageId.set("e1", { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] })
    state.prune.messages.blocksById.set(1, {
      blockId: 1,
      runId: 1,
      active: true,
      deactivatedByUser: false,
      compressedTokens: 5000,
      summaryTokens: 1000,
      durationMs: 2500,
      topic: "t",
      startId: "e1",
      endId: "e1",
      anchorMessageId: "e1",
      compressMessageId: "",
      includedBlockIds: [],
      consumedBlockIds: [],
      parentBlockIds: [],
      directMessageIds: ["e1"],
      directToolIds: [],
      effectiveMessageIds: ["e1"],
      effectiveToolIds: [],
      createdAt: 0,
      summary: "s"
    })

    expect(computeSessionStats(state)).toEqual({
      tokensSaved: 5000,
      summaryTokens: 1000,
      compressionRatio: "5:1",
      compressionDurationMs: 2500,
      toolsPruned: 1,
      messagesPruned: 1
    })
  })

  it("ignores inactive blocks", () => {
    const state = createEmptySessionState()
    state.stats.totalPruneTokens = 3000
    state.prune.messages.blocksById.set(1, {
      blockId: 1,
      runId: 1,
      active: false,
      deactivatedByUser: false,
      compressedTokens: 3000,
      summaryTokens: 900,
      durationMs: 5000,
      topic: "t",
      startId: "e1",
      endId: "e1",
      anchorMessageId: "e1",
      compressMessageId: "",
      includedBlockIds: [],
      consumedBlockIds: [],
      parentBlockIds: [],
      directMessageIds: [],
      directToolIds: [],
      effectiveMessageIds: [],
      effectiveToolIds: [],
      createdAt: 0,
      summary: "s"
    })

    const stats = computeSessionStats(state)
    expect(stats.summaryTokens).toBe(0)
    expect(stats.compressionDurationMs).toBe(0)
    expect(stats.tokensSaved).toBe(3000)
  })
})
