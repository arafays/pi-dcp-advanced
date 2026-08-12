import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import type { ResolvedConfig } from "./config.js"
import type { SessionState } from "./state.js"

// ---------------------------------------------------------------------------
// DCP system-prompt block (ported from ../lib/prompts/system.ts and
// ../lib/prompts/extensions/system.ts). The SYSTEM_PROMPT text is the
// compress-range usage instructions (when/what to compress); the extensions
// carry the protected-tools list and the manual-mode reminder.
// ---------------------------------------------------------------------------

const DCP_HEADER = "<!-- Dynamic Context Pruning (DCP) -->"

const SYSTEM_PROMPT = `You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is \`compress\`. It replaces older conversation content with technical summaries you produce.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.

THE PHILOSOPHY OF COMPRESS
\`compress\` transforms conversation content into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

COMPRESS WHEN

A section is genuinely closed and the raw conversation has served its purpose:

- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded without waiting for a whole chapter to close

DO NOT COMPRESS IF

- Raw context is still relevant and needed for edits or precise references
- The target content is still actively in progress
- You may need exact code, error messages, or file contents in the immediate next steps

Before compressing, ask: _"Is this section closed enough to become summary-only right now?"_

Evaluate conversation signal-to-noise REGULARLY. Use \`compress\` deliberately with quality-first summaries. Prioritize stale content intelligently to maintain a high-signal context window that supports your agency.

It is of your responsibility to keep a sharp, high-quality context window for optimal performance.`

const MANUAL_MODE_EXTENSION = `<dcp-system-reminder>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

Only use the compress tool after seeing \`<compress triggered manually>\` in the current user instruction context.

Issue exactly ONE compress tool per manual trigger. Do NOT launch multiple compress tools in parallel. Each trigger grants a single compression; after it completes, wait for the next trigger.

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</dcp-system-reminder>`

function buildProtectedToolsExtension(protectedTools: readonly string[]): string {
  if (protectedTools.length === 0) {
    return ""
  }
  const toolList = protectedTools.map((t) => `\`${t}\``).join(", ")
  return `<dcp-system-reminder>
The following tools are environment-managed: ${toolList}.
Their outputs are automatically preserved during compression.
Do not include their content in compress tool summaries — the environment retains it independently.
</dcp-system-reminder>`
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Manual-mode state value carried on SessionState (false = off). */
export type ManualMode = SessionState["manualMode"]

/**
 * Renders the DCP system-prompt block for a single agent start.
 *
 * The protected-tools list is the union of `commands.protectedTools` and
 * `compress.protectedTools` (deduplicated, order-preserving). The manual-mode
 * reminder is appended only when `manualMode !== false`.
 */
export function renderSystemPrompt(config: ResolvedConfig, manualMode: ManualMode): string {
  const protectedTools = [...new Set([...config.commands.protectedTools, ...config.compress.protectedTools])]
  const parts: string[] = [DCP_HEADER, SYSTEM_PROMPT]
  if (protectedTools.length > 0) {
    parts.push(buildProtectedToolsExtension(protectedTools))
  }
  if (manualMode !== false) {
    parts.push(MANUAL_MODE_EXTENSION)
  }
  return parts
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .replace(/\n([ \t]*\n)+/g, "\n\n")
    .trim()
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const SUMMARIZER_SIGNATURES = ["Summarize what was done", "You are a conversation summarizer"]

const isSummarizerPrompt = (systemPrompt: string): boolean => {
  const haystack = systemPrompt.toLowerCase()
  return SUMMARIZER_SIGNATURES.some((signature) => haystack.includes(signature.toLowerCase()))
}

/**
 * Builds the `before_agent_start` hook handler. The handler appends the DCP
 * block to the current system prompt, except for summarizer/compaction agents,
 * which are skipped (the Pi analog of DCP's internal-agent skip).
 *
 * `getState` must return a *synchronous* Effect (the DcpState service's
 * `Ref`-backed `get()` qualifies), so the handler can run it with
 * `Effect.runSync`. The handler never throws: on any error it returns `{}`,
 * leaving the system prompt untouched.
 */
export function onBeforeAgentStart(
  _pi: ExtensionAPI,
  config: ResolvedConfig,
  getState: () => Effect.Effect<SessionState>
): (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult {
  return (event) => {
    try {
      if (isSummarizerPrompt(event.systemPrompt)) {
        return {}
      }
      const state = Effect.runSync(getState())
      return { systemPrompt: `${event.systemPrompt}\n\n${renderSystemPrompt(config, state.manualMode)}` }
    } catch {
      return {}
    }
  }
}
