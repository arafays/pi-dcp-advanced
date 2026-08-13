import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "@effect/vitest"
import { defaultConfig, type ResolvedConfig } from "./config.js"
import {
  assignMessageRefs,
  formatBlockRef,
  formatMessageIdTag,
  formatMessageRef,
  injectMessageIds,
  MESSAGE_REF_MAX_INDEX,
  parseBlockRef,
  parseMessageRef
} from "./message-ids.js"
import { createEmptySessionState, type SessionState } from "./state.js"

type AgentMessage = ContextEvent["messages"][number]
type UserContent = Extract<AgentMessage, { role: "user" }>["content"]
type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"]

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(id: string, message: AgentMessage): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message
  } as unknown as SessionEntry
}

function userMessage(content: UserContent): Extract<AgentMessage, { role: "user" }> {
  return { role: "user", content, timestamp: 0 }
}

function assistantMessage(content: AssistantContent): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content,
    api: "anthropic",
    provider: "anthropic",
    model: "claude",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: 0
  }
}

const TAG = (ref: string): string => `<dcp-message-id>${ref}</dcp-message-id>`

// ---------------------------------------------------------------------------
// format/parse helpers
// ---------------------------------------------------------------------------

describe("formatMessageRef", () => {
  it("zero-pads indices to four digits", () => {
    expect(formatMessageRef(1)).toBe("m0001")
    expect(formatMessageRef(2)).toBe("m0002")
    expect(formatMessageRef(9)).toBe("m0009")
    expect(formatMessageRef(10)).toBe("m0010")
    expect(formatMessageRef(9999)).toBe("m9999")
  })

  it("throws for out-of-range or non-integer indices", () => {
    expect(() => formatMessageRef(0)).toThrow()
    expect(() => formatMessageRef(-1)).toThrow()
    expect(() => formatMessageRef(10000)).toThrow()
    expect(() => formatMessageRef(1.5)).toThrow()
  })
})

describe("formatBlockRef", () => {
  it("formats block ids without padding", () => {
    expect(formatBlockRef(1)).toBe("b1")
    expect(formatBlockRef(2)).toBe("b2")
    expect(formatBlockRef(123)).toBe("b123")
  })

  it("throws for invalid block ids", () => {
    expect(() => formatBlockRef(0)).toThrow()
    expect(() => formatBlockRef(-1)).toThrow()
    expect(() => formatBlockRef(1.5)).toThrow()
  })
})

describe("parseMessageRef", () => {
  it("parses valid mNNNN refs (case-insensitive, trimmed)", () => {
    expect(parseMessageRef("m0001")).toBe(1)
    expect(parseMessageRef("M0001")).toBe(1)
    expect(parseMessageRef("  m0010  ")).toBe(10)
    expect(parseMessageRef(`m${MESSAGE_REF_MAX_INDEX}`)).toBe(MESSAGE_REF_MAX_INDEX)
  })

  it("rejects malformed or out-of-range refs", () => {
    expect(parseMessageRef("m1")).toBeNull()
    expect(parseMessageRef("m0000")).toBeNull()
    expect(parseMessageRef("m10000")).toBeNull()
    expect(parseMessageRef("b2")).toBeNull()
    expect(parseMessageRef("")).toBeNull()
  })
})

describe("parseBlockRef", () => {
  it("parses valid bN refs (case-insensitive, trimmed)", () => {
    expect(parseBlockRef("b2")).toBe(2)
    expect(parseBlockRef("B2")).toBe(2)
    expect(parseBlockRef("  b123  ")).toBe(123)
  })

  it("rejects malformed block refs", () => {
    expect(parseBlockRef("b0")).toBeNull()
    expect(parseBlockRef("b")).toBeNull()
    expect(parseBlockRef("m0001")).toBeNull()
    expect(parseBlockRef("")).toBeNull()
  })
})

describe("formatMessageIdTag", () => {
  it("produces a leading-newline dcp-message-id tag", () => {
    expect(formatMessageIdTag("m0001")).toBe("\n<dcp-message-id>m0001</dcp-message-id>")
  })

  it("sorts attributes by key and XML-escapes values", () => {
    expect(
      formatMessageIdTag("m0001", {
        priority: "high",
        amp: "a&b",
        quote: 'say "hi"',
        lt: "<x>"
      })
    ).toBe(
      '\n<dcp-message-id amp="a&amp;b" lt="&lt;x&gt;" priority="high" quote="say &quot;hi&quot;">m0001</dcp-message-id>'
    )
  })

  it("skips empty and undefined attribute values", () => {
    expect(formatMessageIdTag("m0002", { b: undefined, a: "", keep: "v" })).toBe(
      '\n<dcp-message-id keep="v">m0002</dcp-message-id>'
    )
  })
})

// ---------------------------------------------------------------------------
// assignMessageRefs
// ---------------------------------------------------------------------------

describe("assignMessageRefs", () => {
  it("allocates sequential refs for user/assistant entries", () => {
    const state = createEmptySessionState()
    const entries = [
      entry("e1", userMessage("hello")),
      entry("e2", assistantMessage([{ type: "text", text: "hi" }])),
      entry("e3", userMessage([{ type: "text", text: "a" }]))
    ]

    const assigned = assignMessageRefs(state, entries)

    expect(assigned).toBe(3)
    expect(state.messageIds.byRawId.get("e1")).toBe("m0001")
    expect(state.messageIds.byRawId.get("e2")).toBe("m0002")
    expect(state.messageIds.byRawId.get("e3")).toBe("m0003")
    expect(state.messageIds.byRef.get("m0001")).toBe("e1")
    expect(state.messageIds.byRef.get("m0002")).toBe("e2")
    expect(state.messageIds.byRef.get("m0003")).toBe("e3")
    expect(state.messageIds.nextRef).toBe(4)
  })

  it("is idempotent across turns and continues advancing nextRef", () => {
    const state = createEmptySessionState()
    const first = [entry("e1", userMessage("hello")), entry("e2", userMessage("world"))]
    const second = [entry("e3", userMessage("again"))]

    expect(assignMessageRefs(state, first)).toBe(2)
    expect(assignMessageRefs(state, first)).toBe(0)
    expect(assignMessageRefs(state, second)).toBe(1)

    expect(state.messageIds.byRawId.get("e1")).toBe("m0001")
    expect(state.messageIds.byRawId.get("e3")).toBe("m0003")
    expect(state.messageIds.nextRef).toBe(4)
  })

  it("assigns refs to compressible roles and skips empty ids", () => {
    const state = createEmptySessionState()
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "out" }],
      isError: false,
      timestamp: 0
    }
    const entries = [
      entry("e1", toolResult),
      { ...entry("e2", userMessage("hi")), id: "" },
      entry("e3", userMessage("hi"))
    ]

    const assigned = assignMessageRefs(state, entries)

    expect(assigned).toBe(2)
    expect(state.messageIds.byRawId.get("e1")).toBe("m0001")
    expect(state.messageIds.byRawId.has("e2")).toBe(false)
    expect(state.messageIds.byRawId.get("e3")).toBe("m0002")
  })
})

// ---------------------------------------------------------------------------
// injectMessageIds
// ---------------------------------------------------------------------------

function injectedState(refs: Array<[string, string]>): SessionState {
  const state = createEmptySessionState()
  for (const [entryId, ref] of refs) {
    state.messageIds.byRawId.set(entryId, ref)
  }
  return state
}

describe("injectMessageIds", () => {
  it("converts a user string message to a text block with the tag appended", () => {
    const state = injectedState([["e1", "m0001"]])
    const message = userMessage("hello")
    const messages = [message]
    const entries = [entry("e1", message)]

    injectMessageIds(state, defaultConfig, messages, entries)

    const content = (messages[0] as { content: Array<{ type: string; text: string }> }).content
    expect(Array.isArray(content)).toBe(true)
    expect(content[0]?.type).toBe("text")
    expect(content[0]?.text).toBe(`hello\n\n${TAG("m0001")}`)
  })

  it("appends the tag to the last text block of a user array message", () => {
    const state = injectedState([["e1", "m0002"]])
    const message = userMessage([
      { type: "text", text: "a" },
      { type: "text", text: "b" }
    ])
    const messages = [message]
    const entries = [entry("e1", message)]

    injectMessageIds(state, defaultConfig, messages, entries)

    const content = messages[0]?.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      const last = content[content.length - 1]
      expect(last?.type).toBe("text")
      expect((last as { text: string }).text).toBe(`b\n\n${TAG("m0002")}`)
    }
  })

  it("pushes a synthetic text block when a user array has no text block", () => {
    const state = injectedState([["e1", "m0003"]])
    const message = userMessage([{ type: "image", data: "x", mimeType: "image/png" }])
    const messages = [message]
    const entries = [entry("e1", message)]

    injectMessageIds(state, defaultConfig, messages, entries)

    const content = messages[0]?.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      expect(content).toEqual([
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: `\n${TAG("m0003")}` }
      ])
    }
  })

  it("appends the tag to the last text block of an assistant message", () => {
    const state = injectedState([["e1", "m0004"]])
    const message = assistantMessage([{ type: "text", text: "answer" }])
    const messages = [message]
    const entries = [entry("e1", message)]

    injectMessageIds(state, defaultConfig, messages, entries)

    const content = messages[0]?.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      const last = content[content.length - 1]
      expect(last?.type).toBe("text")
      expect((last as { text: string }).text).toBe(`answer\n\n${TAG("m0004")}`)
    }
  })

  it("inserts a synthetic text block before the first toolCall of an assistant message", () => {
    const state = injectedState([["e1", "m0005"]])
    const toolCall = { type: "toolCall" as const, id: "t1", name: "read", arguments: {} }
    const message = assistantMessage([toolCall])
    const messages = [message]
    const entries = [entry("e1", message)]

    injectMessageIds(state, defaultConfig, messages, entries)

    const content = messages[0]?.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      expect(content).toEqual([{ type: "text", text: `\n${TAG("m0005")}` }, toolCall])
    }
  })

  it("tags toolResult and bashExecution messages", () => {
    const state = injectedState([
      ["tr1", "m0001"],
      ["bash1", "m0002"]
    ])
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "tr1",
      toolName: "read",
      content: [{ type: "text", text: "out" }],
      isError: false,
      timestamp: 0
    }
    const bash: AgentMessage = {
      role: "bashExecution",
      command: "ls",
      output: "x",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0
    }
    const messages = [toolResult, bash]
    const entries = [entry("tr1", toolResult), entry("bash1", bash)]

    injectMessageIds(state, defaultConfig, messages, entries)

    const result = messages[0] as { content: Array<{ type: string; text: string }> }
    expect(result.content).toEqual([{ type: "text", text: `out\n\n${TAG("m0001")}` }])
    expect((messages[1] as { output: string }).output).toBe(`x\n\n${TAG("m0002")}`)
  })

  it("skips messages without a ref", () => {
    const state = injectedState([["e1", "m0001"]])
    const message = userMessage("no-ref")
    const messages = [message]
    const entries = [entry("eX", message)]

    injectMessageIds(state, defaultConfig, messages, entries)

    expect(messages[0]?.content).toBe("no-ref")
  })

  it("is a no-op when compress permission is deny (state or config)", () => {
    const state = injectedState([["e1", "m0001"]])
    state.compressPermission = "deny"
    const message = userMessage("hello")
    const messages = [message]
    const entries = [entry("e1", message)]

    injectMessageIds(state, defaultConfig, messages, entries)

    expect(messages[0]?.content).toBe("hello")

    const configDeny: ResolvedConfig = { ...defaultConfig, compress: { ...defaultConfig.compress, permission: "deny" } }
    const state2 = injectedState([["e1", "m0001"]])
    const message2 = userMessage("hello")
    const messages2 = [message2]
    const entries2 = [entry("e1", message2)]

    injectMessageIds(state2, configDeny, messages2, entries2)

    expect(messages2[0]?.content).toBe("hello")
  })
})
