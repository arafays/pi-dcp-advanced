import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { buildCompressedBlockGuidance } from "../core/nudges.js"
import type { PendingManualTrigger, SessionState } from "../core/state.js"

// ---------------------------------------------------------------------------
// /dcp-compress [focus] command
//
// Sends a manual compress trigger prompt directly to the model, which always
// triggers a turn and drives the model to invoke the `compress` tool.
//
// `state.pendingManualTrigger` is set for state-tracking: the context handler
// restores `manualMode` to its prior value and clears the pending flag once it
// observes the trigger was delivered (a user message containing
// `<compress triggered manually>`). It is a live-only flag — not part of
// `PersistedStateSchema` — so it does not survive /reload, which is acceptable
// because the trigger is sent in the same command.
// ---------------------------------------------------------------------------

export const COMPRESS_TRIGGER_PROMPT = [
  "<compress triggered manually>",
  "Manual mode trigger received. You must now use the compress tool.",
  "Find the most significant completed conversation content that can be compressed into a high-fidelity technical summary.",
  "Follow the active compress mode, preserve all critical implementation details, and choose safe targets.",
  "Return after compress with a brief explanation of what content was compressed."
].join("\n\n")

/** Injected dependencies, wired to the DcpState service + `saveState`. */
export interface DcpCompressDeps {
  readonly pi: ExtensionAPI
  readonly getState: () => Effect.Effect<SessionState>
  readonly saveState: (pi: ExtensionAPI, state: SessionState) => void
}

/**
 * Build the trigger prompt for a manual compress run. Range mode is the only
 * in-scope mode, so the active-compressed-block guidance is always appended.
 */
export function buildTriggerPrompt(state: SessionState, focus?: string): string {
  const sections = [COMPRESS_TRIGGER_PROMPT, buildCompressedBlockGuidance(state)]
  const trimmedFocus = focus?.trim()
  if (trimmedFocus !== undefined && trimmedFocus.length > 0) {
    sections.push(`Additional user focus:\n${trimmedFocus}`)
  }
  return sections.join("\n\n")
}

/**
 * Command handler for `/dcp-compress [focus]`. Parses the raw remainder as an
 * optional focus string, builds the trigger prompt, records the pending manual
 * trigger on state, persists, then sends the prompt as a user message (queued
 * via `deliverAs: "followUp"` when the agent is still streaming).
 *
 * Never throws: on any failure the error is surfaced via `ctx.ui.notify` and
 * the trigger is left unsent.
 */
export async function dcpCompressHandler(
  args: string,
  ctx: ExtensionCommandContext,
  deps: DcpCompressDeps
): Promise<void> {
  const focus = args.trim()

  try {
    const state = Effect.runSync(deps.getState())
    const triggerPrompt = buildTriggerPrompt(state, focus)

    // In-place mutation of the Ref-held state object.
    const pendingManualTrigger: PendingManualTrigger = {
      sessionId: state.sessionId ?? "",
      prompt: triggerPrompt,
      priorMode: state.manualMode
    }
    state.manualMode = "compress-pending"
    state.pendingManualTrigger = pendingManualTrigger

    deps.saveState(deps.pi, state)

    if (ctx.isIdle()) {
      deps.pi.sendUserMessage(triggerPrompt)
    } else {
      deps.pi.sendUserMessage(triggerPrompt, { deliverAs: "followUp" })
    }
  } catch (error) {
    if (ctx.hasUI) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.ui.notify(`Compression trigger failed: ${message}`, "error")
    }
  }
}
