import type {
  CustomToolCallEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  allocateBlockId,
  allocateRunId,
  applyCompressionState,
  type CompressionStateInput,
  createEmptySessionState,
  DcpState,
  makeDcpState,
  type SelectionResolution,
  type SessionState
} from "./state.js"
import { onToolCall, onToolExecutionEnd, onToolExecutionStart, onToolResult } from "./tracking.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const toolCall = (toolCallId: string, toolName: string, input: Record<string, unknown>): CustomToolCallEvent => ({
  type: "tool_call",
  toolCallId,
  toolName,
  input
})

const toolResult = (toolCallId: string, toolName: string, isError: boolean): ToolResultEvent => ({
  type: "tool_result",
  toolCallId,
  toolName,
  input: {},
  content: [],
  isError,
  details: undefined
})

const executionStart = (toolCallId: string, toolName: string): ToolExecutionStartEvent => ({
  type: "tool_execution_start",
  toolCallId,
  toolName,
  args: {}
})

const executionEnd = (toolCallId: string, toolName: string): ToolExecutionEndEvent => ({
  type: "tool_execution_end",
  toolCallId,
  toolName,
  result: null,
  isError: false
})

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

function compressInput(
  startId: string,
  endId: string,
  compressMessageId: string,
  compressCallId: string,
  state: SessionState
): CompressionStateInput {
  return {
    topic: "test",
    batchTopic: "test",
    startId,
    endId,
    mode: "range",
    runId: allocateRunId(state),
    compressMessageId,
    compressCallId,
    summaryTokens: 100
  }
}

function seedBlock(state: SessionState, compressCallId: string, compressMessageId: string): number {
  const blockId = allocateBlockId(state)
  applyCompressionState(
    state,
    compressInput("e1", "e2", compressMessageId, compressCallId, state),
    selection(
      ["e1", "e2"],
      [
        ["e1", 50],
        ["e2", 60]
      ]
    ),
    "e1",
    blockId,
    "summary",
    []
  )
  return blockId
}

// `DcpStateLive` builds its Ref from a single SessionState object captured at
// module load, and `Layer.effect` is memoized — so providing it across tests
// would leak mutated state. Build a genuinely fresh Ref over a fresh state per
// test instead.
const freshState = Layer.fresh(
  Layer.effect(
    DcpState,
    Effect.gen(function* () {
      return yield* makeDcpState(createEmptySessionState())
    })
  )
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.effect("records one toolParameters entry per toolCallId with turn and status", () =>
  Effect.gen(function* () {
    const dcp = yield* DcpState

    yield* onToolCall(toolCall("t1", "read", { path: "a.txt" }), dcp)
    yield* onToolResult(toolResult("t1", "read", false), dcp)
    yield* onToolExecutionEnd(executionEnd("t1", "read"), dcp)
    yield* onToolCall(toolCall("t2", "bash", { command: "ls" }), dcp)
    yield* onToolResult(toolResult("t2", "bash", true), dcp)

    const s = yield* dcp.get()
    expect(s.toolParameters.size).toBe(2)
    expect(s.toolIdList).toEqual(["t1", "t2"])
    expect(s.currentTurn).toBe(1)

    const t1 = s.toolParameters.get("t1")
    expect(t1?.tool).toBe("read")
    expect(t1?.status).toBe("completed")
    expect(t1?.turn).toBe(0)

    const t2 = s.toolParameters.get("t2")
    expect(t2?.tool).toBe("bash")
    expect(t2?.status).toBe("error")
    expect(t2?.turn).toBe(1)
    expect(t2?.error).toBe("Tool execution failed")
  }).pipe(Effect.provide(freshState))
)

it.effect("creates a defensive entry when a tool_result arrives without a tool_call", () =>
  Effect.gen(function* () {
    const dcp = yield* DcpState

    yield* onToolResult(toolResult("t9", "grep", true), dcp)

    const s = yield* dcp.get()
    const entry = s.toolParameters.get("t9")
    expect(entry?.tool).toBe("grep")
    expect(entry?.status).toBe("error")
    expect(entry?.turn).toBe(0)
    expect(s.toolIdList).toContain("t9")
  }).pipe(Effect.provide(freshState))
)

it.effect("records a compress execution start (and ignores non-compress tools)", () =>
  Effect.gen(function* () {
    const dcp = yield* DcpState

    yield* onToolExecutionStart(executionStart("c1", "compress"), dcp)
    yield* onToolExecutionStart(executionStart("b1", "bash"), dcp)

    const s = yield* dcp.get()
    expect(s.compressionTiming.startsByCallId.has("c1")).toBe(true)
    expect(s.compressionTiming.startsByCallId.has("b1")).toBe(false)
  }).pipe(Effect.provide(freshState))
)

it.effect("applies compress duration to an existing matching block", () =>
  Effect.gen(function* () {
    const dcp = yield* DcpState
    let blockId = 0
    yield* dcp.update((s) => {
      blockId = seedBlock(s, "c1", "msg-1")
      s.compressionTiming.startsByCallId.set("c1", 0)
      return s
    })

    yield* onToolExecutionEnd(executionEnd("c1", "compress"), dcp)

    const s = yield* dcp.get()
    const block = s.prune.messages.blocksById.get(blockId)
    expect(block).toBeDefined()
    expect(block?.durationMs ?? -1).toBeGreaterThan(0)
    expect(s.compressionTiming.startsByCallId.has("c1")).toBe(false)
    expect(s.compressionTiming.pendingByCallId.size).toBe(0)
  }).pipe(Effect.provide(freshState))
)

it.effect("records a pending compress duration when no block matches yet", () =>
  Effect.gen(function* () {
    const dcp = yield* DcpState
    yield* dcp.update((s) => {
      s.compressionTiming.startsByCallId.set("c2", 0)
      return s
    })

    yield* onToolExecutionEnd(executionEnd("c2", "compress"), dcp)

    const s = yield* dcp.get()
    expect(s.compressionTiming.startsByCallId.has("c2")).toBe(false)
    const pending = s.compressionTiming.pendingByCallId.get("c2")
    expect(pending).toBeDefined()
    expect(pending?.durationMs ?? -1).toBeGreaterThan(0)
    expect(pending?.callId).toBe("c2")
  }).pipe(Effect.provide(freshState))
)
