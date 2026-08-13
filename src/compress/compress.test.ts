import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "@effect/vitest"
import { defaultConfig } from "../core/config.js"
import { type CompressionBlock, createEmptySessionState } from "../core/state.js"
import {
  COMPRESSED_BLOCK_HEADER,
  type CompressRangeToolArgs,
  type CompressToolDeps,
  type CompressToolDetails,
  createCompressTool,
  injectBlockPlaceholders,
  parseBlockPlaceholders,
  wrapCompressedSummary
} from "./compress.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function messageEntry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [] }
  } as unknown as SessionEntry
}

function mockCtx(entryIds: string[]): ExtensionContext {
  const entries = entryIds.map(messageEntry)
  return { sessionManager: { buildContextEntries: () => entries } } as unknown as ExtensionContext
}

function mockPi(): { pi: ExtensionAPI; entries: Array<{ type: string; data: unknown }> } {
  const entries: Array<{ type: string; data: unknown }> = []
  const pi = {
    appendEntry: (type: string, data: unknown) => {
      entries.push({ type, data })
    }
  } as unknown as ExtensionAPI
  return { pi, entries }
}

function makeBlock(blockId: number, anchorMessageId: string, summary: string): CompressionBlock {
  return {
    blockId,
    runId: 1,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 0,
    summaryTokens: 0,
    durationMs: 0,
    mode: "range",
    topic: "test",
    startId: anchorMessageId,
    endId: anchorMessageId,
    anchorMessageId,
    compressMessageId: "",
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: [],
    directToolIds: [],
    effectiveMessageIds: [anchorMessageId],
    effectiveToolIds: [],
    createdAt: 0,
    summary
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compress tool", () => {
  it("compresses a single range into a block and persists state", async () => {
    const state = createEmptySessionState()
    const { pi, entries } = mockPi()
    const deps: CompressToolDeps = { config: defaultConfig, getState: () => state, pi }
    const tool = createCompressTool(deps)

    const params: CompressRangeToolArgs = {
      topic: "Test",
      content: [{ startId: "e1", endId: "e3", summary: "summary of e1..e3" }]
    }

    const result = await tool.execute("call-1", params, undefined, undefined, mockCtx(["e1", "e2", "e3"]))

    expect(state.prune.messages.blocksById.size).toBe(1)
    const block = state.prune.messages.blocksById.get(1)
    expect(block?.active).toBe(true)
    expect(block?.anchorMessageId).toBe("e1")
    expect(block?.startId).toBe("e1")
    expect(block?.endId).toBe("e3")

    const details = result.details as CompressToolDetails
    expect(details.compressedRanges).toBe(1)
    expect(details.error).toBeUndefined()
    expect(result.content[0]?.type).toBe("text")

    // persisted via saveState -> pi.appendEntry("dcp-state", ...)
    // plus the chat-mode notification -> pi.appendEntry("dcp-notification", ...)
    expect(entries.some((e) => e.type === "dcp-state")).toBe(true)
    expect(entries.some((e) => e.type === "dcp-notification")).toBe(true)
    const dcpStateEntry = entries.find((e) => e.type === "dcp-state")
    expect(dcpStateEntry).toBeDefined()
  })

  it("rejects overlapping ranges", async () => {
    const state = createEmptySessionState()
    const { pi } = mockPi()
    const tool = createCompressTool({ config: defaultConfig, getState: () => state, pi })

    const params: CompressRangeToolArgs = {
      topic: "Test",
      content: [
        { startId: "e1", endId: "e3", summary: "a" },
        { startId: "e2", endId: "e4", summary: "b" }
      ]
    }

    const result = await tool.execute("call-2", params, undefined, undefined, mockCtx(["e1", "e2", "e3", "e4"]))

    const details = result.details as CompressToolDetails
    expect(details.error).toBeDefined()
    const textBlock = result.content[0]
    expect(textBlock !== undefined && textBlock.type === "text" ? textBlock.text : "").toContain("overlap")
    expect(state.prune.messages.blocksById.size).toBe(0)
  })

  it("resolves an mNNNN boundary through state.messageIds.byRef", async () => {
    const state = createEmptySessionState()
    state.messageIds.byRef.set("m0005", "e2")
    const { pi } = mockPi()
    const tool = createCompressTool({ config: defaultConfig, getState: () => state, pi })

    const params: CompressRangeToolArgs = {
      topic: "Test",
      content: [{ startId: "e1", endId: "m0005", summary: "summary of e1..e2" }]
    }

    const result = await tool.execute("call-4", params, undefined, undefined, mockCtx(["e1", "e2", "e3"]))

    const details = result.details as CompressToolDetails
    expect(details.error).toBeUndefined()
    const block = state.prune.messages.blocksById.get(1)
    expect(block?.startId).toBe("e1")
    expect(block?.endId).toBe("m0005")
    expect(block?.effectiveMessageIds).toEqual(["e1", "e2"])
  })

  it("rejects an unknown startId", async () => {
    const state = createEmptySessionState()
    const { pi } = mockPi()
    const tool = createCompressTool({ config: defaultConfig, getState: () => state, pi })

    const params: CompressRangeToolArgs = {
      topic: "Test",
      content: [{ startId: "missing", endId: "e2", summary: "x" }]
    }

    const result = await tool.execute("call-3", params, undefined, undefined, mockCtx(["e1", "e2"]))

    const details = result.details as CompressToolDetails
    expect(details.error).toBeDefined()
    const textBlock = result.content[0]
    expect(textBlock !== undefined && textBlock.type === "text" ? textBlock.text : "").toContain("not available")
    expect(state.prune.messages.blocksById.size).toBe(0)
  })

  it("injects a (b1) placeholder from a known block", () => {
    const summaryByBlockId = new Map<number, CompressionBlock>()
    summaryByBlockId.set(
      1,
      makeBlock(1, "e0", "[Compressed conversation section]\nold summary\n\n<dcp-message-id>b1</dcp-message-id>")
    )

    const placeholders = parseBlockPlaceholders("continuation referencing (b1)")
    expect(placeholders).toHaveLength(1)

    const result = injectBlockPlaceholders(
      "continuation referencing (b1)",
      placeholders,
      summaryByBlockId,
      { kind: "message", rawIndex: 0, messageId: "e1" },
      { kind: "message", rawIndex: 2, messageId: "e3" }
    )

    expect(result.expandedSummary).toContain("old summary")
    expect(result.consumedBlockIds).toEqual([1])
  })

  it("wraps a summary with the compressed block header and id footer", () => {
    const wrapped = wrapCompressedSummary(7, "the summary")
    expect(wrapped).toContain(COMPRESSED_BLOCK_HEADER)
    expect(wrapped).toContain("the summary")
    expect(wrapped).toContain("<dcp-message-id>b7</dcp-message-id>")
  })
})
