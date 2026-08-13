import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { defaultConfig } from "./config.js"
import { createEmptySessionState, type SessionState } from "./state.js"
import { onBeforeAgentStart, renderSystemPrompt } from "./system-prompt.js"

// The `pi` parameter is reserved for WP11 wiring and unused by this hook.
const unusedPi = null as unknown as ExtensionAPI

const makeState = (manualMode: SessionState["manualMode"] = false): SessionState => {
  const state = createEmptySessionState("test-session")
  state.manualMode = manualMode
  return state
}

const makeEvent = (systemPrompt: string): BeforeAgentStartEvent => ({
  type: "before_agent_start",
  prompt: "test prompt",
  systemPrompt,
  systemPromptOptions: { cwd: "/tmp" }
})

const makeHandler = (state: SessionState) => onBeforeAgentStart(unusedPi, defaultConfig, () => Effect.succeed(state))

describe("renderSystemPrompt", () => {
  it("includes the protected-tools list", () => {
    const prompt = renderSystemPrompt(defaultConfig, false)
    // commands.protectedTools
    expect(prompt).toContain("`task`")
    expect(prompt).toContain("`write`")
    // compress.protectedTools
    expect(prompt).toContain("`skill`")
    expect(prompt).toContain("`todowrite`")
    expect(prompt).toContain("environment-managed")
  })

  it("includes the manual-mode flag when active", () => {
    const prompt = renderSystemPrompt(defaultConfig, "active")
    expect(prompt).toContain("Manual mode is enabled")
    expect(prompt).toContain("dcp-system-reminder")
  })

  it("omits the manual-mode flag when disabled", () => {
    const prompt = renderSystemPrompt(defaultConfig, false)
    expect(prompt).not.toContain("Manual mode is enabled")
  })

  it("renders the DCP header and compress usage instructions", () => {
    const prompt = renderSystemPrompt(defaultConfig, false)
    expect(prompt).toContain("Dynamic Context Pruning")
    expect(prompt).toContain("COMPRESS WHEN")
    expect(prompt).toContain("DO NOT COMPRESS IF")
  })
})

describe("onBeforeAgentStart", () => {
  it("appends the DCP block to a normal system prompt", () => {
    const handler = makeHandler(makeState(false))
    const result = handler(makeEvent("You are a helpful coding assistant."))
    expect(result.systemPrompt).toContain("You are a helpful coding assistant.")
    expect(result.systemPrompt).toContain("Dynamic Context Pruning")
    expect(result.systemPrompt).toContain("COMPRESS WHEN")
  })

  it("skips injection for summarizer/compaction agents", () => {
    const handler = makeHandler(makeState(false))
    const result = handler(makeEvent("You are a summarizer. Summarize what was done in this conversation."))
    expect(result.systemPrompt).toBeUndefined()
  })

  it("skips injection when manual mode is active but the prompt is a summarizer", () => {
    const handler = makeHandler(makeState("active"))
    const result = handler(makeEvent("You are a conversation summarizer for this session."))
    expect(result.systemPrompt).toBeUndefined()
  })

  it("appends the manual-mode flag when state.manualMode is active", () => {
    const handler = makeHandler(makeState("active"))
    const result = handler(makeEvent("You are a helpful coding assistant."))
    expect(result.systemPrompt).toContain("Manual mode is enabled")
  })

  it("never throws when state access fails", () => {
    const throwing = onBeforeAgentStart(unusedPi, defaultConfig, () => Effect.die(new Error("boom")))
    expect(() => throwing(makeEvent("You are a helpful coding assistant."))).not.toThrow()
  })
})
