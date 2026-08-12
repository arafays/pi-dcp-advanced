import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { buildTriggerPrompt, COMPRESS_TRIGGER_PROMPT, type DcpCompressDeps, dcpCompressHandler } from "./dcp-command.js"
import { createEmptySessionState, type SessionState } from "./state.js"

interface SentMessage {
  prompt: string
  options: { deliverAs?: "steer" | "followUp" } | undefined
}

function makeDeps(initialState: SessionState = createEmptySessionState("test-session")) {
  const sent: SentMessage[] = []
  const saved: SessionState[] = []
  const pi = {
    sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => {
      sent.push({ prompt: content, options })
    }
  } as unknown as ExtensionAPI

  const deps: DcpCompressDeps = {
    pi,
    getState: () => Effect.succeed(initialState),
    saveState: (_pi: ExtensionAPI, state: SessionState) => {
      saved.push(state)
    }
  }

  return { deps, sent, saved, state: initialState }
}

function makeCtx(idle = true, hasUI = true): ExtensionCommandContext {
  return {
    isIdle: () => idle,
    hasUI,
    ui: { notify: () => {} }
  } as unknown as ExtensionCommandContext
}

describe("buildTriggerPrompt", () => {
  it("composes COMPRESS_TRIGGER_PROMPT + block guidance with no focus", () => {
    const prompt = buildTriggerPrompt(createEmptySessionState("s1"))
    expect(prompt).toContain(COMPRESS_TRIGGER_PROMPT)
    expect(prompt).toContain("<compress triggered manually>")
    expect(prompt).toContain("Manual mode trigger received. You must now use the compress tool.")
    expect(prompt).toContain("Compressed block context:")
    expect(prompt).not.toContain("Additional user focus:")
  })

  it("appends the focus section when focus is provided", () => {
    const prompt = buildTriggerPrompt(createEmptySessionState("s1"), "archival notes")
    expect(prompt).toContain("Additional user focus:\narchival notes")
  })

  it("treats an empty focus string as no focus", () => {
    const prompt = buildTriggerPrompt(createEmptySessionState("s1"), "")
    expect(prompt).not.toContain("Additional user focus:")
  })
})

describe("dcpCompressHandler", () => {
  it("sets pendingManualTrigger and manualMode on the state", async () => {
    const { deps, state } = makeDeps()
    const expectedPrompt = buildTriggerPrompt(state)

    await dcpCompressHandler("", makeCtx(), deps)

    expect(state.manualMode).toBe("compress-pending")
    expect(state.pendingManualTrigger).toEqual({ sessionId: "test-session", prompt: expectedPrompt, priorMode: false })
  })

  it("persists the updated state", async () => {
    const { deps, saved, state } = makeDeps()

    await dcpCompressHandler("", makeCtx(), deps)

    expect(saved.length).toBe(1)
    expect(saved[0]).toBe(state)
    expect(saved[0]?.manualMode).toBe("compress-pending")
  })

  it("calls sendUserMessage with the trigger prompt", async () => {
    const { deps, sent, state } = makeDeps()
    const expectedPrompt = buildTriggerPrompt(state)

    await dcpCompressHandler("", makeCtx(), deps)

    expect(sent.length).toBe(1)
    expect(sent[0]?.prompt).toBe(expectedPrompt)
    expect(sent[0]?.options).toBeUndefined()
  })

  it("queues with deliverAs followUp when the agent is streaming", async () => {
    const { deps, sent } = makeDeps()

    await dcpCompressHandler("", makeCtx(false), deps)

    expect(sent[0]?.options).toEqual({ deliverAs: "followUp" })
  })

  it("passes a trimmed focus through to the sent prompt", async () => {
    const { deps, sent } = makeDeps()

    await dcpCompressHandler("  archival notes  ", makeCtx(), deps)

    expect(sent[0]?.prompt).toContain("Additional user focus:\narchival notes")
  })

  it("never throws when state access fails", async () => {
    const failingDeps: DcpCompressDeps = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      getState: () => Effect.die(new Error("boom")),
      saveState: () => {}
    }

    await expect(dcpCompressHandler("", makeCtx(), failingDeps)).resolves.toBeUndefined()
  })
})
