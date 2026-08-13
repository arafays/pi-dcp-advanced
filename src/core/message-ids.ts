import {
  type ContextEvent,
  type ExtensionContext,
  type SessionEntry,
  sessionEntryToContextMessages
} from "@earendil-works/pi-coding-agent"
import type { ResolvedConfig } from "./config.js"
import type { SessionState } from "./state.js"

// ---------------------------------------------------------------------------
// Message type (mirrors src/prune.ts and src/nudges.ts — AgentMessage is not
// re-exported from the pi-coding-agent root, so derive it from the ContextEvent
// contract).
// ---------------------------------------------------------------------------

export type AgentMessage = ContextEvent["messages"][number]

type TextContentBlock = { type: "text"; text: string }

/**
 * Roles that carry real conversation content and get an `mNNNN` ref. Unlike
 * OpenCode (where tool results are `tool` parts of the assistant message), Pi
 * models tool results and bash executions as separate entries, so they must be
 * tagged too — otherwise the model cannot reference a tool result as a
 * compression boundary and produces orphaned `tool` messages.
 */
const COMPRESSIBLE_ROLES = new Set<string>(["user", "assistant", "toolResult", "bashExecution"])

// ---------------------------------------------------------------------------
// Ref formatting / parsing (ported verbatim from lib/message-ids.ts)
//
// Message refs are the `mNNNN` aliases the model uses to reference raw
// conversation messages; block refs stay `bN`. Refs are stable across turns:
// assignMessageRefs keys them by branch ENTRY id (the Pi stable identity).
// ---------------------------------------------------------------------------

export const MESSAGE_REF_WIDTH = 4
export const MESSAGE_REF_MIN_INDEX = 1
export const MESSAGE_REF_MAX_INDEX = 9999

const MESSAGE_REF_REGEX = /^m(\d{4})$/
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/
const MESSAGE_ID_TAG_NAME = "dcp-message-id"

export function formatMessageRef(index: number): string {
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
    throw new Error(`Message ID index out of bounds: ${index}. Supported range is 0-${MESSAGE_REF_MAX_INDEX}.`)
  }
  return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`
}

export function formatBlockRef(blockId: number): string {
  if (!Number.isInteger(blockId) || blockId < 1) {
    throw new Error(`Invalid block ID: ${blockId}`)
  }
  return `b${blockId}`
}

export function parseMessageRef(ref: string): number | null {
  const normalized = ref.trim().toLowerCase()
  const match = normalized.match(MESSAGE_REF_REGEX)
  if (!match) return null

  const index = Number.parseInt(match[1] ?? "", 10)
  if (!Number.isInteger(index)) return null
  if (index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) return null
  return index
}

export function parseBlockRef(ref: string): number | null {
  const normalized = ref.trim().toLowerCase()
  const match = normalized.match(BLOCK_REF_REGEX)
  if (!match) return null

  const id = Number.parseInt(match[1] ?? "", 10)
  return Number.isInteger(id) ? id : null
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Narrowing predicate: attribute names must be non-blank and values non-empty strings. */
function isNonEmptyAttribute(entry: [string, string | undefined]): entry is [string, string] {
  return entry[0].trim().length > 0 && entry[1] !== undefined && entry[1].length > 0
}

/**
 * Build a leading-newline `<dcp-message-id>ref</dcp-message-id>` tag.
 * Attributes are sorted by key, XML-escaped, and empty/undefined values skipped.
 */
export function formatMessageIdTag(ref: string, attributes?: Record<string, string | undefined>): string {
  const serializedAttributes = Object.entries(attributes ?? {})
    .filter(isNonEmptyAttribute)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
    .join("")

  return `\n<${MESSAGE_ID_TAG_NAME}${serializedAttributes}>${ref}</${MESSAGE_ID_TAG_NAME}>`
}

function allocateNextMessageRef(state: SessionState): string {
  let candidate = Number.isInteger(state.messageIds.nextRef)
    ? Math.max(MESSAGE_REF_MIN_INDEX, state.messageIds.nextRef)
    : MESSAGE_REF_MIN_INDEX

  while (candidate <= MESSAGE_REF_MAX_INDEX) {
    const ref = formatMessageRef(candidate)
    if (!state.messageIds.byRef.has(ref)) {
      state.messageIds.nextRef = candidate + 1
      return ref
    }
    candidate++
  }

  throw new Error(
    `Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} aliases in this session.`
  )
}

/**
 * Allocate an `mNNNN` ref for every entry whose first projected context message
 * is a user or assistant message and whose entry id is not already mapped.
 * Idempotent across turns — existing mappings are skipped and refs advance via
 * `state.messageIds.nextRef`. Returns the number of refs newly assigned.
 */
export function assignMessageRefs(state: SessionState, entries: SessionEntry[]): number {
  let assigned = 0

  for (const entry of entries) {
    const firstMessage = sessionEntryToContextMessages(entry)[0]
    if (firstMessage === undefined) continue
    if (!COMPRESSIBLE_ROLES.has(firstMessage.role)) continue

    const rawMessageId = entry.id
    if (typeof rawMessageId !== "string" || rawMessageId.length === 0) continue

    if (state.messageIds.byRawId.has(rawMessageId)) continue

    const ref = allocateNextMessageRef(state)
    state.messageIds.byRawId.set(rawMessageId, ref)
    state.messageIds.byRef.set(ref, rawMessageId)
    assigned++
  }

  return assigned
}

/**
 * Append an injection to a text block: strip leading newlines from the tag,
 * dedup (skip when the block already contains the tag), and append with a
 * two-newline separator. Returns whether the block now carries the injection.
 */
function appendToTextBlock(block: TextContentBlock, injection: string): boolean {
  if (typeof block.text !== "string") return false

  const normalizedInjection = injection.replace(/^\n+/, "")
  if (!normalizedInjection.trim()) return false
  if (block.text.includes(normalizedInjection)) return true

  const baseText = block.text.replace(/\n*$/, "")
  block.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
  return true
}

/**
 * Append the `<dcp-message-id>mNNNN</dcp-message-id>` tag to every user /
 * assistant message in the context `messages` copy, aligned 1:1 with `entries`.
 * Pure injection into the deep copy — the session tree is untouched. Never
 * throws: unexpected message shapes skip that message (defensive best-effort).
 */
export function injectMessageIds(
  state: SessionState,
  config: ResolvedConfig,
  messages: AgentMessage[],
  entries: SessionEntry[]
): void {
  if ((state.compressPermission ?? config.compress.permission) === "deny") return
  // Defensive length guard (mirrors src/prune.ts applyCompressedRanges): if the
  // entry<->message alignment drifted (Pi internals changed), bail rather than
  // mis-assign refs and tag the wrong message.
  if (entries.length !== messages.length) return

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message === undefined) continue
    if (!COMPRESSIBLE_ROLES.has(message.role)) continue

    try {
      const entry = entries[i]
      if (entry === undefined) continue
      const ref = state.messageIds.byRawId.get(entry.id)
      if (ref === undefined) continue

      const tag = formatMessageIdTag(ref)

      if (message.role === "user") {
        if (typeof message.content === "string") {
          message.content = [{ type: "text", text: message.content }]
        }
        if (!Array.isArray(message.content)) continue

        let injected = false
        for (let j = message.content.length - 1; j >= 0; j--) {
          const block = message.content[j]
          if (block === undefined) continue
          if (block.type === "text" && appendToTextBlock(block, tag)) {
            injected = true
            break
          }
        }
        if (!injected) {
          message.content.push({ type: "text", text: tag })
        }
        continue
      }

      if (message.role === "assistant") {
        // Assistant messages always carry array content; skip unexpected shapes.
        if (!Array.isArray(message.content)) continue

        let injected = false
        for (let j = message.content.length - 1; j >= 0; j--) {
          const block = message.content[j]
          if (block === undefined) continue
          if (block.type === "text" && appendToTextBlock(block, tag)) {
            injected = true
            break
          }
        }
        if (injected) continue

        const synthetic: TextContentBlock = { type: "text", text: tag }
        const firstToolIndex = message.content.findIndex((block) => block.type === "toolCall")
        if (firstToolIndex === -1) {
          message.content.push(synthetic)
        } else {
          message.content.splice(firstToolIndex, 0, synthetic)
        }
        continue
      }

      if (message.role === "toolResult") {
        // Tool results carry array content of text/image blocks.
        if (!Array.isArray(message.content)) continue

        let injected = false
        for (let j = message.content.length - 1; j >= 0; j--) {
          const block = message.content[j]
          if (block === undefined) continue
          if (block.type === "text" && appendToTextBlock(block, tag)) {
            injected = true
            break
          }
        }
        if (!injected) {
          message.content.push({ type: "text", text: tag })
        }
        continue
      }

      if (message.role === "bashExecution") {
        // Bash executions expose their output as a plain string field.
        if (typeof message.output === "string") {
          const normalizedTag = tag.replace(/^\n+/, "")
          if (!message.output.includes(normalizedTag)) {
            const base = message.output.replace(/\n*$/, "")
            message.output = base.length > 0 ? `${base}\n\n${normalizedTag}` : normalizedTag
          }
        }
      }
    } catch {
      // Defensive best-effort: an unexpected shape must never break the
      // context handler.
    }
  }
}

/**
 * The exact context-entry projection used by src/prune.ts applyCompressedRanges
 * and src/nudges.ts: the compaction-aware branch entry list, filtered to the
 * entries that produce a context message (each yields exactly one AgentMessage).
 */
export function getMessageEntries(ctx: ExtensionContext): SessionEntry[] {
  return ctx.sessionManager.buildContextEntries().filter((entry) => sessionEntryToContextMessages(entry).length > 0)
}
