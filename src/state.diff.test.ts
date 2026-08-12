import { describe, expect, it } from "@effect/vitest"
import {
  allocateBlockId as srcAllocateBlockId,
  allocateRunId as srcAllocateRunId,
  applyCompressionState as srcApply
} from "../../opencode-dynamic-context-pruning/lib/compress/state.ts"
import {
  type CompressionBlock,
  type CompressionStateInput,
  createEmptySessionState,
  type PruneMessagesState,
  allocateBlockId as portAllocateBlockId,
  allocateRunId as portAllocateRunId,
  applyCompressionState as portApply,
  type SelectionResolution,
  type SessionState,
  type ToolParameterEntry
} from "./state.js"

// ---------------------------------------------------------------------------
// Differential harness: run the REAL opencode-dcp source pure fns and the
// pi-dcp port against identical inputs, assert structural parity of the
// resulting prune-messages graph. Representation-independent core (ids are
// strings in both ports; only the optional-spread for compressCallId differs
// to satisfy exactOptionalPropertyTypes).
// ---------------------------------------------------------------------------

// Source SessionState shape (subset the fns touch). We build a minimal but
// type-compatible object via the source's own createPruneMessagesState shape.
function srcCreatePruneMessagesState(): PruneMessagesState {
  return {
    byMessageId: new Map<string, { tokenCount: number; allBlockIds: number[]; activeBlockIds: number[] }>(),
    blocksById: new Map<number, CompressionBlock>(),
    activeBlockIds: new Set<number>(),
    activeByAnchorMessageId: new Map<string, number>(),
    nextBlockId: 1,
    nextRunId: 1
  }
}

function srcCreateEmptyState(): SessionState {
  return {
    sessionId: null,
    isSubAgent: false,
    manualMode: false,
    compressPermission: undefined,
    pendingManualTrigger: null,
    prune: { tools: new Map<string, number>(), messages: srcCreatePruneMessagesState() },
    nudges: {
      contextLimitAnchors: new Set<string>(),
      turnNudgeAnchors: new Set<string>(),
      iterationNudgeAnchors: new Set<string>()
    },
    stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
    compressionTiming: {
      startsByCallId: new Map<string, number>(),
      pendingByCallId: new Map<string, PendingCompressionDuration>()
    },
    toolParameters: new Map<string, ToolParameterEntry>(),
    subAgentResultCache: new Map<string, string>(),
    toolIdList: [],
    messageIds: { byRawId: new Map<string, string>(), byRef: new Map<string, string>(), nextRef: 1 },
    lastCompaction: 0,
    currentTurn: 0,
    modelContextLimit: undefined,
    systemPromptTokens: undefined
  }
}

interface PendingCompressionDuration {
  messageId: string
  callId: string
  durationMs: number
}

// Build a SelectionResolution shared by both fns.
function selection(messageIds: string[], tokens: [string, number][]): SelectionResolution {
  return {
    startReference: { kind: "message", rawIndex: 0 },
    endReference: { kind: "message", rawIndex: messageIds.length - 1 },
    messageIds,
    messageTokenById: new Map(tokens),
    toolIds: [],
    requiredBlockIds: []
  }
}

function input(startId: string, endId: string, compressMessageId: string, runId: number): CompressionStateInput {
  return {
    topic: "test",
    batchTopic: "test",
    startId,
    endId,
    mode: "range",
    runId,
    compressMessageId,
    summaryTokens: 100
  }
}

// Structural projection of a CompressionBlock for parity comparison
// (omits createdAt — Date.now() differs; omits compressCallId presence shape).
function blockSig(b: CompressionBlock) {
  return {
    blockId: b.blockId,
    runId: b.runId,
    active: b.active,
    startId: b.startId,
    endId: b.endId,
    anchorMessageId: b.anchorMessageId,
    compressMessageId: b.compressMessageId,
    consumedBlockIds: [...b.consumedBlockIds].sort((a, c) => a - c),
    parentBlockIds: [...b.parentBlockIds].sort((a, c) => a - c),
    includedBlockIds: [...b.includedBlockIds].sort((a, c) => a - c),
    effectiveMessageIds: [...b.effectiveMessageIds].sort(),
    effectiveToolIds: [...b.effectiveToolIds].sort(),
    directMessageIds: [...b.directMessageIds].sort(),
    directToolIds: [...b.directToolIds].sort(),
    compressedTokens: b.compressedTokens,
    summaryTokens: b.summaryTokens,
    summary: b.summary
  }
}

function pruneMessagesSig(p: PruneMessagesState) {
  const blocksById: Record<number, ReturnType<typeof blockSig>> = {}
  for (const [id, block] of p.blocksById) {
    blocksById[id] = blockSig(block)
  }
  return {
    nextBlockId: p.nextBlockId,
    nextRunId: p.nextRunId,
    activeBlockIds: [...p.activeBlockIds].sort((a, c) => a - c),
    activeByAnchorMessageId: Object.fromEntries(p.activeByAnchorMessageId),
    byMessageId: Object.fromEntries(
      Array.from(p.byMessageId.entries()).map(([mid, e]) => [
        mid,
        {
          tokenCount: e.tokenCount,
          allBlockIds: [...e.allBlockIds].sort((a, c) => a - c),
          activeBlockIds: [...e.activeBlockIds].sort((a, c) => a - c)
        }
      ])
    ),
    blocksById
  }
}

describe("differential: applyCompressionState vs real opencode-dcp source", () => {
  it("allocateBlockId/allocateRunId produce identical sequences", () => {
    const src = srcCreateEmptyState()
    const port = createEmptySessionState()
    const srcSeq = [srcAllocateBlockId(src), srcAllocateBlockId(src), srcAllocateRunId(src), srcAllocateRunId(src)]
    const portSeq = [
      portAllocateBlockId(port),
      portAllocateBlockId(port),
      portAllocateRunId(port),
      portAllocateRunId(port)
    ]
    expect(portSeq).toEqual(srcSeq)
    expect(port.prune.messages.nextBlockId).toBe(src.prune.messages.nextBlockId)
    expect(port.prune.messages.nextRunId).toBe(src.prune.messages.nextRunId)
  })

  it("single compression produces structurally identical prune-messages state", () => {
    const src = srcCreateEmptyState()
    const port = createEmptySessionState()

    const srcBlockId = srcAllocateBlockId(src)
    const portBlockId = portAllocateBlockId(port)
    const srcRunId = srcAllocateRunId(src)
    const portRunId = portAllocateRunId(port)
    expect(portBlockId).toBe(srcBlockId)
    expect(portRunId).toBe(srcRunId)

    const sel = selection(
      ["e1", "e2"],
      [
        ["e1", 50],
        ["e2", 60]
      ]
    )

    const srcResult = srcApply(src, input("e1", "e2", "cm-1", srcRunId), sel, "e1", srcBlockId, "summary-1", [])
    const portResult = portApply(port, input("e1", "e2", "cm-1", portRunId), sel, "e1", portBlockId, "summary-1", [])

    expect(portResult).toEqual(srcResult)
    expect(pruneMessagesSig(port.prune.messages)).toEqual(pruneMessagesSig(src.prune.messages))
  })

  it("nested block (older-in-newer) produces identical nesting + anchor maps", () => {
    const src = srcCreateEmptyState()
    const port = createEmptySessionState()

    // block 1: covers e1,e2 anchored at e1
    const b1src = srcAllocateBlockId(src),
      b1port = portAllocateBlockId(port)
    const r1src = srcAllocateRunId(src),
      r1port = portAllocateRunId(port)
    expect(b1port).toBe(b1src)
    expect(r1port).toBe(r1src)
    srcApply(
      src,
      input("e1", "e2", "cm-1", r1src),
      selection(
        ["e1", "e2"],
        [
          ["e1", 50],
          ["e2", 60]
        ]
      ),
      "e1",
      b1src,
      "summary-1",
      []
    )
    portApply(
      port,
      input("e1", "e2", "cm-1", r1port),
      selection(
        ["e1", "e2"],
        [
          ["e1", 50],
          ["e2", 60]
        ]
      ),
      "e1",
      b1port,
      "summary-1",
      []
    )

    // block 2: covers e2 anchored at e2, consumes block 1
    const b2src = srcAllocateBlockId(src),
      b2port = portAllocateBlockId(port)
    const r2src = srcAllocateRunId(src),
      r2port = portAllocateRunId(port)
    expect(b2port).toBe(b2src)
    expect(r2port).toBe(r2src)
    const srcResult2 = srcApply(
      src,
      input("e1", "e2", "cm-2", r2src),
      selection(["e2"], [["e2", 60]]),
      "e2",
      b2src,
      "summary-2",
      [b1src]
    )
    const portResult2 = portApply(
      port,
      input("e1", "e2", "cm-2", r2port),
      selection(["e2"], [["e2", 60]]),
      "e2",
      b2port,
      "summary-2",
      [b1port]
    )

    expect(portResult2).toEqual(srcResult2)
    expect(pruneMessagesSig(port.prune.messages)).toEqual(pruneMessagesSig(src.prune.messages))

    // explicit nesting assertions (graph parity, not deep eq)
    expect(port.prune.messages.blocksById.get(b1port)?.active).toBe(false)
    expect(port.prune.messages.blocksById.get(b1port)?.parentBlockIds).toContain(b2port)
    expect(port.prune.messages.blocksById.get(b2port)?.consumedBlockIds).toContain(b1port)
    expect(port.prune.messages.activeBlockIds.has(b1port)).toBe(false)
    expect(port.prune.messages.activeBlockIds.has(b2port)).toBe(true)
    expect(port.prune.messages.activeByAnchorMessageId.get("e2")).toBe(b2port)
    expect(port.prune.messages.activeByAnchorMessageId.get("e1")).toBeUndefined()
  })

  it("three-block overlapping run produces identical graph", () => {
    const src = srcCreateEmptyState()
    const port = createEmptySessionState()

    // block A: e1..e3 anchored e1
    const aS = srcAllocateBlockId(src),
      aP = portAllocateBlockId(port)
    const raS = srcAllocateRunId(src),
      raP = portAllocateRunId(port)
    srcApply(
      src,
      input("e1", "e3", "cmA", raS),
      selection(
        ["e1", "e2", "e3"],
        [
          ["e1", 10],
          ["e2", 20],
          ["e3", 30]
        ]
      ),
      "e1",
      aS,
      "A",
      []
    )
    portApply(
      port,
      input("e1", "e3", "cmA", raP),
      selection(
        ["e1", "e2", "e3"],
        [
          ["e1", 10],
          ["e2", 20],
          ["e3", 30]
        ]
      ),
      "e1",
      aP,
      "A",
      []
    )

    // block B: e2..e3 anchored e2, consumes A
    const bS = srcAllocateBlockId(src),
      bP = portAllocateBlockId(port)
    const rbS = srcAllocateRunId(src),
      rbP = portAllocateRunId(port)
    srcApply(
      src,
      input("e2", "e3", "cmB", rbS),
      selection(
        ["e2", "e3"],
        [
          ["e2", 20],
          ["e3", 30]
        ]
      ),
      "e2",
      bS,
      "B",
      [aS]
    )
    portApply(
      port,
      input("e2", "e3", "cmB", rbP),
      selection(
        ["e2", "e3"],
        [
          ["e2", 20],
          ["e3", 30]
        ]
      ),
      "e2",
      bP,
      "B",
      [aP]
    )

    // block C: e3 only anchored e3, consumes B
    const cS = srcAllocateBlockId(src),
      cP = portAllocateBlockId(port)
    const rcS = srcAllocateRunId(src),
      rcP = portAllocateRunId(port)
    srcApply(src, input("e3", "e3", "cmC", rcS), selection(["e3"], [["e3", 30]]), "e3", cS, "C", [bS])
    portApply(port, input("e3", "e3", "cmC", rcP), selection(["e3"], [["e3", 30]]), "e3", cP, "C", [bP])

    expect(pruneMessagesSig(port.prune.messages)).toEqual(pruneMessagesSig(src.prune.messages))
    // only C remains active
    expect([...port.prune.messages.activeBlockIds]).toEqual([cP])
  })
})
