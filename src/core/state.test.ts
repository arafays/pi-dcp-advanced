import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  allocateBlockId,
  allocateRunId,
  applyCompressionState,
  type CompressionStateInput,
  createEmptySessionState,
  DcpState,
  DcpStateLive,
  hydrateState,
  PersistedStateSchema,
  type SelectionResolution,
  type SessionState,
  serializeState
} from "./state.js"

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

function input(startId: string, endId: string, compressMessageId: string, state: SessionState): CompressionStateInput {
  return {
    topic: "test",
    batchTopic: "test",
    startId,
    endId,
    mode: "range",
    runId: allocateRunId(state),
    compressMessageId,
    summaryTokens: 100
  }
}

it("round-trips serialize -> schema-decode -> hydrate with Map/Set equality", () => {
  const state = createEmptySessionState("session-1")
  state.manualMode = "active"
  state.prune.tools.set("tool-call-1", 42)
  state.prune.tools.set("tool-call-2", 7)
  state.nudges.contextLimitAnchors.add("anchor-1")
  state.nudges.turnNudgeAnchors.add("anchor-2")

  const blockId = allocateBlockId(state)
  applyCompressionState(
    state,
    input("e1", "e2", "cm-1", state),
    selection(
      ["e1", "e2"],
      [
        ["e1", 50],
        ["e2", 60]
      ]
    ),
    "e1",
    blockId,
    "summary-1",
    []
  )

  const persisted = serializeState(state)
  const decoded = Schema.decodeUnknownSync(PersistedStateSchema)(persisted)
  const hydrated = hydrateState(decoded)

  expect(hydrated.sessionId).toBe("session-1")
  expect(hydrated.manualMode).toBe("active")
  expect([...hydrated.prune.tools.entries()]).toEqual([...state.prune.tools.entries()])
  expect([...hydrated.prune.messages.byMessageId.keys()]).toEqual([...state.prune.messages.byMessageId.keys()])
  expect([...hydrated.prune.messages.blocksById.keys()]).toEqual([...state.prune.messages.blocksById.keys()])
  expect([...hydrated.prune.messages.activeBlockIds]).toEqual([...state.prune.messages.activeBlockIds])
  expect([...hydrated.prune.messages.activeByAnchorMessageId.entries()]).toEqual([
    ...state.prune.messages.activeByAnchorMessageId.entries()
  ])
  expect([...hydrated.nudges.contextLimitAnchors]).toEqual([...state.nudges.contextLimitAnchors])
  expect([...hydrated.nudges.turnNudgeAnchors]).toEqual([...state.nudges.turnNudgeAnchors])
  expect(hydrated.stats).toEqual(state.stats)

  const hydratedBlock = hydrated.prune.messages.blocksById.get(blockId)
  const originalBlock = state.prune.messages.blocksById.get(blockId)
  expect(hydratedBlock).toBeDefined()
  expect(originalBlock).toBeDefined()
  expect(hydratedBlock?.summary).toBe(originalBlock?.summary)
  expect(hydratedBlock?.effectiveMessageIds).toEqual(originalBlock?.effectiveMessageIds)
})

it("nests older block inside newer overlapping block (consumed + parent ids)", () => {
  const state = createEmptySessionState()

  const block1 = allocateBlockId(state)
  applyCompressionState(
    state,
    input("e1", "e2", "cm-1", state),
    selection(
      ["e1", "e2"],
      [
        ["e1", 50],
        ["e2", 60]
      ]
    ),
    "e1",
    block1,
    "summary-1",
    []
  )

  const block2 = allocateBlockId(state)
  applyCompressionState(
    state,
    input("e1", "e2", "cm-2", state),
    selection(["e2"], [["e2", 60]]),
    "e2",
    block2,
    "summary-2",
    [block1]
  )

  const older = state.prune.messages.blocksById.get(block1)
  const newer = state.prune.messages.blocksById.get(block2)

  expect(older).toBeDefined()
  expect(newer).toBeDefined()
  expect(older?.active).toBe(false)
  expect(older?.parentBlockIds).toContain(block2)
  expect(newer?.consumedBlockIds).toContain(block1)
  expect(state.prune.messages.activeBlockIds.has(block1)).toBe(false)
  expect(state.prune.messages.activeBlockIds.has(block2)).toBe(true)
})

it("updates activeByAnchorMessageId when a block is consumed", () => {
  const state = createEmptySessionState()

  const block1 = allocateBlockId(state)
  applyCompressionState(
    state,
    input("e1", "e2", "cm-1", state),
    selection(
      ["e1", "e2"],
      [
        ["e1", 50],
        ["e2", 60]
      ]
    ),
    "e1",
    block1,
    "summary-1",
    []
  )

  expect(state.prune.messages.activeByAnchorMessageId.get("e1")).toBe(block1)

  const block2 = allocateBlockId(state)
  applyCompressionState(
    state,
    input("e1", "e2", "cm-2", state),
    selection(["e2"], [["e2", 60]]),
    "e2",
    block2,
    "summary-2",
    [block1]
  )

  expect(state.prune.messages.activeByAnchorMessageId.get("e2")).toBe(block2)
  expect(state.prune.messages.activeByAnchorMessageId.get("e1")).toBeUndefined()
})

it.effect("DcpState service get/update round-trips through a Ref", () =>
  Effect.gen(function* () {
    const dcp = yield* DcpState
    const initial = yield* dcp.get()
    expect(initial.currentTurn).toBe(0)

    yield* dcp.update((s) => ({ ...s, currentTurn: 5 }))

    const updated = yield* dcp.get()
    expect(updated.currentTurn).toBe(5)
  }).pipe(Effect.provide(DcpStateLive))
)
