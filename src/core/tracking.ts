import type {
  ToolCallEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { attachCompressionDuration, type DcpStateService, type ToolParameterEntry, type ToolStatus } from "./state.js"

// ---------------------------------------------------------------------------
// Tool-call tracking (WP3)
//
// Event-driven handlers that keep DcpState.toolParameters / toolIdList /
// currentTurn in sync, plus compress-tool timing. Each handler is a pure Effect
// over the DcpState service (Ref-backed), so it is trivially testable with
// DcpStateLive.
//
// tokenCount is intentionally left undefined: the port does not add a tokenizer
// dependency, and WP8 nudge thresholds use ctx.getContextUsage() rather than
// these per-tool counts. WP3 therefore records tool/parameters/status/turn only.
// ---------------------------------------------------------------------------

/**
 * Record (or refresh) a tool-call entry keyed by toolCallId. The tool-call
 * event's `input` is NOT mutated — it is copied into the entry for tracking.
 * An existing entry keeps its prior status/error/tokenCount on refresh;
 * otherwise the entry starts as "pending".
 */
export const onToolCall = Effect.fn("Tracking.onToolCall")(function* (event: ToolCallEvent, state: DcpStateService) {
  yield* state.update((s) => {
    const existing = s.toolParameters.get(event.toolCallId)
    const entry: ToolParameterEntry = {
      tool: event.toolName,
      parameters: event.input,
      status: existing?.status ?? "pending",
      turn: s.currentTurn
    }
    if (existing?.error !== undefined) {
      entry.error = existing.error
    }
    if (existing?.tokenCount !== undefined) {
      entry.tokenCount = existing.tokenCount
    }
    s.toolParameters.set(event.toolCallId, entry)
    if (!s.toolIdList.includes(event.toolCallId)) {
      s.toolIdList.push(event.toolCallId)
    }
    return s
  })
})

/**
 * Finalize a tool result: mark the entry "completed" or "error". If no entry
 * exists yet (e.g. a result arrives without a preceding tool_call), create a
 * minimal entry so the prune/dedup maps stay complete.
 */
export const onToolResult = Effect.fn("Tracking.onToolResult")(function* (
  event: ToolResultEvent,
  state: DcpStateService
) {
  yield* state.update((s) => {
    const status: ToolStatus = event.isError ? "error" : "completed"
    const existing = s.toolParameters.get(event.toolCallId)

    if (existing === undefined) {
      const entry: ToolParameterEntry = {
        tool: event.toolName,
        parameters: event.input,
        status,
        turn: s.currentTurn
      }
      if (event.isError) {
        entry.error = "Tool execution failed"
      }
      s.toolParameters.set(event.toolCallId, entry)
      if (!s.toolIdList.includes(event.toolCallId)) {
        s.toolIdList.push(event.toolCallId)
      }
    } else {
      existing.status = status
      if (event.isError) {
        existing.error = "Tool execution failed"
      }
    }
    return s
  })
})

/**
 * Record the wall-clock start of a compress tool execution so its duration can
 * be computed when it ends. Non-compress tools are a no-op.
 */
export const onToolExecutionStart = Effect.fn("Tracking.onToolExecutionStart")(function* (
  event: ToolExecutionStartEvent,
  state: DcpStateService
) {
  yield* state.update((s) => {
    if (event.toolName === "compress") {
      s.compressionTiming.startsByCallId.set(event.toolCallId, Date.now())
    }
    return s
  })
})

/**
 * Advance the turn counter on each tool execution end (PLAN's simplest turn
 * boundary), and — for the compress tool — finalize its execution duration:
 *
 *   1. compute durationMs from the recorded start (defensive: 0 if no start);
 *   2. apply it immediately to any already-created CompressionBlock whose
 *      compressCallId matches;
 *   3. otherwise record a pending duration in pendingByCallId for later
 *      reconciliation (WP6/WP11), since the block is normally created after the
 *      compress call has returned its summary.
 */
export const onToolExecutionEnd = Effect.fn("Tracking.onToolExecutionEnd")(function* (
  event: ToolExecutionEndEvent,
  state: DcpStateService
) {
  yield* state.update((s) => {
    s.currentTurn += 1

    if (event.toolName !== "compress") {
      return s
    }

    const startedAt = s.compressionTiming.startsByCallId.get(event.toolCallId)
    s.compressionTiming.startsByCallId.delete(event.toolCallId)
    const durationMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt)

    let applied = 0
    for (const block of s.prune.messages.blocksById.values()) {
      if (block.compressCallId !== event.toolCallId) {
        continue
      }
      applied += attachCompressionDuration(s.prune.messages, block.compressMessageId, event.toolCallId, durationMs)
    }

    if (applied === 0) {
      // The compression block is not created yet (it is created after the
      // compress call returns). Record the duration keyed by toolCallId; the
      // compressMessageId entry id is resolved when the block is created.
      s.compressionTiming.pendingByCallId.set(event.toolCallId, {
        messageId: "",
        callId: event.toolCallId,
        durationMs
      })
    }
    return s
  })
})
