import { describe, expect, it } from "@effect/vitest"
import { defaultConfig, type ResolvedConfig } from "../core/config.js"
import { createEmptySessionState, type SessionState, type ToolParameterEntry } from "../core/state.js"
import { deduplicate, purgeErrors } from "./strategies.js"

function entry(
  tool: string,
  parameters: unknown,
  status: "pending" | "running" | "completed" | "error",
  turn: number,
  tokenCount = 100
): ToolParameterEntry {
  return { tool, parameters, status, turn, tokenCount }
}

function seedState(entries: Array<[string, ToolParameterEntry]>, currentTurn = 0): SessionState {
  const state = createEmptySessionState()
  for (const [id, e] of entries) {
    state.toolParameters.set(id, e)
  }
  state.toolIdList = entries.map(([id]) => id)
  state.currentTurn = currentTurn
  return state
}

function pruneIds(state: SessionState): string[] {
  return [...state.prune.tools.keys()].sort()
}

describe("deduplicate", () => {
  it("prunes older identical tool calls, keeping the most recent", () => {
    const state = seedState([
      ["r1", entry("read", { filePath: "a.txt" }, "completed", 0)],
      ["r2", entry("read", { filePath: "a.txt" }, "completed", 1)],
      ["r3", entry("read", { filePath: "b.txt" }, "completed", 2)]
    ])

    deduplicate(state, defaultConfig)

    expect(pruneIds(state)).toEqual(["r1"])
    expect(state.prune.tools.has("r2")).toBe(false)
    expect(state.prune.tools.has("r3")).toBe(false)
    expect(state.prune.tools.get("r1")).toBe(100)
    expect(state.stats.totalPruneTokens).toBe(100)
  })

  it("ignores tool calls whose parameters differ (no false duplicates)", () => {
    const state = seedState([
      ["r1", entry("read", { filePath: "a.txt" }, "completed", 0)],
      ["r2", entry("read", { filePath: "b.txt" }, "completed", 1)]
    ])

    deduplicate(state, defaultConfig)

    expect(state.prune.tools.size).toBe(0)
    expect(state.stats.totalPruneTokens).toBe(0)
  })

  it("skips protected tools", () => {
    const state = seedState([
      ["r1", entry("read", { filePath: "a.txt" }, "completed", 0)],
      ["r2", entry("read", { filePath: "a.txt" }, "completed", 1)]
    ])
    const config: ResolvedConfig = {
      ...defaultConfig,
      strategies: {
        ...defaultConfig.strategies,
        deduplication: { ...defaultConfig.strategies.deduplication, protectedTools: ["read"] }
      }
    }

    deduplicate(state, config)

    expect(state.prune.tools.size).toBe(0)
  })

  it("skips tools whose file paths are protected", () => {
    const state = seedState([
      ["r1", entry("read", { filePath: "src/secret/notes.md" }, "completed", 0)],
      ["r2", entry("read", { filePath: "src/secret/notes.md" }, "completed", 1)]
    ])
    const config: ResolvedConfig = { ...defaultConfig, protectedFilePatterns: ["**/secret/**"] }

    deduplicate(state, config)

    expect(state.prune.tools.size).toBe(0)
  })

  it("excludes ids that are already pruned (no double-processing)", () => {
    const state = seedState([
      ["r1", entry("read", { filePath: "a.txt" }, "completed", 0)],
      ["r2", entry("read", { filePath: "a.txt" }, "completed", 1)],
      ["r3", entry("read", { filePath: "a.txt" }, "completed", 2)]
    ])
    state.prune.tools.set("r1", 100)

    deduplicate(state, defaultConfig)

    // r1 already pruned; r2 pruned as duplicate of r3 (r3 kept).
    expect(pruneIds(state)).toEqual(["r1", "r2"])
    expect(state.prune.tools.has("r3")).toBe(false)
  })

  it("skips both strategies when manual mode is active and automaticStrategies is false", () => {
    const state = seedState(
      [
        ["r1", entry("read", { filePath: "a.txt" }, "completed", 0)],
        ["r2", entry("read", { filePath: "a.txt" }, "completed", 1)],
        ["bash-1", entry("bash", {}, "error", 0)]
      ],
      10
    )
    state.manualMode = "active"
    const config: ResolvedConfig = {
      ...defaultConfig,
      manualMode: { ...defaultConfig.manualMode, automaticStrategies: false }
    }

    deduplicate(state, config)
    purgeErrors(state, config)

    expect(state.prune.tools.size).toBe(0)
    expect(state.stats.totalPruneTokens).toBe(0)
  })
})

describe("purgeErrors", () => {
  it("marks errored tool calls past N turns but not before", () => {
    const old = seedState([["bash-1", entry("bash", {}, "error", 0, 200)]], 5)
    const config: ResolvedConfig = {
      ...defaultConfig,
      strategies: { ...defaultConfig.strategies, purgeErrors: { ...defaultConfig.strategies.purgeErrors, turns: 2 } }
    }

    purgeErrors(old, config)
    expect(pruneIds(old)).toEqual(["bash-1"])
    expect(old.prune.tools.get("bash-1")).toBe(200)
    expect(old.stats.totalPruneTokens).toBe(200)

    // Within threshold -> not pruned.
    const fresh = seedState([["bash-1", entry("bash", {}, "error", 4, 200)]], 5)
    purgeErrors(fresh, config)
    expect(fresh.prune.tools.size).toBe(0)
    expect(fresh.stats.totalPruneTokens).toBe(0)
  })

  it("ignores completed tools (only errored tools are pruned)", () => {
    const state = seedState([["bash-1", entry("bash", {}, "completed", 0, 200)]], 5)

    purgeErrors(state, defaultConfig)

    expect(state.prune.tools.size).toBe(0)
  })

  it("skips protected tools", () => {
    const state = seedState([["bash-1", entry("bash", {}, "error", 0, 200)]], 5)
    const config: ResolvedConfig = {
      ...defaultConfig,
      strategies: {
        ...defaultConfig.strategies,
        purgeErrors: { ...defaultConfig.strategies.purgeErrors, protectedTools: ["bash"] }
      }
    }

    purgeErrors(state, config)

    expect(state.prune.tools.size).toBe(0)
  })

  it("respects the enabled flag", () => {
    const state = seedState([["bash-1", entry("bash", {}, "error", 0, 200)]], 5)
    const config: ResolvedConfig = {
      ...defaultConfig,
      strategies: {
        ...defaultConfig.strategies,
        purgeErrors: { ...defaultConfig.strategies.purgeErrors, enabled: false }
      }
    }

    purgeErrors(state, config)

    expect(state.prune.tools.size).toBe(0)
  })
})
