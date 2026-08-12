import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "@effect/vitest"
import { defaultConfig, type ResolvedConfig } from "./config.js"
import {
  type AgentMessage,
  type CustomMessage,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  prune,
  type ToolResultMessage
} from "./prune.js"
import {
  allocateBlockId,
  allocateRunId,
  applyCompressionState,
  type CompressionStateInput,
  createEmptySessionState,
  type SelectionResolution,
  type SessionState
} from "./state.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  options: { isError?: boolean; details?: unknown } = {}
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: options.isError ?? false,
    timestamp: 0,
    ...(options.details !== undefined ? { details: options.details } : {})
  }
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 }
}

function asToolResult(message: AgentMessage | undefined): ToolResultMessage {
  if (message === undefined || message.role !== "toolResult") {
    throw new Error("expected a toolResult message")
  }
  return message
}

function asCustom(message: AgentMessage | undefined): CustomMessage {
  if (message === undefined || message.role !== "custom") {
    throw new Error("expected a custom message")
  }
  return message
}

function mockCtx(entryIds: string[]): ExtensionContext {
  const branch = entryIds.map(
    (id): SessionEntry =>
      ({
        type: "message",
        id,
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [] }
      }) as unknown as SessionEntry
  )
  return { sessionManager: { buildContextEntries: () => branch } } as unknown as ExtensionContext
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prune", () => {
  it("replaces an earlier duplicate read output with the placeholder", () => {
    const state = createEmptySessionState()
    state.prune.tools.set("read-1", 100)

    const messages: AgentMessage[] = [
      toolResult("read-1", "read", "earlier content"),
      toolResult("read-2", "read", "later content")
    ]

    const result = prune(messages, state, defaultConfig)

    expect(asToolResult(result[0]).content).toEqual([{ type: "text", text: PRUNED_TOOL_OUTPUT_REPLACEMENT }])
    expect(asToolResult(result[1]).content).toEqual([{ type: "text", text: "later content" }])
  })

  it("leaves protected tool outputs untouched", () => {
    const state = createEmptySessionState()
    state.prune.tools.set("write-1", 100)

    const result = prune([toolResult("write-1", "write", "important content")], state, defaultConfig)

    expect(asToolResult(result[0]).content).toEqual([{ type: "text", text: "important content" }])
  })

  it("leaves protected-file outputs untouched", () => {
    const state = createEmptySessionState()
    state.prune.tools.set("read-1", 100)
    state.toolParameters.set("read-1", {
      tool: "read",
      parameters: { filePath: "src/secret/notes.md" },
      status: "completed",
      turn: 0
    })
    const config: ResolvedConfig = { ...defaultConfig, protectedFilePatterns: ["**/secret/**"] }

    const result = prune([toolResult("read-1", "read", "secret content")], state, config)

    expect(asToolResult(result[0]).content).toEqual([{ type: "text", text: "secret content" }])
  })

  it("clears details for errored tool results marked for pruning (mark-then-apply)", () => {
    const state = createEmptySessionState()
    // Marked by WP5 purgeErrors (errored + past N turns). pruneToolErrors is a
    // pure applier that reads state.prune.tools.
    state.prune.tools.set("bash-1", 80)
    const messages: AgentMessage[] = [toolResult("bash-1", "bash", "boom", { isError: true, details: { argv: "rm" } })]

    const result = prune(messages, state, defaultConfig)

    expect(asToolResult(result[0]).details).toBeUndefined()
  })

  it("keeps details for errored tools that were not marked (protected / not old enough)", () => {
    const state = createEmptySessionState()
    // No mark: WP5 purgeErrors skipped it (protected tool, or below turn threshold).
    const messages: AgentMessage[] = [toolResult("bash-1", "bash", "boom", { isError: true, details: { argv: "rm" } })]

    const result = prune(messages, state, defaultConfig)

    expect(asToolResult(result[0]).details).toBeDefined()
  })

  it("keeps details for marked non-error tools (only errored results are cleared)", () => {
    const state = createEmptySessionState()
    state.prune.tools.set("bash-1", 80)
    const messages: AgentMessage[] = [toolResult("bash-1", "bash", "ok", { isError: false, details: { argv: "ls" } })]

    const result = prune(messages, state, defaultConfig)

    expect(asToolResult(result[0]).details).toBeDefined()
  })

  it("leaves protected errored tool details untouched (protected is gated at mark time)", () => {
    const state = createEmptySessionState()
    const config: ResolvedConfig = {
      ...defaultConfig,
      strategies: {
        ...defaultConfig.strategies,
        purgeErrors: { ...defaultConfig.strategies.purgeErrors, protectedTools: ["write"] }
      }
    }

    // WP5 purgeErrors would not mark a protected tool, so state.prune.tools is empty.
    const result = prune(
      [toolResult("write-1", "write", "boom", { isError: true, details: { filePath: "x" } })],
      state,
      config
    )

    expect(asToolResult(result[0]).details).toBeDefined()
  })

  it("drops a compressed span and injects a summary CustomMessage at the anchor", () => {
    const state = createEmptySessionState()
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
      "anchor-1",
      blockId,
      "compressed summary",
      []
    )

    const ctx = mockCtx(["e1", "anchor-1", "e2"])
    const messages: AgentMessage[] = [userMessage("one"), userMessage("two"), userMessage("three")]

    const result = prune(messages, state, defaultConfig, ctx)

    expect(result).toHaveLength(2)

    const summary = asCustom(result[0])
    expect(summary.customType).toBe("dcp-compression-summary")
    expect(summary.content).toBe("compressed summary")
    expect(summary.display).toBe(false)
    expect(summary.details).toEqual({ blockId })

    expect(result[1]?.role).toBe("user")
  })

  it("does not mutate the caller's messages", () => {
    const state = createEmptySessionState()
    state.prune.tools.set("read-1", 100)

    const messages: AgentMessage[] = [toolResult("read-1", "read", "original")]

    prune(messages, state, defaultConfig)

    expect(asToolResult(messages[0]).content).toEqual([{ type: "text", text: "original" }])
  })

  it("returns the original messages unchanged if pruning throws", () => {
    const state = createEmptySessionState()
    state.prune.messages.activeByAnchorMessageId.set("anchor", 1)

    const badCtx = {
      sessionManager: {
        buildContextEntries: () => {
          throw new Error("boom")
        }
      }
    } as unknown as ExtensionContext

    const messages: AgentMessage[] = [toolResult("read-1", "read", "content")]

    const result = prune(messages, state, defaultConfig, badCtx)

    expect(result).toBe(messages)
  })
})
