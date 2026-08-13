import { Type } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  sessionEntryToContextMessages
} from "@earendil-works/pi-coding-agent"
import type { ResolvedConfig } from "../core/config.js"
import { getFilePathsFromParameters, isFilePathProtected, isToolNameProtected } from "../core/prune.js"
import {
  allocateBlockId,
  allocateRunId,
  applyCompressionState,
  type BoundaryReference,
  type CompressionBlock,
  type SelectionResolution,
  type SessionState,
  saveState
} from "../core/state.js"
import { notifyCompression } from "./notification.js"

// ---------------------------------------------------------------------------
// Prompts (verbatim from the DCP source)
// ---------------------------------------------------------------------------

export const COMPRESS_RANGE = `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`(bN)\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Compressed block IDs always use the \`bN\` form (never \`mNNNN\`) and are represented in the same XML metadata tag format.

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`(bN)\` placeholders as RESERVED TOKENS. Do not emit \`(bN)\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (not as a placeholder).
- Preflight check before finalizing: the set of \`(bN)\` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in \`(b2)\`").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`

export const RANGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: [               // One or more ranges to compress
    {
      startId: string,     // Boundary ID at range start: mNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNN or bN
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
\`\`\``

export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompressRangeEntry {
  startId: string
  endId: string
  summary: string
}

export interface CompressRangeToolArgs {
  topic: string
  content: CompressRangeEntry[]
}

/** Entry list + indexes + active-block summaries that boundary resolution reads. */
export interface SearchContext {
  rawMessages: SessionEntry[]
  rawMessagesById: Map<string, SessionEntry>
  rawIndexById: Map<string, number>
  summaryByBlockId: Map<number, CompressionBlock>
  /** mNNNN message-ref -> branch entry id (state.messageIds.byRef). */
  byRef: Map<string, string>
}

export interface ResolvedRangeCompression {
  index: number
  entry: CompressRangeEntry
  selection: SelectionResolution
  anchorMessageId: string
}

export interface ParsedBlockPlaceholder {
  raw: string
  blockId: number
  startIndex: number
  endIndex: number
}

export interface InjectedSummaryResult {
  expandedSummary: string
  consumedBlockIds: number[]
}

export interface CompressBlockResult {
  readonly blockId: number
  readonly runId: number
  readonly messageCount: number
}

export interface CompressToolDetails {
  readonly compressedRanges: number
  readonly blocks: readonly CompressBlockResult[]
  readonly error?: string
}

/** Dependencies the tool needs to read/persist DCP state. */
export interface CompressToolDeps {
  readonly config: ResolvedConfig
  /** Returns the live mutable SessionState. */
  readonly getState: () => SessionState
  /** Persists the current state via `saveState(pi, state)`. */
  readonly pi: ExtensionAPI
}

// ---------------------------------------------------------------------------
// Message-role classification
// ---------------------------------------------------------------------------

/** Roles that represent real conversation content (excludes injected summaries). */
const COMPRESSIBLE_ROLES = new Set<string>(["user", "assistant", "toolResult", "bashExecution"])

// ---------------------------------------------------------------------------
// Boundary parsing (adapted: message refs are branch entry ids, block refs stay bN)
// ---------------------------------------------------------------------------

type ParsedBoundaryId =
  | { kind: "message"; ref: string; messageId: string }
  | { kind: "compressed-block"; ref: string; blockId: number }

const BLOCK_REF_REGEX = /^b([1-9]\d*)$/

function parseBoundaryId(id: string): ParsedBoundaryId | null {
  const normalized = id.trim()

  const blockMatch = normalized.toLowerCase().match(BLOCK_REF_REGEX)
  if (blockMatch !== null) {
    const digits = blockMatch[1]
    if (digits !== undefined) {
      const blockId = Number.parseInt(digits, 10)
      if (Number.isInteger(blockId) && blockId >= 1) {
        return { kind: "compressed-block", ref: `b${blockId}`, blockId }
      }
    }
  }

  if (normalized.length === 0 || /\s/.test(normalized)) return null

  const messageMatch = normalized.toLowerCase().match(/^m(\d{4})$/)
  if (messageMatch !== null) {
    const ref = normalized.toLowerCase()
    return { kind: "message", ref, messageId: ref }
  }

  return { kind: "message", ref: normalized, messageId: normalized }
}

function buildBoundaryLookup(context: SearchContext): Map<string, BoundaryReference> {
  const lookup = new Map<string, BoundaryReference>()

  for (const entry of context.rawMessages) {
    const rawIndex = context.rawIndexById.get(entry.id)
    if (rawIndex === undefined) continue
    lookup.set(entry.id, { kind: "message", rawIndex, messageId: entry.id })
  }

  for (const block of context.summaryByBlockId.values()) {
    const rawIndex = context.rawIndexById.get(block.anchorMessageId)
    if (rawIndex === undefined) continue
    const ref = `b${block.blockId}`
    if (!lookup.has(ref)) {
      lookup.set(ref, {
        kind: "compressed-block",
        rawIndex,
        blockId: block.blockId,
        anchorMessageId: block.anchorMessageId
      })
    }
  }

  // mNNNN refs resolve through the stable message-ref map (entry-id keys).
  for (const [ref, entryId] of context.byRef) {
    const rawIndex = context.rawIndexById.get(entryId)
    if (rawIndex === undefined) continue
    if (!lookup.has(ref)) {
      lookup.set(ref, { kind: "message", rawIndex, messageId: entryId })
    }
  }

  return lookup
}

function resolveBoundaryIds(
  context: SearchContext,
  startId: string,
  endId: string
): { startReference: BoundaryReference; endReference: BoundaryReference } {
  const lookup = buildBoundaryLookup(context)
  const issues: string[] = []
  const parsedStartId = parseBoundaryId(startId)
  const parsedEndId = parseBoundaryId(endId)

  if (parsedStartId === null) {
    issues.push("startId is invalid. Use mNNNN or bN.")
  }
  if (parsedEndId === null) {
    issues.push("endId is invalid. Use mNNNN or bN.")
  }
  if (issues.length > 0) {
    throw new Error(issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"))
  }
  if (parsedStartId === null || parsedEndId === null) {
    throw new Error("Invalid boundary ID(s)")
  }

  const startReference = lookup.get(parsedStartId.ref)
  const endReference = lookup.get(parsedEndId.ref)

  if (startReference === undefined) {
    issues.push(`startId ${parsedStartId.ref} is not available in the current conversation context.`)
  }
  if (endReference === undefined) {
    issues.push(`endId ${parsedEndId.ref} is not available in the current conversation context.`)
  }
  if (issues.length > 0) {
    throw new Error(issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"))
  }
  if (startReference === undefined || endReference === undefined) {
    throw new Error("Failed to resolve boundary IDs")
  }

  if (startReference.rawIndex > endReference.rawIndex) {
    throw new Error(
      `startId ${parsedStartId.ref} appears after endId ${parsedEndId.ref} in the conversation. Start must come before end.`
    )
  }

  return { startReference, endReference }
}

function resolveSelection(
  context: SearchContext,
  startReference: BoundaryReference,
  endReference: BoundaryReference
): SelectionResolution {
  const startRawIndex = startReference.rawIndex
  const endRawIndex = endReference.rawIndex
  const messageIds: string[] = []
  const messageSeen = new Set<string>()
  const toolIds: string[] = []
  const toolSeen = new Set<string>()
  const requiredBlockIds: number[] = []
  const requiredBlockSeen = new Set<number>()
  const messageTokenById = new Map<string, number>()

  for (let index = startRawIndex; index <= endRawIndex; index++) {
    const entry = context.rawMessages[index]
    if (entry === undefined) continue

    const entryMessages = sessionEntryToContextMessages(entry)
    const message = entryMessages[0]
    if (message === undefined) continue
    if (!COMPRESSIBLE_ROLES.has(message.role)) continue

    const messageId = entry.id
    if (!messageSeen.has(messageId)) {
      messageSeen.add(messageId)
      messageIds.push(messageId)
    }
    // No tokenizer: per-message token counts are 0 (nudge thresholds use getContextUsage).
    messageTokenById.set(messageId, 0)

    if (message.role === "toolResult") {
      if (!toolSeen.has(message.toolCallId)) {
        toolSeen.add(message.toolCallId)
        toolIds.push(message.toolCallId)
      }
    } else if (message.role === "assistant") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "toolCall" && typeof block.id === "string" && !toolSeen.has(block.id)) {
            toolSeen.add(block.id)
            toolIds.push(block.id)
          }
        }
      }
    }
  }

  const selectedMessageIds = new Set(messageIds)
  const summariesInSelection: Array<{ blockId: number; rawIndex: number }> = []
  for (const block of context.summaryByBlockId.values()) {
    if (!selectedMessageIds.has(block.anchorMessageId)) continue
    const anchorIndex = context.rawIndexById.get(block.anchorMessageId)
    if (anchorIndex === undefined) continue
    summariesInSelection.push({ blockId: block.blockId, rawIndex: anchorIndex })
  }
  summariesInSelection.sort((a, b) => a.rawIndex - b.rawIndex || a.blockId - b.blockId)
  for (const summary of summariesInSelection) {
    if (requiredBlockSeen.has(summary.blockId)) continue
    requiredBlockSeen.add(summary.blockId)
    requiredBlockIds.push(summary.blockId)
  }

  if (messageIds.length === 0) {
    throw new Error(
      "Failed to map boundary matches back to raw messages. Choose boundaries that include original conversation messages."
    )
  }

  return { startReference, endReference, messageIds, messageTokenById, toolIds, requiredBlockIds }
}

function resolveAnchorMessageId(startReference: BoundaryReference): string {
  if (startReference.kind === "compressed-block") {
    if (startReference.anchorMessageId === undefined) {
      throw new Error("Failed to map boundary matches back to raw messages")
    }
    return startReference.anchorMessageId
  }
  if (startReference.messageId === undefined) {
    throw new Error("Failed to map boundary matches back to raw messages")
  }
  return startReference.messageId
}

/** Build the search context from Pi's compaction-aware context entries. */
function buildSearchContext(ctx: ExtensionContext, state: SessionState): SearchContext {
  const rawMessages: SessionEntry[] = []
  const rawMessagesById = new Map<string, SessionEntry>()
  const rawIndexById = new Map<string, number>()

  for (const entry of ctx.sessionManager.buildContextEntries()) {
    if (sessionEntryToContextMessages(entry).length === 0) continue
    const index = rawMessages.length
    rawMessages.push(entry)
    rawMessagesById.set(entry.id, entry)
    rawIndexById.set(entry.id, index)
  }

  const summaryByBlockId = new Map<number, CompressionBlock>()
  for (const [blockId, block] of state.prune.messages.blocksById) {
    if (block.active) summaryByBlockId.set(blockId, block)
  }

  return { rawMessages, rawMessagesById, rawIndexById, summaryByBlockId, byRef: state.messageIds.byRef }
}

/** Find the assistant message entry that issued this compress tool call (for duration attachment). */
function resolveCompressMessageId(ctx: ExtensionContext, toolCallId: string): string {
  for (const entry of ctx.sessionManager.buildContextEntries()) {
    for (const message of sessionEntryToContextMessages(entry)) {
      if (message.role !== "assistant") continue
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type === "toolCall" && block.id === toolCallId) {
          return entry.id
        }
      }
    }
  }
  return ""
}

// ---------------------------------------------------------------------------
// Range utilities
// ---------------------------------------------------------------------------

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

export function validateArgs(args: CompressRangeToolArgs): void {
  if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
    throw new Error("topic is required and must be a non-empty string")
  }
  if (!Array.isArray(args.content) || args.content.length === 0) {
    throw new Error("content is required and must be a non-empty array")
  }

  for (let index = 0; index < args.content.length; index++) {
    const entry = args.content[index]
    const prefix = `content[${index}]`

    if (entry === undefined || typeof entry.startId !== "string" || entry.startId.trim().length === 0) {
      throw new Error(`${prefix}.startId is required and must be a non-empty string`)
    }
    if (entry === undefined || typeof entry.endId !== "string" || entry.endId.trim().length === 0) {
      throw new Error(`${prefix}.endId is required and must be a non-empty string`)
    }
    if (entry === undefined || typeof entry.summary !== "string" || entry.summary.trim().length === 0) {
      throw new Error(`${prefix}.summary is required and must be a non-empty string`)
    }
  }
}

export function resolveRanges(args: CompressRangeToolArgs, searchContext: SearchContext): ResolvedRangeCompression[] {
  return args.content.map((entry, index) => {
    const normalizedEntry: CompressRangeEntry = {
      startId: entry.startId.trim(),
      endId: entry.endId.trim(),
      summary: entry.summary
    }

    const { startReference, endReference } = resolveBoundaryIds(
      searchContext,
      normalizedEntry.startId,
      normalizedEntry.endId
    )
    const selection = resolveSelection(searchContext, startReference, endReference)

    return {
      index,
      entry: normalizedEntry,
      selection,
      anchorMessageId: resolveAnchorMessageId(startReference)
    }
  })
}

export function validateNonOverlapping(plans: ResolvedRangeCompression[]): void {
  const sortedPlans = [...plans].sort(
    (left, right) =>
      left.selection.startReference.rawIndex - right.selection.startReference.rawIndex ||
      left.selection.endReference.rawIndex - right.selection.endReference.rawIndex ||
      left.index - right.index
  )

  const issues: string[] = []

  for (let index = 1; index < sortedPlans.length; index++) {
    const previous = sortedPlans[index - 1]
    const current = sortedPlans[index]
    if (previous === undefined || current === undefined) continue

    if (current.selection.startReference.rawIndex > previous.selection.endReference.rawIndex) continue

    issues.push(
      `content[${previous.index}] (${previous.entry.startId}..${previous.entry.endId}) overlaps content[${current.index}] (${current.entry.startId}..${current.entry.endId}). Overlapping ranges cannot be compressed in the same batch.`
    )
  }

  if (issues.length > 0) {
    throw new Error(issues.length === 1 ? issues[0] : issues.map((issue) => `- ${issue}`).join("\n"))
  }
}

export function parseBlockPlaceholders(summary: string): ParsedBlockPlaceholder[] {
  const placeholders: ParsedBlockPlaceholder[] = []
  const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX)

  let match: RegExpExecArray | null = regex.exec(summary)
  while (match !== null) {
    const full = match[0]
    const blockIdPart = match[1] ?? match[2]
    if (full !== undefined && blockIdPart !== undefined) {
      const parsed = Number.parseInt(blockIdPart, 10)
      if (Number.isInteger(parsed)) {
        placeholders.push({
          raw: full,
          blockId: parsed,
          startIndex: match.index,
          endIndex: match.index + full.length
        })
      }
    }
    match = regex.exec(summary)
  }

  return placeholders
}

export function validateSummaryPlaceholders(
  placeholders: ParsedBlockPlaceholder[],
  requiredBlockIds: number[],
  startReference: BoundaryReference,
  endReference: BoundaryReference,
  summaryByBlockId: Map<number, CompressionBlock>
): number[] {
  const boundaryOptionalIds = new Set<number>()
  if (startReference.kind === "compressed-block") {
    if (startReference.blockId === undefined) {
      throw new Error("Failed to map boundary matches back to raw messages")
    }
    boundaryOptionalIds.add(startReference.blockId)
  }
  if (endReference.kind === "compressed-block") {
    if (endReference.blockId === undefined) {
      throw new Error("Failed to map boundary matches back to raw messages")
    }
    boundaryOptionalIds.add(endReference.blockId)
  }

  const strictRequiredIds = requiredBlockIds.filter((id) => !boundaryOptionalIds.has(id))
  const requiredSet = new Set(requiredBlockIds)
  const keptPlaceholderIds = new Set<number>()
  const validPlaceholders: ParsedBlockPlaceholder[] = []

  for (const placeholder of placeholders) {
    const isKnown = summaryByBlockId.has(placeholder.blockId)
    const isRequired = requiredSet.has(placeholder.blockId)
    const isDuplicate = keptPlaceholderIds.has(placeholder.blockId)

    if (isKnown && isRequired && !isDuplicate) {
      validPlaceholders.push(placeholder)
      keptPlaceholderIds.add(placeholder.blockId)
    }
  }

  placeholders.length = 0
  placeholders.push(...validPlaceholders)

  return strictRequiredIds.filter((id) => !keptPlaceholderIds.has(id))
}

export function injectBlockPlaceholders(
  summary: string,
  placeholders: ParsedBlockPlaceholder[],
  summaryByBlockId: Map<number, CompressionBlock>,
  startReference: BoundaryReference,
  endReference: BoundaryReference
): InjectedSummaryResult {
  let cursor = 0
  let expanded = summary
  const consumed: number[] = []
  const consumedSeen = new Set<number>()

  if (placeholders.length > 0) {
    expanded = ""
    for (const placeholder of placeholders) {
      const target = summaryByBlockId.get(placeholder.blockId)
      if (target === undefined) {
        throw new Error(`Compressed block not found: (b${placeholder.blockId})`)
      }

      expanded += summary.slice(cursor, placeholder.startIndex)
      expanded += restoreSummary(target.summary)
      cursor = placeholder.endIndex

      if (!consumedSeen.has(placeholder.blockId)) {
        consumedSeen.add(placeholder.blockId)
        consumed.push(placeholder.blockId)
      }
    }
    expanded += summary.slice(cursor)
  }

  expanded = injectBoundarySummary(expanded, startReference, "start", summaryByBlockId, consumed, consumedSeen)
  expanded = injectBoundarySummary(expanded, endReference, "end", summaryByBlockId, consumed, consumedSeen)

  return { expandedSummary: expanded, consumedBlockIds: consumed }
}

export function appendMissingBlockSummaries(
  summary: string,
  missingBlockIds: number[],
  summaryByBlockId: Map<number, CompressionBlock>,
  consumedBlockIds: number[]
): InjectedSummaryResult {
  const consumedSeen = new Set<number>(consumedBlockIds)
  const consumed = [...consumedBlockIds]

  const missingSummaries: string[] = []
  for (const blockId of missingBlockIds) {
    if (consumedSeen.has(blockId)) continue

    const target = summaryByBlockId.get(blockId)
    if (target === undefined) {
      throw new Error(`Compressed block not found: (b${blockId})`)
    }

    missingSummaries.push(`\n### (b${blockId})\n${restoreSummary(target.summary)}`)
    consumedSeen.add(blockId)
    consumed.push(blockId)
  }

  if (missingSummaries.length === 0) {
    return { expandedSummary: summary, consumedBlockIds: consumed }
  }

  const heading = "\n\nThe following previously compressed summaries were also part of this conversation section:"
  return { expandedSummary: summary + heading + missingSummaries.join(""), consumedBlockIds: consumed }
}

function restoreSummary(summary: string): string {
  const headerMatch = summary.match(/^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i)
  const header = headerMatch?.[0]
  if (header === undefined) return summary

  const afterHeader = summary.slice(header.length)
  const withoutLeadingBreaks = afterHeader.replace(/^(?:\r?\n)+/, "")
  return withoutLeadingBreaks
    .replace(/(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "")
    .replace(/(?:\r?\n)+$/, "")
}

function injectBoundarySummary(
  summary: string,
  reference: BoundaryReference,
  position: "start" | "end",
  summaryByBlockId: Map<number, CompressionBlock>,
  consumed: number[],
  consumedSeen: Set<number>
): string {
  if (reference.kind !== "compressed-block" || reference.blockId === undefined) {
    return summary
  }
  if (consumedSeen.has(reference.blockId)) {
    return summary
  }

  const target = summaryByBlockId.get(reference.blockId)
  if (target === undefined) {
    throw new Error(`Compressed block not found: (b${reference.blockId})`)
  }

  const injectedBody = restoreSummary(target.summary)
  const left = position === "start" ? injectedBody.trim() : summary.trim()
  const right = position === "start" ? summary.trim() : injectedBody.trim()
  const next = !left ? right : !right ? left : `${left}\n\n${right}`

  consumedSeen.add(reference.blockId)
  consumed.push(reference.blockId)
  return next
}

// ---------------------------------------------------------------------------
// Summary wrapping
// ---------------------------------------------------------------------------

export function wrapCompressedSummary(blockId: number, summary: string): string {
  const header = COMPRESSED_BLOCK_HEADER
  const footer = `\n<dcp-message-id>b${blockId}</dcp-message-id>`
  const body = summary.trim()
  if (body.length === 0) {
    return `${header}\n${footer}`
  }
  return `${header}\n${body}\n\n${footer}`
}

// ---------------------------------------------------------------------------
// Protected tool output appending (simplified port; subagent/task branch dropped)
// ---------------------------------------------------------------------------

function appendProtectedTools(
  state: SessionState,
  summary: string,
  selection: SelectionResolution,
  searchContext: SearchContext,
  protectedTools: readonly string[],
  protectedFilePatterns: readonly string[] = []
): string {
  const protectedOutputs: string[] = []

  for (const messageId of selection.messageIds) {
    const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
    if (existingCompressionEntry !== undefined && existingCompressionEntry.activeBlockIds.length > 0) {
      continue
    }

    const entry = searchContext.rawMessagesById.get(messageId)
    if (entry === undefined) continue

    for (const message of sessionEntryToContextMessages(entry)) {
      if (message.role !== "toolResult") continue

      let isToolProtected = isToolNameProtected(message.toolName, protectedTools)
      if (!isToolProtected && protectedFilePatterns.length > 0) {
        const parameters = state.toolParameters.get(message.toolCallId)?.parameters
        const filePaths = getFilePathsFromParameters(message.toolName, parameters)
        if (isFilePathProtected(filePaths, protectedFilePatterns)) {
          isToolProtected = true
        }
      }
      if (!isToolProtected) continue

      const title = `Tool: ${message.toolName}`
      let output = ""
      if (!message.isError && Array.isArray(message.content)) {
        const textParts: string[] = []
        for (const block of message.content) {
          if (block.type === "text") {
            textParts.push(block.text)
          }
        }
        output = textParts.join("")
      }

      if (output.length > 0) {
        protectedOutputs.push(`\n### ${title}\n${output}`)
      }
    }
  }

  if (protectedOutputs.length === 0) {
    return summary
  }

  const heading = "\n\nThe following protected tools were used in this conversation as well:"
  return summary + heading + protectedOutputs.join("")
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const compressParameters = Type.Object({
  topic: Type.String(),
  content: Type.Array(
    Type.Object({
      startId: Type.String(),
      endId: Type.String(),
      summary: Type.String()
    })
  )
})

/**
 * The `compress` range tool. Never throws out of `execute` — validation and
 * internal errors are returned as a text block with a matching `details.error`.
 */
export function createCompressTool(deps: CompressToolDeps) {
  return defineTool({
    name: "compress",
    label: "Compress Context",
    description: COMPRESS_RANGE + RANGE_FORMAT_EXTENSION,
    parameters: compressParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as CompressRangeToolArgs

      try {
        validateArgs(input)

        const state = deps.getState()
        const searchContext = buildSearchContext(ctx, state)
        const resolvedPlans = resolveRanges(input, searchContext)
        validateNonOverlapping(resolvedPlans)

        const compressMessageId = resolveCompressMessageId(ctx, toolCallId)

        const preparedPlans: Array<{
          entry: CompressRangeEntry
          selection: SelectionResolution
          anchorMessageId: string
          finalSummary: string
          consumedBlockIds: number[]
        }> = []

        for (const plan of resolvedPlans) {
          const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary)
          const missingBlockIds = validateSummaryPlaceholders(
            parsedPlaceholders,
            plan.selection.requiredBlockIds,
            plan.selection.startReference,
            plan.selection.endReference,
            searchContext.summaryByBlockId
          )
          const injected = injectBlockPlaceholders(
            plan.entry.summary,
            parsedPlaceholders,
            searchContext.summaryByBlockId,
            plan.selection.startReference,
            plan.selection.endReference
          )
          const summaryWithTools = appendProtectedTools(
            state,
            injected.expandedSummary,
            plan.selection,
            searchContext,
            deps.config.compress.protectedTools,
            deps.config.protectedFilePatterns
          )
          const completed = appendMissingBlockSummaries(
            summaryWithTools,
            missingBlockIds,
            searchContext.summaryByBlockId,
            injected.consumedBlockIds
          )

          preparedPlans.push({
            entry: plan.entry,
            selection: plan.selection,
            anchorMessageId: plan.anchorMessageId,
            finalSummary: completed.expandedSummary,
            consumedBlockIds: completed.consumedBlockIds
          })
        }

        const runId = allocateRunId(state)
        const blocks: CompressBlockResult[] = []
        let totalCompressedMessages = 0
        let newlyCompressedMessageCount = 0
        let newlyCompressedToolCount = 0
        let tokensRemoved = 0

        for (const prepared of preparedPlans) {
          const blockId = allocateBlockId(state)
          const storedSummary = wrapCompressedSummary(blockId, prepared.finalSummary)

          const applied = applyCompressionState(
            state,
            {
              topic: input.topic,
              batchTopic: input.topic,
              startId: prepared.entry.startId,
              endId: prepared.entry.endId,
              mode: "range",
              runId,
              compressMessageId,
              compressCallId: toolCallId,
              summaryTokens: 0
            },
            prepared.selection,
            prepared.anchorMessageId,
            blockId,
            storedSummary,
            prepared.consumedBlockIds
          )

          totalCompressedMessages += applied.messageIds.length
          newlyCompressedMessageCount += applied.newlyCompressedMessageIds.length
          newlyCompressedToolCount += applied.newlyCompressedToolIds.length
          tokensRemoved += applied.compressedTokens
          blocks.push({ blockId, runId, messageCount: applied.messageIds.length })
        }

        saveState(deps.pi, state)

        notifyCompression(deps.pi, ctx, deps.config, {
          topic: input.topic,
          runId,
          messageCount: newlyCompressedMessageCount,
          toolCount: newlyCompressedToolCount,
          tokensRemoved,
          tokensSavedTotal: state.stats.totalPruneTokens
        })

        const details: CompressToolDetails = { compressedRanges: preparedPlans.length, blocks }
        const text = `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
        return { content: [{ type: "text", text }], details }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        return {
          content: [{ type: "text", text: `Compression failed: ${message}` }],
          details: { compressedRanges: 0, blocks: [], error: message }
        }
      }
    }
  })
}
