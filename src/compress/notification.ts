import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Box, Text } from "@earendil-works/pi-tui"
import type { ResolvedConfig } from "../core/config.js"

// ---------------------------------------------------------------------------
// Compression notifications
//
// Makes a compression pass visible in the transcript without sending the
// notification itself to the LLM. Mirrors opencode-dcp's `pruneNotification`
// behavior:
//
//   - "chat"  -> durable `CustomEntry` rendered in the TUI transcript via
//                `pi.registerEntryRenderer` (custom entries never enter LLM
//                context), the Pi equivalent of opencode's `ignored: true`.
//   - "toast" -> transient `ctx.ui.notify` toast.
//   - "off"   -> no notification.
//
// Only the `compress` tool emits these — automatic strategies (dedup /
// purgeErrors / supersededWrites) stay silent, matching the reference, where
// their totals remain visible through `/dcp`.
// ---------------------------------------------------------------------------

export interface CompressionNotificationData {
  /** Compress tool's `topic` argument. */
  topic: string
  /** Compression run id (state.prune.messages.nextRunId at the time). */
  runId: number
  /** Messages newly compressed by this pass (not previously compressed). */
  messageCount: number
  /** Tool ids newly compressed by this pass. */
  toolCount: number
  /** Tokens removed by this pass (0 while no tokenizer is wired). */
  tokensRemoved: number
  /** Cumulative tokens saved across the session. */
  tokensSavedTotal: number
}

const NOTIFICATION_ENTRY_TYPE = "dcp-notification"

/** Entry data persisted via `pi.appendEntry` and rendered by the entry renderer. */
export interface NotificationEntryData {
  topic: string
  runId: number
  messageCount: number
  toolCount: number
  tokensRemoved: number
  tokensSavedTotal: number
  timestamp: number
}

/** Human-readable token count: `1200` -> `1.2K`, else `1200`. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K")
  }
  return tokens.toString()
}

/** Build the single-line notification text used by both chat and toast modes. */
export function buildCompressionNotificationText(data: CompressionNotificationData): string {
  const label = `Compression #${data.runId}`

  const itemCounts =
    data.toolCount > 0 ? `${data.messageCount} messages and ${data.toolCount} tools` : `${data.messageCount} messages`

  const lines = [`▣ DCP | ${label}`, `→ Topic: ${data.topic}`, `→ Items: ${itemCounts} compressed`]

  // Token accounting is cosmetic until a tokenizer is wired; only show it when
  // non-zero so the notification never reads as a misleading "~0 saved".
  if (data.tokensRemoved > 0 || data.tokensSavedTotal > 0) {
    lines.splice(1, 0, `▣ ${label} -${formatTokenCount(data.tokensRemoved)} removed`)
    lines[0] = `▣ DCP | ~${formatTokenCount(data.tokensSavedTotal)} saved total`
  }

  return lines.join("\n")
}

/**
 * Emit a compression notification honoring `config.pruneNotification`.
 * Never throws — notification failure must not break the compress tool.
 */
export function notifyCompression(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: ResolvedConfig,
  data: CompressionNotificationData
): void {
  try {
    if (config.pruneNotification === "off") return

    if (config.pruneNotificationType === "toast") {
      if (ctx.hasUI) {
        ctx.ui.notify(buildCompressionNotificationText(data), "info")
      }
      return
    }

    // "chat": durable, visible, excluded from LLM context.
    pi.appendEntry<NotificationEntryData>(NOTIFICATION_ENTRY_TYPE, {
      topic: data.topic,
      runId: data.runId,
      messageCount: data.messageCount,
      toolCount: data.toolCount,
      tokensRemoved: data.tokensRemoved,
      tokensSavedTotal: data.tokensSavedTotal,
      timestamp: Date.now()
    })
  } catch {
    // Best-effort only; swallowing keeps the compress tool non-throwing.
  }
}

/**
 * Register the TUI renderer for `dcp-notification` entries so `chat`-mode
 * notifications appear as a styled line in the transcript. Idempotent — safe to
 * call once from the extension factory.
 */
export function registerNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<NotificationEntryData>(NOTIFICATION_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data
    if (data === undefined) return undefined

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text))
    const tokenSuffix =
      data.tokensRemoved > 0 ? ` ${theme.fg("dim", `-${formatTokenCount(data.tokensRemoved)} removed`)}` : ""
    box.addChild(
      new Text(`${theme.fg("accent", "▣ DCP")} ${theme.fg("text", `Compression #${data.runId}`)}${tokenSuffix}`, 0, 0)
    )

    const itemCounts =
      data.toolCount > 0 ? `${data.messageCount} messages, ${data.toolCount} tools` : `${data.messageCount} messages`
    box.addChild(new Text(theme.fg("dim", `Topic: ${data.topic} · ${itemCounts} compressed`), 0, 1))

    if (expanded) {
      box.addChild(new Text(theme.fg("dim", new Date(data.timestamp).toLocaleTimeString()), 0, 2))
    }

    return box
  })
}
