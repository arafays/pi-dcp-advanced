import { describe, expect, it } from "@effect/vitest"
import {
  deduplicate as srcDeduplicate,
  purgeErrors as srcPurgeErrors
} from "../../opencode-dynamic-context-pruning/lib/strategies/index.ts"
import { defaultConfig, type ResolvedConfig } from "./config.js"
import { createEmptySessionState, type SessionState, type ToolParameterEntry } from "./state.js"
import { deduplicate, purgeErrors } from "./strategies.js"

// ---------------------------------------------------------------------------
// Differential harness: run the REAL opencode-dcp source strategies and the
// pi-dcp port against identical inputs, assert identical state.prune.tools and
// state.stats.totalPruneTokens. Both strategies are pure mark-then-apply and
// only touch toolCallId-keyed maps, so they are representation-independent.
// The source signature is (state, logger, config, messages) but `logger` is
// only used for debug logging (here a no-op) and `messages` is never read.
// ---------------------------------------------------------------------------

const logger = { debug: (_message: string) => {} }

function entry(
  tool: string,
  parameters: unknown,
  status: "pending" | "running" | "completed" | "error",
  turn: number,
  tokenCount = 100
): ToolParameterEntry {
  return { tool, parameters, status, turn, tokenCount }
}

function makeState(entries: Array<[string, ToolParameterEntry]>, currentTurn = 0): SessionState {
  const state = createEmptySessionState()
  for (const [id, e] of entries) {
    state.toolParameters.set(id, e)
  }
  state.toolIdList = entries.map(([id]) => id)
  state.currentTurn = currentTurn
  return state
}

function pruneSig(state: SessionState) {
  return {
    tools: [...state.prune.tools.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    totalPruneTokens: state.stats.totalPruneTokens
  }
}

const reads = (): Array<[string, ToolParameterEntry]> => [
  ["r1", entry("read", { filePath: "a.txt" }, "completed", 0)],
  ["r2", entry("read", { filePath: "a.txt" }, "completed", 1)]
]

describe("differential: strategies vs real opencode-dcp source", () => {
  it("deduplicate prunes identical older tool calls identically", () => {
    const src = makeState(reads())
    const port = makeState(reads())

    srcDeduplicate(src, logger, defaultConfig, [])
    deduplicate(port, defaultConfig)

    expect(pruneSig(port)).toEqual(pruneSig(src))
  })

  it("deduplicate skips protected tools identically", () => {
    const config: ResolvedConfig = {
      ...defaultConfig,
      strategies: {
        ...defaultConfig.strategies,
        deduplication: { ...defaultConfig.strategies.deduplication, protectedTools: ["read"] }
      }
    }
    const src = makeState(reads())
    const port = makeState(reads())

    srcDeduplicate(src, logger, config, [])
    deduplicate(port, config)

    expect(pruneSig(port)).toEqual(pruneSig(src))
  })

  it("deduplicate excludes already-pruned ids identically", () => {
    const three = (): Array<[string, ToolParameterEntry]> => [
      ["r1", entry("read", { filePath: "a.txt" }, "completed", 0)],
      ["r2", entry("read", { filePath: "a.txt" }, "completed", 1)],
      ["r3", entry("read", { filePath: "a.txt" }, "completed", 2)]
    ]
    const src = makeState(three())
    const port = makeState(three())
    src.prune.tools.set("r1", 100)
    port.prune.tools.set("r1", 100)

    srcDeduplicate(src, logger, defaultConfig, [])
    deduplicate(port, defaultConfig)

    expect(pruneSig(port)).toEqual(pruneSig(src))
  })

  it("purgeErrors marks errored tools past N turns identically", () => {
    const config: ResolvedConfig = {
      ...defaultConfig,
      strategies: {
        ...defaultConfig.strategies,
        purgeErrors: { ...defaultConfig.strategies.purgeErrors, turns: 2 }
      }
    }
    const errored = (): Array<[string, ToolParameterEntry]> => [["bash-1", entry("bash", {}, "error", 0, 200)]]

    const src = makeState(errored(), 5)
    const port = makeState(errored(), 5)
    srcPurgeErrors(src, logger, config, [])
    purgeErrors(port, config)
    expect(pruneSig(port)).toEqual(pruneSig(src))

    // Within threshold -> neither prunes.
    const srcFresh = makeState([["bash-1", entry("bash", {}, "error", 4, 200)]], 5)
    const portFresh = makeState([["bash-1", entry("bash", {}, "error", 4, 200)]], 5)
    srcPurgeErrors(srcFresh, logger, config, [])
    purgeErrors(portFresh, config)
    expect(pruneSig(portFresh)).toEqual(pruneSig(srcFresh))
  })

  it("purgeErrors skips protected tools identically", () => {
    const config: ResolvedConfig = {
      ...defaultConfig,
      strategies: {
        ...defaultConfig.strategies,
        purgeErrors: { ...defaultConfig.strategies.purgeErrors, protectedTools: ["bash"] }
      }
    }
    const src = makeState([["bash-1", entry("bash", {}, "error", 0, 200)]], 5)
    const port = makeState([["bash-1", entry("bash", {}, "error", 0, 200)]], 5)

    srcPurgeErrors(src, logger, config, [])
    purgeErrors(port, config)

    expect(pruneSig(port)).toEqual(pruneSig(src))
  })

  it("manual mode + automaticStrategies=false skips both identically", () => {
    const config: ResolvedConfig = {
      ...defaultConfig,
      manualMode: { ...defaultConfig.manualMode, automaticStrategies: false }
    }
    const seeded = (): Array<[string, ToolParameterEntry]> => [
      ["r1", entry("read", { filePath: "a.txt" }, "completed", 0)],
      ["r2", entry("read", { filePath: "a.txt" }, "completed", 1)],
      ["bash-1", entry("bash", {}, "error", 0)]
    ]
    const src = makeState(seeded(), 10)
    const port = makeState(seeded(), 10)
    src.manualMode = "active"
    port.manualMode = "active"

    srcDeduplicate(src, logger, config, [])
    srcPurgeErrors(src, logger, config, [])
    deduplicate(port, config)
    purgeErrors(port, config)

    expect(pruneSig(port)).toEqual(pruneSig(src))
  })
})
