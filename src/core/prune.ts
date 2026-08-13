import {
  type ContextEvent,
  type ExtensionContext,
  type SessionEntry,
  sessionEntryToContextMessages
} from "@earendil-works/pi-coding-agent"
import type { ResolvedConfig } from "./config.js"
import type { CompressionBlock, SessionState } from "./state.js"

// ---------------------------------------------------------------------------
// Message types
//
// `AgentMessage` is not exported from `@earendil-works/pi-coding-agent`'s root
// entry point (it is declared in the transitive `@earendil-works/pi-agent-core`
// package), so derive it from the exported `ContextEvent` contract.
// ---------------------------------------------------------------------------

export type AgentMessage = ContextEvent["messages"][number]
export type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>
export type CustomMessage = Extract<AgentMessage, { role: "custom" }>

// ---------------------------------------------------------------------------
// Replacement strings (exact wording from the DCP source)
// ---------------------------------------------------------------------------

export const PRUNED_TOOL_OUTPUT_REPLACEMENT =
  "[Output removed to save context - information superseded or no longer needed]"
export const PRUNED_TOOL_ERROR_REPLACEMENT = "[input removed due to failed tool call]"
export const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

// ---------------------------------------------------------------------------
// Protected-pattern matching
// ---------------------------------------------------------------------------

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/")
}

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/

function escapeRegExpChar(ch: string): string {
  return REGEX_SPECIAL_CHARS.test(ch) ? `\\${ch}` : ch
}

/** Glob match (supports `*`, `**`, and `?` wildcards) against normalized forward-slash paths. */
export function matchesGlob(inputPath: string, pattern: string): boolean {
  if (!pattern) return false

  const input = normalizePath(inputPath)
  const pat = normalizePath(pattern)

  let regex = "^"
  for (let i = 0; i < pat.length; i++) {
    const ch = pat.charAt(i)

    if (ch === "*") {
      const next = pat.charAt(i + 1)
      if (next === "*") {
        const after = pat.charAt(i + 2)
        if (after === "/") {
          regex += "(?:.*/)?"
          i += 2
          continue
        }
        regex += ".*"
        i++
        continue
      }
      regex += "[^/]*"
      continue
    }

    if (ch === "?") {
      regex += "[^/]"
      continue
    }

    if (ch === "/") {
      regex += "/"
      continue
    }

    regex += escapeRegExpChar(ch)
  }
  regex += "$"

  return new RegExp(regex).test(input)
}

/** Extract candidate file paths from a tool call's arguments (`filePath` and `path`). */
export function getFilePathsFromParameters(_tool: string, parameters: unknown): string[] {
  if (typeof parameters !== "object" || parameters === null) return []

  const params = parameters as Record<string, unknown>
  const paths: string[] = []

  if (typeof params.filePath === "string") {
    paths.push(params.filePath)
  }
  if (typeof params.path === "string") {
    paths.push(params.path)
  }

  return [...new Set(paths)].filter((p) => p.length > 0)
}

export function isFilePathProtected(filePaths: readonly string[], patterns: readonly string[]): boolean {
  if (filePaths.length === 0) return false
  if (patterns.length === 0) return false
  return filePaths.some((path) => patterns.some((pattern) => matchesGlob(path, pattern)))
}

const GLOB_CHARS = /[*?]/

export function isToolNameProtected(toolName: string, patterns: readonly string[]): boolean {
  if (!toolName || patterns.length === 0) return false

  const exactPatterns = new Set<string>()
  const globPatterns: string[] = []

  for (const pattern of patterns) {
    if (GLOB_CHARS.test(pattern)) {
      globPatterns.push(pattern)
    } else {
      exactPatterns.add(pattern)
    }
  }

  if (exactPatterns.has(toolName)) return true
  return globPatterns.some((pattern) => matchesGlob(toolName, pattern))
}

// ---------------------------------------------------------------------------
// Prune steps (operate in place on a copy supplied by `prune`)
// ---------------------------------------------------------------------------

/**
 * Replace the text blocks of tool outputs marked in `state.prune.tools` (by the
 * dedup strategy) with the placeholder. Protected tools (config.commands.
 * protectedTools) and tools whose args match a protected file pattern are left
 * untouched. Error results are handled by `pruneToolErrors`.
 */
export function pruneToolOutputs(messages: AgentMessage[], state: SessionState, config: ResolvedConfig): void {
  for (const message of messages) {
    if (message.role !== "toolResult") continue
    if (message.isError) continue
    if (isToolNameProtected(message.toolName, config.commands.protectedTools)) continue
    if (!state.prune.tools.has(message.toolCallId)) continue

    const parameters = state.toolParameters.get(message.toolCallId)?.parameters
    const filePaths = getFilePathsFromParameters(message.toolName, parameters)
    if (isFilePathProtected(filePaths, config.protectedFilePatterns)) continue

    message.content = message.content.map((block) =>
      block.type === "text" ? { ...block, text: PRUNED_TOOL_OUTPUT_REPLACEMENT } : block
    )
  }
}

/**
 * Mark-then-apply: clear the verbose `details` of errored tool results that
 * were marked for pruning (by `purgeErrors` / `deduplicate`, which write
 * `state.prune.tools`). Protected-tool and turn-threshold gating already
 * happened at mark time, so this is a pure applier. In Pi the verbose error
 * payload lives on `ToolResultMessage.details`.
 */
export function pruneToolErrors(messages: AgentMessage[], state: SessionState): void {
  if (state.prune.tools.size === 0) return

  for (const message of messages) {
    if (message.role !== "toolResult") continue
    if (!message.isError) continue
    if (!state.prune.tools.has(message.toolCallId)) continue

    delete message.details
  }
}

const FILE_MUTATION_TOOLS = new Set(["write", "edit"])

/**
 * Whether a marked tool-call id should have its WHOLE toolCall+result pair
 * dropped by `dropSupersededWrites`. Only completed write/edit calls qualify.
 *
 * The `status === "completed"` gate is what scopes the applier: `supersededWrites`
 * only marks completed write/edit calls, and `purgeErrors` only marks errored
 * ones (which stay untouched here — their error text is signal). `deduplicate`
 * may also mark a completed write/edit with identical content; dropping those is
 * still correct (an identical later write genuinely supersedes the earlier one),
 * so no separate mark set is needed.
 */
function isSupersededFileWrite(id: string, state: SessionState): boolean {
  if (!state.prune.tools.has(id)) return false
  return state.toolParameters.get(id)?.status === "completed"
}

/**
 * Drop superseded write/edit tool calls atomically: remove the assistant
 * `toolCall` block AND its matching `toolResult` message together, so no
 * orphaned `tool` role message (or assistant toolCall without a result)
 * survives to the provider. The large payload lives in the assistant
 * `toolCall.arguments` (`{ path, content }` / `{ path, edits[] }`), not the
 * ~40-byte toolResult text — so a result-only placeholder would save nothing.
 *
 * Gating (protected tools, protected file patterns, enabled, manual mode) was
 * already applied at mark time by the `supersededWrites` strategy; this is a
 * pure applier over `state.prune.tools`.
 */
export function dropSupersededWrites(messages: AgentMessage[], state: SessionState): void {
  if (state.prune.tools.size === 0) return

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message === undefined) continue

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const filtered = message.content.filter((block) => {
        if (block.type !== "toolCall") return true
        if (!FILE_MUTATION_TOOLS.has(block.name)) return true
        return !isSupersededFileWrite(block.id, state)
      })

      if (filtered.length === 0) {
        messages.splice(i, 1)
      } else if (filtered.length !== message.content.length) {
        message.content = filtered
      }
      continue
    }

    if (message.role === "toolResult") {
      if (!FILE_MUTATION_TOOLS.has(message.toolName)) continue
      if (isSupersededFileWrite(message.toolCallId, state)) {
        messages.splice(i, 1)
      }
    }
  }
}

function makeCompressionSummaryMessage(block: CompressionBlock): CustomMessage {
  return {
    role: "custom",
    customType: "dcp-compression-summary",
    content: block.summary,
    display: false,
    details: { blockId: block.blockId },
    timestamp: Date.now()
  }
}

/**
 * Drop messages whose branch entry id sits inside an active compression range
 * and inject a `dcp-compression-summary` CustomMessage at each active anchor.
 *
 * `ctx.sessionManager.buildContextEntries()` returns the compaction-aware entry
 * list that produced the context `messages` array, and
 * `sessionEntryToContextMessages` is Pi's exact entry->AgentMessage projection
 * (each entry yields 0 or 1 message), so message-producing entries pair 1:1
 * with `messages` by index. When `ctx` is omitted, range application is skipped.
 */
export function applyCompressedRanges(messages: AgentMessage[], state: SessionState, ctx?: ExtensionContext): void {
  if (ctx === undefined) return
  if (state.prune.messages.byMessageId.size === 0 && state.prune.messages.activeByAnchorMessageId.size === 0) {
    return
  }

  const contextEntries: SessionEntry[] = ctx.sessionManager.buildContextEntries()
  const entryIds: string[] = []
  for (const entry of contextEntries) {
    if (sessionEntryToContextMessages(entry).length > 0) {
      entryIds.push(entry.id)
    }
  }

  // Defensive: if the entry<->message mapping drifted (Pi internals changed or
  // an entry unexpectedly yields >1 message), bail rather than mis-assign entry
  // ids and corrupt the session. The caller's messages are left untouched.
  if (entryIds.length !== messages.length) return

  const result: AgentMessage[] = []
  // Tool-call ids whose assistant message was dropped by a compression range.
  // Their tool results (which follow the assistant and may sit OUTSIDE the
  // range) must be dropped too, or the provider rejects the orphaned `tool`
  // role message (no preceding assistant tool_calls).
  const droppedToolCallIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message === undefined) continue

    const entryId = entryIds[i]

    if (entryId !== undefined) {
      const blockId = state.prune.messages.activeByAnchorMessageId.get(entryId)
      if (blockId !== undefined) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (block?.active === true && typeof block.summary === "string" && block.summary.length > 0) {
          result.push(makeCompressionSummaryMessage(block))
        }
      }
    }

    if (entryId !== undefined) {
      const pruneEntry = state.prune.messages.byMessageId.get(entryId)
      if (pruneEntry !== undefined && pruneEntry.activeBlockIds.length > 0) {
        // Record the tool calls of a dropped assistant so their results are
        // dropped too, keeping [assistant tool_calls + tool results] atomic.
        if (message.role === "assistant" && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === "toolCall" && typeof block.id === "string") {
              droppedToolCallIds.add(block.id)
            }
          }
        }
        continue
      }
    }

    // Orphan-proofing: drop a tool result whose assistant tool call was dropped.
    if (message.role === "toolResult" && droppedToolCallIds.has(message.toolCallId)) {
      continue
    }

    result.push(message)
  }

  messages.length = 0
  messages.push(...result)
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function copyMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => ({ ...message }))
}

/**
 * Prune a deep-copy of the context messages: apply compressed ranges, then
 * prune marked tool outputs, then clear stale error details. Non-mutating with
 * respect to the caller's array; never throws — on any error the original
 * `messages` are returned unchanged.
 */
export function prune(
  messages: AgentMessage[],
  state: SessionState,
  config: ResolvedConfig,
  ctx?: ExtensionContext
): AgentMessage[] {
  try {
    const result = copyMessages(messages)
    applyCompressedRanges(result, state, ctx)
    dropSupersededWrites(result, state)
    pruneToolOutputs(result, state, config)
    pruneToolErrors(result, state)
    return result
  } catch {
    return messages
  }
}
