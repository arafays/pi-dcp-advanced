import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ThemeColor
} from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, matchesKey, Text } from "@earendil-works/pi-tui"
import { Effect } from "effect"
import type { ResolvedConfig } from "../core/config.js"
import type { DcpStateService, SessionState } from "../core/state.js"

// ---------------------------------------------------------------------------
// WP9 — /dcp TUI panel
//
// Ports the session-overview/statistics portion of DCP's TUI panel
// (SRC/lib/tui/* + SRC/lib/commands/{context,stats}.ts) onto Pi's
// `ctx.ui.custom` imperative component API. The OpenCode source renders with
// Solid/OpenTUI tsx (SRC/lib/tui/ui.tsx); Pi uses pi-tui imperative components
// (see PI/examples/extensions/summarize.ts, which this mirrors).
//
// The command itself is NOT registered here — WP11 wires `pi.registerCommand`
// in src/main.ts and calls `dcpPanelHandler`.
// ---------------------------------------------------------------------------

const MANUAL_MODE_ON = "Manual mode is now ON. Use /dcp-compress to trigger context tools manually."
const MANUAL_MODE_OFF = "Manual mode is now OFF."

const USAGE_HINT = "Usage: /dcp [stats|manual [on|off]|context]"

/**
 * Dependencies injected by WP11 (src/main.ts). The handler stays side-effect
 * free with respect to Pi registration: it only reads/writes state through
 * these accessors.
 */
export interface DcpPanelDeps {
  /** Resolved DCP config (for `commands.enabled`). */
  config: ResolvedConfig
  /** Resolve the live DcpState service (get/update over `SessionState`). */
  getDcpState: () => DcpStateService
  /** Persist the reload-relevant state slice (src/state.ts `saveState`). */
  saveState: (pi: ExtensionAPI, state: SessionState) => void
}

// ---------------------------------------------------------------------------
// Pure helpers (the testable core)
// ---------------------------------------------------------------------------

/** Parse the raw command argument string into a subcommand + trailing args. */
export function parseSubcommand(args: string): { subcommand: string; subArgs: string[] } {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const subcommand = tokens[0]?.toLowerCase() ?? ""
  return { subcommand, subArgs: tokens.slice(1) }
}

/**
 * Manual-mode toggle semantics (mirror SRC/lib/commands/manual.ts:48-55):
 *   "on"  -> "active"
 *   "off" -> false
 *   none  -> toggle (false -> "active", anything else -> false)
 */
export function toggleManualMode(current: SessionState["manualMode"], modeArg?: string): SessionState["manualMode"] {
  if (modeArg === "off") return false
  if (modeArg === "on") return "active"
  return current === false ? "active" : false
}

/** Human-readable label for the manual-mode flag. */
export function manualModeLabel(mode: SessionState["manualMode"]): string {
  if (mode === "active") return "ON"
  if (mode === "compress-pending") return "PENDING"
  return "OFF"
}

/** Render active block ids as a compact "b1, b3" list (or "none"). */
export function formatBlockList(blockIds: Iterable<number>): string {
  const ids = Array.from(blockIds)
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
  return ids.length > 0 ? ids.map((id) => `b${id}`).join(", ") : "none"
}

/** Format `ctx.getContextUsage()` into a single compact line. */
export function formatContextUsage(usage: ContextUsage | undefined): string {
  if (usage === undefined) return "unavailable"
  if (usage.tokens === null || usage.percent === null) {
    return `${usage.contextWindow} window (unknown usage)`
  }
  return `${usage.tokens} / ${usage.contextWindow} tokens (${usage.percent}%)`
}

/** Count currently-pruned messages (entries with an active compression block). */
export function countPrunedMessages(state: SessionState): number {
  let count = 0
  for (const entry of state.prune.messages.byMessageId.values()) {
    if (entry.activeBlockIds.length > 0) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

/** Build the plain-text panel summary used for the non-TUI notify fallback. */
function buildPanelSummary(ctx: ExtensionContext, state: SessionState): string {
  return [
    "DCP — Dynamic Context Pruning",
    `Context usage: ${formatContextUsage(ctx.getContextUsage())}`,
    `Compression blocks: ${state.prune.messages.activeBlockIds.size} active (${formatBlockList(state.prune.messages.activeBlockIds)})`,
    `Tokens pruned: ${state.stats.totalPruneTokens}`,
    `Tools pruned: ${state.prune.tools.size}`,
    `Messages pruned: ${countPrunedMessages(state)}`,
    `Manual mode: ${manualModeLabel(state.manualMode)}`
  ].join("\n")
}

/**
 * Open the `/dcp` panel via `ctx.ui.custom`. In non-TUI modes the same dataset
 * is surfaced through `ctx.ui.notify` (no terminal component host available).
 */
async function openPanel(ctx: ExtensionCommandContext, state: SessionState): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(buildPanelSummary(ctx, state), "info")
    return
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container()
    const border = new DynamicBorder((s: string) => theme.fg("accent", s))
    const row = (text: string, style: ThemeColor = "text") => container.addChild(new Text(theme.fg(style, text), 1, 0))
    const blank = () => container.addChild(new Text("", 0, 0))

    const modeStyle =
      state.manualMode === "active" ? "success" : state.manualMode === "compress-pending" ? "warning" : "dim"

    container.addChild(border)
    row(theme.bold("DCP — Dynamic Context Pruning"), "accent")
    blank()
    row(`Context usage: ${formatContextUsage(ctx.getContextUsage())}`)
    row(
      `Compression blocks: ${state.prune.messages.activeBlockIds.size} active (${formatBlockList(state.prune.messages.activeBlockIds)})`
    )
    row(`Tokens pruned: ${state.stats.totalPruneTokens}`)
    row(`Tools pruned: ${state.prune.tools.size}`)
    row(`Messages pruned: ${countPrunedMessages(state)}`)
    row(`Manual mode: ${manualModeLabel(state.manualMode)}`, modeStyle)
    blank()
    row("Enter or Esc to close", "dim")
    container.addChild(border)

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
          done(undefined)
        }
      }
    }
  })
}

/** `/dcp manual [on|off]` — toggle + persist manual mode, then notify. */
async function handleManualToggle(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  deps: DcpPanelDeps,
  modeArg?: string
): Promise<void> {
  const dcpState = deps.getDcpState()
  const state = Effect.runSync(dcpState.get())
  const next = toggleManualMode(state.manualMode, modeArg)

  Effect.runSync(dcpState.update((s) => ({ ...s, manualMode: next })))
  deps.saveState(pi, { ...state, manualMode: next })

  if (ctx.hasUI) ctx.ui.notify(next === "active" ? MANUAL_MODE_ON : MANUAL_MODE_OFF, "info")
}

// ---------------------------------------------------------------------------
// Command handler (wired by WP11 into pi.registerCommand("dcp", ...))
// ---------------------------------------------------------------------------

/**
 * Dispatch the `/dcp` subcommands. Never throws (Pi command contract): any
 * error is surfaced via `ctx.ui.notify` and swallowed.
 *
 *   /dcp                    -> open panel (stats/overview view)
 *   /dcp stats              -> open panel
 *   /dcp context            -> open panel
 *   /dcp manual [on|off]    -> toggle manual mode + persist
 *   /dcp <anything else>    -> usage hint
 */
export async function dcpPanelHandler(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  deps: DcpPanelDeps
): Promise<void> {
  try {
    if (deps.config.commands.enabled === false) return

    const { subcommand, subArgs } = parseSubcommand(args)

    if (subcommand === "manual") {
      await handleManualToggle(pi, ctx, deps, subArgs[0]?.toLowerCase())
      return
    }

    if (subcommand === "" || subcommand === "stats" || subcommand === "context") {
      const dcpState = deps.getDcpState()
      const state = Effect.runSync(dcpState.get())
      await openPanel(ctx, state)
      return
    }

    if (ctx.hasUI) ctx.ui.notify(`Unknown subcommand. ${USAGE_HINT}`, "warning")
  } catch (error) {
    if (ctx.hasUI) ctx.ui.notify(`DCP: ${String(error)}`, "error")
  }
}
