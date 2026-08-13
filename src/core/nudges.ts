import {
  type ContextEvent,
  type ExtensionContext,
  sessionEntryToContextMessages
} from "@earendil-works/pi-coding-agent"
import type { ContextLimit, ResolvedConfig } from "./config.js"
import type { SessionState } from "./state.js"

// ---------------------------------------------------------------------------
// Message type (mirrors src/prune.ts — AgentMessage is not re-exported from the
// pi-coding-agent root, so derive it from the ContextEvent contract).
// ---------------------------------------------------------------------------

export type AgentMessage = ContextEvent["messages"][number]

type TextContentBlock = { type: "text"; text: string }

// ---------------------------------------------------------------------------
// Nudge prompt constants (verbatim from lib/prompts/{context-limit,turn,iteration}-nudge.ts)
// ---------------------------------------------------------------------------

export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working messages unless it is clearly closed.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`

export const TURN_NUDGE = `<dcp-system-reminder>
Evaluate the conversation for compressible ranges.

If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them.
If direction has shifted, compress earlier ranges that are now less relevant.

The goal is to filter noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
</dcp-system-reminder>
`

export const ITERATION_NUDGE = `<dcp-system-reminder>
You've been iterating for a while after the last user message.

If there is a closed portion that is unlikely to be referenced immediately (for example, finished research before implementation), use the compress tool on it now.
</dcp-system-reminder>
`

// ---------------------------------------------------------------------------
// Guidance builders (ported from lib/prompts/extensions/nudge.ts — range mode)
// ---------------------------------------------------------------------------

/** List the active compressed blocks (`bN`) so the model can reference them. */
export function buildCompressedBlockGuidance(state: SessionState): string {
  const refs = Array.from(state.prune.messages.activeBlockIds)
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b)
    .map((id) => `b${id}`)
  const blockCount = refs.length
  const blockList = blockCount > 0 ? refs.join(", ") : "none"

  return [
    "Compressed block context:",
    `- Active compressed blocks in this session: ${blockCount} (${blockList})`,
    "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`."
  ].join("\n")
}

/** Append guidance text inside the `</dcp-system-reminder>` close tag. */
export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
  if (!guidance.trim()) return nudgeText

  const closeTag = "</dcp-system-reminder>"
  const closeTagIndex = nudgeText.lastIndexOf(closeTag)
  if (closeTagIndex === -1) return nudgeText

  const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
  const afterClose = nudgeText.slice(closeTagIndex)
  return `${beforeClose}\n\n${guidance}\n${afterClose}`
}

// ---------------------------------------------------------------------------
// Helpers (ported from lib/messages/inject/utils.ts — range mode, entry-id keys)
// ---------------------------------------------------------------------------

function getNudgeFrequency(config: ResolvedConfig): number {
  return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1))
}

function getIterationNudgeThreshold(config: ResolvedConfig): number {
  return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))
}

function resolveContextTokenLimit(limit: ContextLimit, contextWindow: number): number | undefined {
  if (typeof limit === "number") return limit

  // `${number}%` of the model context window.
  const parsedPercent = parseFloat(limit.slice(0, -1))
  if (Number.isNaN(parsedPercent)) return undefined

  const clampedPercent = Math.max(0, Math.min(100, Math.round(parsedPercent)))
  return Math.round((clampedPercent / 100) * contextWindow)
}

function countMessagesAfterIndex(messages: AgentMessage[], index: number): number {
  let count = 0
  for (let i = index + 1; i < messages.length; i++) {
    count++
  }
  return count
}

function findLastUserIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}

function findLastAssistant(messages: AgentMessage[]): { message: AgentMessage; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === "assistant") return { message, index: i }
  }
  return null
}

function messageHasCompress(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false
  return message.content.some((block) => block.type === "toolCall" && block.name === "compress")
}

function addAnchor(
  anchorSet: Set<string>,
  anchorEntryId: string,
  anchorIndex: number,
  entryIds: string[],
  interval: number
): boolean {
  if (anchorIndex < 0) return false

  let latestAnchorIndex = -1
  for (let i = entryIds.length - 1; i >= 0; i--) {
    const entryId = entryIds[i]
    if (entryId === undefined) continue
    if (anchorSet.has(entryId)) {
      latestAnchorIndex = i
      break
    }
  }

  const shouldAdd = latestAnchorIndex < 0 || anchorIndex - latestAnchorIndex >= interval
  if (!shouldAdd) return false

  const previousSize = anchorSet.size
  anchorSet.add(anchorEntryId)
  return anchorSet.size !== previousSize
}

// ---------------------------------------------------------------------------
// Injection (Pi adaptation of injectAnchoredNudge / appendToTextPart)
// ---------------------------------------------------------------------------

function appendToTextBlock(block: TextContentBlock, injection: string): boolean {
  if (typeof block.text !== "string") return false

  const normalizedInjection = injection.replace(/^\n+/, "")
  if (!normalizedInjection.trim()) return false
  if (block.text.includes(normalizedInjection)) return true

  const baseText = block.text.replace(/\n*$/, "")
  block.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
  return true
}

function hasContent(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
  return message.content.some(
    (block) => (block.type === "text" && block.text.trim().length > 0) || block.type === "toolCall"
  )
}

function injectAnchoredNudge(message: AgentMessage, nudgeText: string): void {
  if (!nudgeText.trim()) return

  if (message.role === "user") {
    if (typeof message.content === "string") {
      message.content = [{ type: "text" as const, text: message.content }]
    }
    const content = message.content
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i]
      if (block !== undefined && block.type === "text" && appendToTextBlock(block, nudgeText)) {
        return
      }
    }
    content.push({ type: "text", text: nudgeText })
    return
  }

  if (message.role !== "assistant") return
  if (!hasContent(message)) return

  for (const block of message.content) {
    if (block.type === "text" && appendToTextBlock(block, nudgeText)) return
  }

  const synthetic: TextContentBlock = { type: "text", text: nudgeText }
  const firstToolIndex = message.content.findIndex((block) => block.type === "toolCall")
  if (firstToolIndex === -1) {
    message.content.push(synthetic)
  } else {
    message.content.splice(firstToolIndex, 0, synthetic)
  }
}

function collectAnchoredMessages(
  anchorSet: Set<string>,
  messages: AgentMessage[],
  entryIds: string[]
): Array<{ message: AgentMessage; index: number }> {
  const anchored: Array<{ message: AgentMessage; index: number }> = []
  for (const anchorEntryId of anchorSet) {
    const index = entryIds.indexOf(anchorEntryId)
    if (index === -1) continue
    const message = messages[index]
    if (message === undefined) continue
    anchored.push({ message, index })
  }
  return anchored
}

function collectTurnNudgeAnchors(
  state: SessionState,
  config: ResolvedConfig,
  messages: AgentMessage[],
  entryIds: string[]
): Set<string> {
  const turnNudgeAnchors = new Set<string>()
  const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant"

  for (let i = 0; i < messages.length; i++) {
    const entryId = entryIds[i]
    const message = messages[i]
    if (entryId === undefined || message === undefined) continue
    if (!state.nudges.turnNudgeAnchors.has(entryId)) continue
    if (message.role === targetRole) turnNudgeAnchors.add(entryId)
  }

  return turnNudgeAnchors
}

function applyRangeModeAnchoredNudge(
  anchorSet: Set<string>,
  messages: AgentMessage[],
  entryIds: string[],
  baseNudgeText: string,
  compressedBlockGuidance: string
): void {
  const nudgeText = appendGuidanceToDcpTag(baseNudgeText, compressedBlockGuidance)
  if (!nudgeText.trim()) return

  for (const { message } of collectAnchoredMessages(anchorSet, messages, entryIds)) {
    injectAnchoredNudge(message, nudgeText)
  }
}

function applyAnchoredNudges(
  state: SessionState,
  config: ResolvedConfig,
  messages: AgentMessage[],
  entryIds: string[]
): void {
  const turnNudgeAnchors = collectTurnNudgeAnchors(state, config, messages, entryIds)
  const compressedBlockGuidance = buildCompressedBlockGuidance(state)

  applyRangeModeAnchoredNudge(
    state.nudges.contextLimitAnchors,
    messages,
    entryIds,
    CONTEXT_LIMIT_NUDGE,
    compressedBlockGuidance
  )
  applyRangeModeAnchoredNudge(turnNudgeAnchors, messages, entryIds, TURN_NUDGE, compressedBlockGuidance)
  applyRangeModeAnchoredNudge(
    state.nudges.iterationNudgeAnchors,
    messages,
    entryIds,
    ITERATION_NUDGE,
    compressedBlockGuidance
  )
}

// ---------------------------------------------------------------------------
// Entry-id pairing (mirrors src/prune.ts applyCompressedRanges)
// ---------------------------------------------------------------------------

function buildEntryIds(ctx: ExtensionContext, messages: AgentMessage[]): string[] | null {
  const contextEntries = ctx.sessionManager.buildContextEntries()
  const entryIds: string[] = []
  for (const entry of contextEntries) {
    if (sessionEntryToContextMessages(entry).length > 0) {
      entryIds.push(entry.id)
    }
  }

  // Defensive: bail on entry<->message drift rather than mis-assign anchor ids.
  if (entryIds.length !== messages.length) return null
  return entryIds
}

// ---------------------------------------------------------------------------
// Nudge injection (ported from lib/messages/inject/inject.ts injectCompressNudges)
// ---------------------------------------------------------------------------

/**
 * Inject compress nudges into the context `messages` copy. Anchors are keyed on
 * branch ENTRY ids (Pi messages carry no stable id). `state` is mutated (anchor
 * Sets); persistence is the caller's (WP11) responsibility. Range mode only —
 * message-mode compress is out of scope. Never throws.
 */
export function injectNudges(
  messages: AgentMessage[],
  ctx: ExtensionContext,
  state: SessionState,
  config: ResolvedConfig
): AgentMessage[] {
  try {
    if ((state.compressPermission ?? config.compress.permission) === "deny") return messages
    if (state.manualMode !== false) return messages

    // Compress in flight: stop nudging once the last assistant asked to compress.
    const lastAssistant = findLastAssistant(messages)
    if (lastAssistant !== null && messageHasCompress(lastAssistant.message)) {
      state.nudges.contextLimitAnchors.clear()
      state.nudges.turnNudgeAnchors.clear()
      state.nudges.iterationNudgeAnchors.clear()
      return messages
    }

    const usage = ctx.getContextUsage()
    if (usage === undefined) return messages
    const tokens = usage.tokens ?? 0

    const maxLimit = resolveContextTokenLimit(config.compress.maxContextLimit, usage.contextWindow)
    const minLimit = resolveContextTokenLimit(config.compress.minContextLimit, usage.contextWindow)
    const overMaxLimit = maxLimit === undefined ? false : tokens > maxLimit
    const overMinLimit = minLimit === undefined ? true : tokens >= minLimit

    const entryIds = buildEntryIds(ctx, messages)
    if (entryIds === null) return messages

    if (!overMinLimit) {
      state.nudges.turnNudgeAnchors.clear()
      state.nudges.iterationNudgeAnchors.clear()
    }

    const lastIndex = messages.length - 1
    const lastMessage = messages[lastIndex]
    const lastEntryId = entryIds[lastIndex]
    const interval = getNudgeFrequency(config)

    if (overMaxLimit) {
      if (lastMessage !== undefined && lastEntryId !== undefined) {
        addAnchor(state.nudges.contextLimitAnchors, lastEntryId, lastIndex, entryIds, interval)
      }
    } else if (overMinLimit) {
      if (lastMessage?.role === "user" && lastAssistant !== null) {
        if (lastEntryId !== undefined) state.nudges.turnNudgeAnchors.add(lastEntryId)
        const lastAssistantEntryId = entryIds[lastAssistant.index]
        if (lastAssistantEntryId !== undefined) state.nudges.turnNudgeAnchors.add(lastAssistantEntryId)
      }

      const lastUserIndex = findLastUserIndex(messages)
      if (lastUserIndex >= 0 && lastMessage !== undefined && lastEntryId !== undefined) {
        const messagesSinceUser = countMessagesAfterIndex(messages, lastUserIndex)
        if (lastIndex > lastUserIndex && messagesSinceUser >= getIterationNudgeThreshold(config)) {
          addAnchor(state.nudges.iterationNudgeAnchors, lastEntryId, lastIndex, entryIds, interval)
        }
      }
    }

    applyAnchoredNudges(state, config, messages, entryIds)
    return messages
  } catch {
    return messages
  }
}
