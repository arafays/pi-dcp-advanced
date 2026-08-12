import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect, Option } from "effect"
import { createCompressTool } from "./compress.js"
import { defaultConfig, loadConfig, type ResolvedConfig } from "./config.js"
import { dcpCompressHandler } from "./dcp-command.js"
import { dcpPanelHandler } from "./dcp-tui.js"
import { injectNudges } from "./nudges.js"
import { prune } from "./prune.js"
import { createEmptySessionState, loadState, makeDcpState, type SessionState, saveState } from "./state.js"
import { deduplicate, purgeErrors } from "./strategies.js"
import { onBeforeAgentStart } from "./system-prompt.js"
import { onToolCall, onToolExecutionEnd, onToolExecutionStart, onToolResult } from "./tracking.js"

// ---------------------------------------------------------------------------
// WP11 — context-handler integration.
//
// Wires WP1-WP10 into the Pi extension factory:
//   - config     (WP1): loadConfig cascade, degrade to defaults on failure.
//   - state      (WP2): Ref-backed DcpState service + saveState/loadState.
//   - tracking   (WP3): tool_call/tool_result/tool_execution_{start,end} hooks.
//   - prune      (WP4): prune(messages, state, config, ctx) — mark-then-apply.
//   - strategies (WP5): deduplicate + purgeErrors — seed the prune map.
//   - compress   (WP6): the `compress` range tool.
//   - system-prompt (WP7): before_agent_start injection.
//   - nudges     (WP8): injectNudges after pruning.
//   - TUI/command (WP9/WP10): /dcp panel + /dcp-compress trigger.
//
// The factory is async (ExtensionFactory allows `Promise<void>`), so config is
// resolved once at load time and captured in the closure — no lazy config
// promise needed in the hot context handler.
//
// Error policy (PLAN WP11): handlers never throw. On error they notify (when a
// UI is available) and return the unchanged result (context -> original
// messages; before_agent_start -> {}; tool_* -> void).
// ---------------------------------------------------------------------------

/** Resolve DCP config from the cascade, degrading to defaults on any failure. */
async function resolveConfig(): Promise<ResolvedConfig> {
  try {
    return await Effect.runPromise(loadConfig())
  } catch {
    return defaultConfig
  }
}

/** Best-effort error surface for handlers; never throws. */
function notifyError(ctx: ExtensionContext | undefined, message: string): void {
  try {
    if (ctx?.hasUI) {
      ctx.ui.notify(`DCP: ${message}`, "error")
    }
  } catch {
    // Notification is best-effort; swallowing keeps the handler non-throwing.
  }
}

/**
 * Pi extension factory. Registers the 7 event hooks + the `compress` tool +
 * the `/dcp` and `/dcp-compress` commands.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
  const config = await resolveConfig()
  const dcpState = await Effect.runPromise(makeDcpState(createEmptySessionState()))
  const getState = (): SessionState => Effect.runSync(dcpState.get())

  // --- session lifecycle (WP2 persistence) ----------------------------------
  pi.on("session_start", (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId()
      const loaded = Option.getOrNull(Effect.runSync(loadState(ctx)))
      const state = loaded ?? createEmptySessionState(sessionId)
      if (state.sessionId === null || state.sessionId === "") {
        state.sessionId = sessionId
      }
      Effect.runSync(dcpState.update(() => state))
    } catch (error) {
      notifyError(ctx, `state load failed: ${String(error)}`)
    }
  })

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      saveState(pi, Effect.runSync(dcpState.get()))
    } catch (error) {
      notifyError(ctx, `state save failed: ${String(error)}`)
    }
  })

  // --- tool-call tracking (WP3) ---------------------------------------------
  pi.on("tool_call", (event, ctx) => {
    try {
      Effect.runSync(onToolCall(event, dcpState))
    } catch (error) {
      notifyError(ctx, `tool_call tracking failed: ${String(error)}`)
    }
  })

  pi.on("tool_result", (event, ctx) => {
    try {
      Effect.runSync(onToolResult(event, dcpState))
    } catch (error) {
      notifyError(ctx, `tool_result tracking failed: ${String(error)}`)
    }
  })

  pi.on("tool_execution_start", (event, ctx) => {
    try {
      Effect.runSync(onToolExecutionStart(event, dcpState))
    } catch (error) {
      notifyError(ctx, `tool_execution_start tracking failed: ${String(error)}`)
    }
  })

  pi.on("tool_execution_end", (event, ctx) => {
    try {
      Effect.runSync(onToolExecutionEnd(event, dcpState))
    } catch (error) {
      notifyError(ctx, `tool_execution_end tracking failed: ${String(error)}`)
    }
  })

  // --- system-prompt injection (WP7) ----------------------------------------
  pi.on(
    "before_agent_start",
    onBeforeAgentStart(pi, config, () => dcpState.get())
  )

  // --- the context prune pipeline (WP11, PLAN order) -------------------------
  pi.on("context", (event, ctx) => {
    try {
      if (!config.enabled) {
        return { messages: event.messages }
      }

      const state = Effect.runSync(dcpState.get())

      // 1. Recomputed strategies seed the prune map (mark). Both mutate `state`
      //    in place — the Ref-held object — so no explicit update is required.
      deduplicate(state, config)
      purgeErrors(state, config)

      // 2. Apply the marks to a deep copy of the context messages.
      const pruned = prune(event.messages, state, config, ctx)

      // 3. Inject context-limit/turn/iteration nudges (mutates state.nudges).
      const withNudges = injectNudges(pruned, ctx, state, config)

      // 4. Apply a pending manual compress trigger: /dcp-compress records the
      //    prior manualMode and switches to "compress-pending". Once the
      //    trigger user turn (sentinel `<compress triggered manually>`) is
      //    observed, restore the prior manualMode and clear the pending flag.
      //    Run after nudges so the compress turn itself stays nudge-free.
      //    Range-mode, in-place-rewrite-free port of the source
      //    `applyPendingManualTrigger` (lib/commands/manual.ts:93).
      const pending = state.pendingManualTrigger
      if (pending !== null) {
        const sentinel = "<compress triggered manually>"
        const delivered = event.messages.some((message) => {
          if (message.role !== "user") return false
          const content = message.content
          if (typeof content === "string") return content.includes(sentinel)
          return content.some(
            (block) => block.type === "text" && typeof block.text === "string" && block.text.includes(sentinel)
          )
        })
        if (delivered) {
          state.manualMode = pending.priorMode
          state.pendingManualTrigger = null
        }
      }

      // 5. Persist the mutated durable slice (prune map, nudges, stats).
      saveState(pi, state)

      return { messages: withNudges }
    } catch (error) {
      notifyError(ctx, `context prune failed: ${String(error)}`)
      return { messages: event.messages }
    }
  })

  // --- compress range tool (WP6) --------------------------------------------
  pi.registerTool(createCompressTool({ config, getState, pi }))

  // --- commands (WP9 / WP10) ------------------------------------------------
  pi.registerCommand("dcp", {
    description: "Dynamic Context Pruning controls",
    async handler(args, ctx) {
      await dcpPanelHandler(pi, args, ctx, {
        config,
        getDcpState: () => dcpState,
        saveState
      })
    }
  })

  pi.registerCommand("dcp-compress", {
    description: "Trigger one compression pass",
    async handler(args, ctx) {
      await dcpCompressHandler(args, ctx, {
        pi,
        getState: () => dcpState.get(),
        saveState
      })
    }
  })
}
