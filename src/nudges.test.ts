import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "@effect/vitest"
import { defaultConfig, type ResolvedConfig } from "./config.js"
import { type AgentMessage, injectNudges } from "./nudges.js"
import { createEmptySessionState } from "./state.js"

// Distinctive lines from the verbatim nudge constants (stable regardless of the
// guidance text appended inside the </dcp-system-reminder> close tag).
const CONTEXT_MARK = "CRITICAL WARNING: MAX CONTEXT LIMIT REACHED"
const TURN_MARK = "Evaluate the conversation for compressible ranges."
const ITERATION_MARK = "You've been iterating for a while after the last user message."

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 }
}

function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage
}

function assistantWithToolCall(name: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name, arguments: {} }],
    timestamp: 0
  } as unknown as AgentMessage
}

interface Usage {
  tokens: number
  contextWindow: number
}

function mockCtx(entryIds: string[], usage?: Usage): ExtensionContext {
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
  return {
    sessionManager: { buildContextEntries: () => branch },
    getContextUsage: () => (usage === undefined ? undefined : { ...usage, percent: null })
  } as unknown as ExtensionContext
}

/** Concatenated text blocks of a message (user string content is normalized). */
function textOf(message: AgentMessage | undefined): string {
  if (message === undefined) return ""
  const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content
  if (content === undefined) return ""
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }]
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("injectNudges", () => {
  it("overMaxLimit: injects the context-limit nudge into the last message and adds an anchor", () => {
    const state = createEmptySessionState()
    const messages: AgentMessage[] = [userMessage("hello")]
    const ctx = mockCtx(["e1"], { tokens: 150000, contextWindow: 200000 })

    const result = injectNudges(messages, ctx, state, defaultConfig)

    expect(state.nudges.contextLimitAnchors).toEqual(new Set(["e1"]))
    expect(textOf(result[0])).toContain(CONTEXT_MARK)
  })

  it("overMaxLimit: a second call within nudgeFrequency does not add a new anchor", () => {
    const state = createEmptySessionState()
    const ctx = mockCtx(["e1", "e2"], { tokens: 150000, contextWindow: 200000 })

    injectNudges([userMessage("a"), userMessage("b")], ctx, state, defaultConfig)
    expect(state.nudges.contextLimitAnchors).toEqual(new Set(["e2"]))

    // Same anchors, new trailing message still inside the 5-message gap.
    injectNudges(
      [userMessage("a"), userMessage("b"), userMessage("c")],
      mockCtx(["e1", "e2", "e3"], { tokens: 150000, contextWindow: 200000 }),
      state,
      defaultConfig
    )

    expect(state.nudges.contextLimitAnchors).toEqual(new Set(["e2"]))
  })

  it("overMinLimit + last user message: turn nudge (soft -> assistant target)", () => {
    const state = createEmptySessionState()
    const messages: AgentMessage[] = [assistantMessage("thinking"), userMessage("question")]
    const ctx = mockCtx(["e1", "e2"], { tokens: 60000, contextWindow: 200000 })

    injectNudges(messages, ctx, state, defaultConfig)

    expect(state.nudges.turnNudgeAnchors).toEqual(new Set(["e1", "e2"]))
    expect(textOf(messages[0])).toContain(TURN_MARK)
    expect(textOf(messages[1])).not.toContain(TURN_MARK)
  })

  it("overMinLimit + last user message: turn nudge (strong -> user target)", () => {
    const state = createEmptySessionState()
    const config: ResolvedConfig = {
      ...defaultConfig,
      compress: { ...defaultConfig.compress, nudgeForce: "strong" }
    }
    const messages: AgentMessage[] = [assistantMessage("thinking"), userMessage("question")]
    const ctx = mockCtx(["e1", "e2"], { tokens: 60000, contextWindow: 200000 })

    injectNudges(messages, ctx, state, config)

    expect(textOf(messages[1])).toContain(TURN_MARK)
    expect(textOf(messages[0])).not.toContain(TURN_MARK)
  })

  it("overMinLimit + many messages since last user: iteration nudge", () => {
    const state = createEmptySessionState()
    const config: ResolvedConfig = {
      ...defaultConfig,
      compress: { ...defaultConfig.compress, iterationNudgeThreshold: 2 }
    }
    const messages: AgentMessage[] = [userMessage("go"), assistantMessage("a1"), assistantMessage("a2")]
    const ctx = mockCtx(["e1", "e2", "e3"], { tokens: 60000, contextWindow: 200000 })

    injectNudges(messages, ctx, state, config)

    expect(state.nudges.iterationNudgeAnchors).toEqual(new Set(["e3"]))
    expect(textOf(messages[2])).toContain(ITERATION_MARK)
  })

  it("below minContextLimit: clears turn/iteration anchors but keeps context-limit anchors", () => {
    const state = createEmptySessionState()
    state.nudges.contextLimitAnchors.add("keep")
    state.nudges.turnNudgeAnchors.add("drop")
    state.nudges.iterationNudgeAnchors.add("drop")
    const ctx = mockCtx(["e1"], { tokens: 100, contextWindow: 200000 })

    injectNudges([userMessage("hi")], ctx, state, defaultConfig)

    expect(state.nudges.contextLimitAnchors).toEqual(new Set(["keep"]))
    expect(state.nudges.turnNudgeAnchors.size).toBe(0)
    expect(state.nudges.iterationNudgeAnchors.size).toBe(0)
  })

  it("last assistant message has a compress tool call: clears all anchors, no nudge", () => {
    const state = createEmptySessionState()
    state.nudges.contextLimitAnchors.add("a")
    state.nudges.turnNudgeAnchors.add("a")
    state.nudges.iterationNudgeAnchors.add("a")
    const messages: AgentMessage[] = [assistantWithToolCall("compress")]
    const ctx = mockCtx(["e1"], { tokens: 150000, contextWindow: 200000 })

    injectNudges(messages, ctx, state, defaultConfig)

    expect(state.nudges.contextLimitAnchors.size).toBe(0)
    expect(state.nudges.turnNudgeAnchors.size).toBe(0)
    expect(state.nudges.iterationNudgeAnchors.size).toBe(0)
    expect(textOf(messages[0])).toBe("")
  })

  it("manualMode truthy: no nudge", () => {
    const state = createEmptySessionState()
    state.manualMode = "active"
    const ctx = mockCtx(["e1"], { tokens: 150000, contextWindow: 200000 })
    const messages: AgentMessage[] = [userMessage("hi")]

    injectNudges(messages, ctx, state, defaultConfig)

    expect(state.nudges.contextLimitAnchors.size).toBe(0)
    expect(textOf(messages[0])).toBe("hi")
  })

  it("permission deny: no nudge", () => {
    const state = createEmptySessionState()
    const config: ResolvedConfig = {
      ...defaultConfig,
      compress: { ...defaultConfig.compress, permission: "deny" }
    }
    const ctx = mockCtx(["e1"], { tokens: 150000, contextWindow: 200000 })
    const messages: AgentMessage[] = [userMessage("hi")]

    injectNudges(messages, ctx, state, config)

    expect(state.nudges.contextLimitAnchors.size).toBe(0)
    expect(textOf(messages[0])).toBe("hi")
  })

  it("getContextUsage undefined: no nudge", () => {
    const state = createEmptySessionState()
    const ctx = mockCtx(["e1"], undefined)
    const messages: AgentMessage[] = [userMessage("hi")]

    injectNudges(messages, ctx, state, defaultConfig)

    expect(state.nudges.contextLimitAnchors.size).toBe(0)
    expect(textOf(messages[0])).toBe("hi")
  })

  it("buildContextEntries length mismatch: bail, no nudge", () => {
    const state = createEmptySessionState()
    // ctx reports 2 entry ids for 1 message -> drift guard bails.
    const ctx = mockCtx(["e1", "e2"], { tokens: 150000, contextWindow: 200000 })
    const messages: AgentMessage[] = [userMessage("hi")]

    injectNudges(messages, ctx, state, defaultConfig)

    expect(state.nudges.contextLimitAnchors.size).toBe(0)
    expect(textOf(messages[0])).toBe("hi")
  })

  it("string user content is converted to a text-block array with the nudge appended", () => {
    const state = createEmptySessionState()
    const messages: AgentMessage[] = [userMessage("hello")]
    const ctx = mockCtx(["e1"], { tokens: 150000, contextWindow: 200000 })

    const result = injectNudges(messages, ctx, state, defaultConfig)

    const content = (result[0] as { content?: unknown } | undefined)?.content
    expect(Array.isArray(content)).toBe(true)
    expect(textOf(result[0])).toContain("hello")
    expect(textOf(result[0])).toContain(CONTEXT_MARK)
  })
})
