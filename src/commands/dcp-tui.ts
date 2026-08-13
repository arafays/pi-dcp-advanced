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
// /dcp TUI panel
//
// Multi-view session panel built on Pi's `ctx.ui.custom` imperative component
// API using pi-tui imperative components:
//
//   main    — navigation (Context / Stats) + manual-mode toggle + compress hint
//   context — total context tokens + % of window + pruned counts
//   stats   — session savings (tokens, summary size, ratio, time, pruned counts)
//
// This mirrors opencode-dcp's `lib/tui` PanelDialog/ContextDialog/StatsDialog,
// scoped to the data Pi exposes (`ctx.getContextUsage()` + DCP session state).
// The command itself is NOT registered here — src/main.ts wires
// `pi.registerCommand` and calls `dcpPanelHandler`.
// ---------------------------------------------------------------------------

const MANUAL_MODE_ON = "Manual mode is now ON. Use /dcp-compress to trigger context tools manually."
const MANUAL_MODE_OFF = "Manual mode is now OFF."

const USAGE_HINT = "Usage: /dcp [stats|manual [on|off]|context]"

/**
 * Dependencies injected by src/main.ts. The handler stays side-effect
 * free with respect to Pi registration: it only reads/writes state through
 * these accessors.
 */
export interface DcpPanelDeps {
  /** Resolved DCP config (for `commands.enabled`). */
  config: ResolvedConfig
  /** Resolve the live DcpState service (get/update over `SessionState`). */
  getDcpState: () => DcpStateService
  /** Persist the reload-relevant state slice via `saveState`. */
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
 * Manual-mode toggle semantics:
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

/** Human-readable token count: `1200` -> `1.2K`, else `1200`. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K")
  }
  return tokens.toString()
}

/** Human-readable duration: `900` -> `900 ms`, `1500` -> `1.5 s`, `125000` -> `2m 5s`. */
export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms))
  if (safeMs < 1000) return `${safeMs} ms`

  const totalSeconds = safeMs / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`

  const wholeSeconds = Math.floor(totalSeconds)
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const seconds = wholeSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  return `${minutes}m ${seconds}s`
}

/** Compression ratio `in:out` (tokens saved : summary tokens), mirroring opencode-dcp. */
export function formatCompressionRatio(saved: number, summary: number): string {
  if (saved <= 0) return "0:1"
  if (summary <= 0) return "∞:1"
  return `${Math.max(1, Math.round(saved / summary))}:1`
}

/** Aggregate session savings for the Stats view. */
export interface SessionStatsView {
  tokensSaved: number
  summaryTokens: number
  compressionRatio: string
  compressionDurationMs: number
  toolsPruned: number
  messagesPruned: number
}

export function computeSessionStats(state: SessionState): SessionStatsView {
  const activeBlocks = Array.from(state.prune.messages.blocksById.values()).filter((b) => b.active)
  const tokensSaved = state.stats.totalPruneTokens
  const summaryTokens = activeBlocks.reduce((sum, b) => sum + b.summaryTokens, 0)
  const compressionDurationMs = activeBlocks.reduce((sum, b) => sum + b.durationMs, 0)

  return {
    tokensSaved,
    summaryTokens,
    compressionRatio: formatCompressionRatio(tokensSaved, summaryTokens),
    compressionDurationMs,
    toolsPruned: state.prune.tools.size,
    messagesPruned: countPrunedMessages(state)
  }
}

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

/** Build the plain-text panel summary used for the non-TUI notify fallback. */
function buildPanelSummary(ctx: ExtensionContext, state: SessionState): string {
  const stats = computeSessionStats(state)
  return [
    "DCP — Dynamic Context Pruning",
    `Context usage: ${formatContextUsage(ctx.getContextUsage())}`,
    `Compression blocks: ${state.prune.messages.activeBlockIds.size} active (${formatBlockList(state.prune.messages.activeBlockIds)})`,
    `Tokens pruned: ${state.stats.totalPruneTokens}`,
    `Summary size: ~${formatTokenCount(stats.summaryTokens)}`,
    `Compression ratio: ${stats.compressionRatio}`,
    `Compression time: ${formatDuration(stats.compressionDurationMs)}`,
    `Tools pruned: ${state.prune.tools.size}`,
    `Messages pruned: ${countPrunedMessages(state)}`,
    `Manual mode: ${manualModeLabel(state.manualMode)}`
  ].join("\n")
}

type PanelView = "main" | "context" | "stats"

/** Navigation rows for the main view (index order matters for selection). */
interface MainNavItem {
  label: string
  detail: string
  view: Exclude<PanelView, "main">
}

const MAIN_NAV: MainNavItem[] = [
  { label: "Context", detail: "Token usage", view: "context" },
  { label: "Stats", detail: "Savings", view: "stats" }
]

/**
 * Open the `/dcp` panel via `ctx.ui.custom`. In non-TUI modes the same dataset
 * is surfaced through `ctx.ui.notify` (no terminal component host available).
 *
 * `view` is the starting sub-view; the component keeps its own navigation state
 * (up/down select, enter activate, esc back/close).
 */
async function openPanel(ctx: ExtensionCommandContext, state: SessionState, view: PanelView): Promise<void> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(buildPanelSummary(ctx, state), "info")
    return
  }

  await ctx.ui.custom((tui, theme, _kb, done) => {
    let currentView: PanelView = view
    let selected = 0
    const stats = computeSessionStats(state)
    const border = new DynamicBorder((s: string) => theme.fg("accent", s))

    const row = (container: Container, text: string, style: ThemeColor = "text", paddingX = 1) =>
      container.addChild(new Text(theme.fg(style, text), paddingX, 0))
    const blank = (container: Container) => container.addChild(new Text("", 0, 0))
    const heading = (container: Container, text: string) => {
      container.addChild(border)
      row(container, theme.bold(text), "accent")
      blank(container)
    }
    const footer = (container: Container) => {
      blank(container)
      row(container, footerHint(), "dim")
      container.addChild(border)
    }

    const footerHint = (): string => {
      if (currentView === "main") return "↑/↓ navigate · Enter open · Esc close"
      return "Esc back · Enter close"
    }

    const render = (width: number): string[] => {
      const container = new Container()

      if (currentView === "main") {
        heading(container, "DCP — Dynamic Context Pruning")
        row(container, theme.fg("accent", "Views"), "accent")
        row(container, selectPrefix(0) + theme.fg("text", "Context") + theme.fg("dim", " · Token usage"))
        row(container, selectPrefix(1) + theme.fg("text", "Stats") + theme.fg("dim", " · Savings"))
        blank(container)
        row(container, theme.fg("accent", "Session"), "accent")
        const mode = state.manualMode
        const modeStyle = mode === "active" ? "success" : mode === "compress-pending" ? "warning" : "dim"
        row(container, theme.fg("text", "Manual mode") + theme.fg(modeStyle, `  ${manualModeLabel(mode)}`))
        row(container, theme.fg("dim", "/dcp-compress [focus] — ask the model to compress"))
        footer(container)
      } else if (currentView === "context") {
        heading(container, "DCP — Context")
        const usage = ctx.getContextUsage()
        row(container, `Total in context: ${formatContextUsage(usage)}`)
        blank(container)
        row(container, theme.fg("accent", "Pruned"), "accent")
        row(container, `Tools pruned: ${state.prune.tools.size}`)
        row(container, `Messages pruned: ${countPrunedMessages(state)}`)
        row(container, `Tokens pruned: ~${formatTokenCount(stats.tokensSaved)}`)
        blank(container)
        row(
          container,
          `Compression blocks: ${state.prune.messages.activeBlockIds.size} active (${formatBlockList(state.prune.messages.activeBlockIds)})`
        )
        footer(container)
      } else {
        heading(container, "DCP — Stats")
        row(container, theme.fg("accent", "Session"), "accent")
        row(container, `Tokens saved:   ~${formatTokenCount(stats.tokensSaved)}`)
        row(container, `Summary size:   ~${formatTokenCount(stats.summaryTokens)}`)
        row(container, `Compression ratio: ${stats.compressionRatio}`)
        row(container, `Compression time:  ${formatDuration(stats.compressionDurationMs)}`)
        blank(container)
        row(container, `Tools pruned:    ${stats.toolsPruned}`)
        row(container, `Messages pruned: ${stats.messagesPruned}`)
        footer(container)
      }

      return container.render(width)
    }

    const selectPrefix = (index: number): string => {
      if (currentView !== "main") return ""
      return selected === index ? theme.fg("accent", "› ") : "  "
    }

    const handleInput = (data: string): void => {
      if (matchesKey(data, "escape")) {
        if (currentView === "main") {
          done(undefined)
        } else {
          currentView = "main"
          selected = 0
        }
        tui.requestRender()
        return
      }

      if (currentView === "main") {
        if (matchesKey(data, "up")) {
          selected = Math.max(0, selected - 1)
          tui.requestRender()
        } else if (matchesKey(data, "down")) {
          selected = Math.min(MAIN_NAV.length - 1, selected + 1)
          tui.requestRender()
        } else if (matchesKey(data, "enter")) {
          const item = MAIN_NAV[selected]
          if (item === undefined) return
          currentView = item.view
          tui.requestRender()
        }
        return
      }

      // context / stats views: Enter or Esc closes (Esc already handled above).
      if (matchesKey(data, "enter")) {
        done(undefined)
      }
    }

    return {
      render,
      invalidate: () => border.invalidate(),
      handleInput
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
// Command handler (wired by src/main.ts into pi.registerCommand("dcp", ...))
// ---------------------------------------------------------------------------

/**
 * Dispatch the `/dcp` subcommands. Never throws (Pi command contract): any
 * error is surfaced via `ctx.ui.notify` and swallowed.
 *
 *   /dcp                    -> open panel (main view)
 *   /dcp stats              -> open panel (stats view)
 *   /dcp context            -> open panel (context view)
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
      const view: PanelView = subcommand === "stats" ? "stats" : subcommand === "context" ? "context" : "main"
      await openPanel(ctx, state, view)
      return
    }

    if (ctx.hasUI) ctx.ui.notify(`Unknown subcommand. ${USAGE_HINT}`, "warning")
  } catch (error) {
    if (ctx.hasUI) ctx.ui.notify(`DCP: ${String(error)}`, "error")
  }
}
