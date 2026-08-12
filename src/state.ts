import type { CustomEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"

// ---------------------------------------------------------------------------
// Types
//
// Ported from ../opencode-dynamic-context-pruning/lib/state/types.ts and
// ../lib/compress/state.ts, re-keyed to Pi stable identities:
//   - tool outputs / prune map keyed by `toolCallId` (string)
//   - compression blocks anchored on branch `entry` ids (string)
// ---------------------------------------------------------------------------

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
  tool: string
  parameters: unknown
  status?: ToolStatus
  error?: string
  turn: number
  tokenCount?: number
}

export interface SessionStats {
  pruneTokenCounter: number
  totalPruneTokens: number
}

export interface PrunedMessageEntry {
  tokenCount: number
  allBlockIds: number[]
  activeBlockIds: number[]
}

/** Only "range" is in scope for the Pi port (message-mode compress is out of scope). */
export type CompressionMode = "range"

export interface CompressionBlock {
  blockId: number
  runId: number
  active: boolean
  deactivatedByUser: boolean
  compressedTokens: number
  summaryTokens: number
  durationMs: number
  mode?: CompressionMode
  topic: string
  batchTopic?: string
  startId: string
  endId: string
  anchorMessageId: string
  compressMessageId: string
  compressCallId?: string
  includedBlockIds: number[]
  consumedBlockIds: number[]
  parentBlockIds: number[]
  directMessageIds: string[]
  directToolIds: string[]
  effectiveMessageIds: string[]
  effectiveToolIds: string[]
  createdAt: number
  deactivatedAt?: number
  deactivatedByBlockId?: number
  summary: string
}

export interface PruneMessagesState {
  byMessageId: Map<string, PrunedMessageEntry>
  blocksById: Map<number, CompressionBlock>
  activeBlockIds: Set<number>
  activeByAnchorMessageId: Map<string, number>
  nextBlockId: number
  nextRunId: number
}

export interface Prune {
  tools: Map<string, number>
  messages: PruneMessagesState
}

export interface PendingManualTrigger {
  sessionId: string
  prompt: string
  /** manualMode before /dcp-compress switched to "compress-pending"; restored after delivery. */
  priorMode: false | "active" | "compress-pending"
}

export interface MessageIdState {
  byRawId: Map<string, string>
  byRef: Map<string, string>
  nextRef: number
}

export interface Nudges {
  contextLimitAnchors: Set<string>
  turnNudgeAnchors: Set<string>
  iterationNudgeAnchors: Set<string>
}

export interface PendingCompressionDuration {
  messageId: string
  callId: string
  durationMs: number
}

export interface CompressionTimingState {
  startsByCallId: Map<string, number>
  pendingByCallId: Map<string, PendingCompressionDuration>
}

export interface SessionState {
  sessionId: string | null
  isSubAgent: boolean
  manualMode: false | "active" | "compress-pending"
  compressPermission: "ask" | "allow" | "deny" | undefined
  pendingManualTrigger: PendingManualTrigger | null
  prune: Prune
  nudges: Nudges
  stats: SessionStats
  compressionTiming: CompressionTimingState
  toolParameters: Map<string, ToolParameterEntry>
  subAgentResultCache: Map<string, string>
  toolIdList: string[]
  messageIds: MessageIdState
  lastCompaction: number
  currentTurn: number
  modelContextLimit: number | undefined
  systemPromptTokens: number | undefined
}

// ---------------------------------------------------------------------------
// Compression state input types (ported from ../lib/compress/types.ts)
// ---------------------------------------------------------------------------

export interface BoundaryReference {
  kind: "message" | "compressed-block"
  rawIndex: number
  messageId?: string
  blockId?: number
  anchorMessageId?: string
}

export interface SelectionResolution {
  startReference: BoundaryReference
  endReference: BoundaryReference
  messageIds: string[]
  messageTokenById: Map<string, number>
  toolIds: string[]
  requiredBlockIds: number[]
}

export interface AppliedCompressionResult {
  compressedTokens: number
  messageIds: string[]
  newlyCompressedMessageIds: string[]
  newlyCompressedToolIds: string[]
}

export interface CompressionStateInput {
  topic: string
  batchTopic: string
  startId: string
  endId: string
  mode: CompressionMode
  runId: number
  compressMessageId: string
  compressCallId?: string
  summaryTokens: number
}

// ---------------------------------------------------------------------------
// Serialization codec (Effect Schema)
//
// The persisted slice is the subset that must survive a session reload:
// prune (tools + messages), nudges, stats, and manualMode. Maps/Sets are
// serialized as records/arrays; JSON round-trips through pi.appendEntry.
// ---------------------------------------------------------------------------

const PrunedMessageEntrySchema = Schema.Struct({
  tokenCount: Schema.Number,
  allBlockIds: Schema.Array(Schema.Number),
  activeBlockIds: Schema.Array(Schema.Number)
})

const CompressionBlockSchema = Schema.Struct({
  blockId: Schema.Number,
  runId: Schema.Number,
  active: Schema.Boolean,
  deactivatedByUser: Schema.Boolean,
  compressedTokens: Schema.Number,
  summaryTokens: Schema.Number,
  durationMs: Schema.Number,
  mode: Schema.optionalKey(Schema.Literal("range")),
  topic: Schema.String,
  batchTopic: Schema.optionalKey(Schema.String),
  startId: Schema.String,
  endId: Schema.String,
  anchorMessageId: Schema.String,
  compressMessageId: Schema.String,
  compressCallId: Schema.optionalKey(Schema.String),
  includedBlockIds: Schema.Array(Schema.Number),
  consumedBlockIds: Schema.Array(Schema.Number),
  parentBlockIds: Schema.Array(Schema.Number),
  directMessageIds: Schema.Array(Schema.String),
  directToolIds: Schema.Array(Schema.String),
  effectiveMessageIds: Schema.Array(Schema.String),
  effectiveToolIds: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  deactivatedAt: Schema.optionalKey(Schema.Number),
  deactivatedByBlockId: Schema.optionalKey(Schema.Number),
  summary: Schema.String
})

const SessionStatsSchema = Schema.Struct({
  pruneTokenCounter: Schema.Number,
  totalPruneTokens: Schema.Number
})

const PersistedNudgesSchema = Schema.Struct({
  contextLimitAnchors: Schema.Array(Schema.String),
  turnNudgeAnchors: Schema.Array(Schema.String),
  iterationNudgeAnchors: Schema.Array(Schema.String)
})

const PersistedPruneMessagesStateSchema = Schema.Struct({
  byMessageId: Schema.Record(Schema.String, PrunedMessageEntrySchema),
  blocksById: Schema.Record(Schema.String, CompressionBlockSchema),
  activeBlockIds: Schema.Array(Schema.Number),
  activeByAnchorMessageId: Schema.Record(Schema.String, Schema.Number),
  nextBlockId: Schema.Number,
  nextRunId: Schema.Number
})

const PersistedPruneSchema = Schema.Struct({
  tools: Schema.Record(Schema.String, Schema.Number),
  messages: PersistedPruneMessagesStateSchema
})

/** The JSON shape persisted under the "dcp-state" custom entry. */
export const PersistedStateSchema = Schema.Struct({
  sessionId: Schema.NullOr(Schema.String),
  manualMode: Schema.Literals([false, "active", "compress-pending"]),
  prune: PersistedPruneSchema,
  nudges: PersistedNudgesSchema,
  stats: SessionStatsSchema,
  lastUpdated: Schema.String
})

export type PersistedState = Schema.Schema.Type<typeof PersistedStateSchema>

// ---------------------------------------------------------------------------
// Pure state construction / allocation (ported from ../lib/compress/state.ts)
// ---------------------------------------------------------------------------

export function createPruneMessagesState(): PruneMessagesState {
  return {
    byMessageId: new Map(),
    blocksById: new Map(),
    activeBlockIds: new Set(),
    activeByAnchorMessageId: new Map(),
    nextBlockId: 1,
    nextRunId: 1
  }
}

export function createEmptySessionState(sessionId: string | null = null): SessionState {
  return {
    sessionId,
    isSubAgent: false,
    manualMode: false,
    compressPermission: undefined,
    pendingManualTrigger: null,
    prune: { tools: new Map(), messages: createPruneMessagesState() },
    nudges: {
      contextLimitAnchors: new Set(),
      turnNudgeAnchors: new Set(),
      iterationNudgeAnchors: new Set()
    },
    stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
    compressionTiming: { startsByCallId: new Map(), pendingByCallId: new Map() },
    toolParameters: new Map(),
    subAgentResultCache: new Map(),
    toolIdList: [],
    messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
    lastCompaction: 0,
    currentTurn: 0,
    modelContextLimit: undefined,
    systemPromptTokens: undefined
  }
}

export function allocateBlockId(state: SessionState): number {
  const next = state.prune.messages.nextBlockId
  if (!Number.isInteger(next) || next < 1) {
    state.prune.messages.nextBlockId = 2
    return 1
  }
  state.prune.messages.nextBlockId = next + 1
  return next
}

export function allocateRunId(state: SessionState): number {
  const next = state.prune.messages.nextRunId
  if (!Number.isInteger(next) || next < 1) {
    state.prune.messages.nextRunId = 2
    return 1
  }
  state.prune.messages.nextRunId = next + 1
  return next
}

export function attachCompressionDuration(
  messagesState: PruneMessagesState,
  messageId: string,
  callId: string,
  durationMs: number
): number {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return 0
  }
  let updates = 0
  for (const block of messagesState.blocksById.values()) {
    if (block.compressMessageId !== messageId || block.compressCallId !== callId) {
      continue
    }
    block.durationMs = durationMs
    updates++
  }
  return updates
}

/**
 * Apply a compression block to the prune state, deactivating any consumed
 * blocks (the "older summary nested inside newer" merge) and updating the
 * active/anchor maps. Ported verbatim from the source's applyCompressionState.
 */
export function applyCompressionState(
  state: SessionState,
  input: CompressionStateInput,
  selection: SelectionResolution,
  anchorMessageId: string,
  blockId: number,
  summary: string,
  consumedBlockIds: number[]
): AppliedCompressionResult {
  const messagesState = state.prune.messages
  const consumed = [...new Set(consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
  const included = [...consumed]

  const effectiveMessageIds = new Set<string>(selection.messageIds)
  const effectiveToolIds = new Set<string>(selection.toolIds)

  for (const consumedBlockId of consumed) {
    const consumedBlock = messagesState.blocksById.get(consumedBlockId)
    if (!consumedBlock) {
      continue
    }
    for (const messageId of consumedBlock.effectiveMessageIds) {
      effectiveMessageIds.add(messageId)
    }
    for (const toolId of consumedBlock.effectiveToolIds) {
      effectiveToolIds.add(toolId)
    }
  }

  const initiallyActiveMessages = new Set<string>()
  for (const messageId of effectiveMessageIds) {
    const entry = messagesState.byMessageId.get(messageId)
    if (entry && entry.activeBlockIds.length > 0) {
      initiallyActiveMessages.add(messageId)
    }
  }

  const initiallyActiveToolIds = new Set<string>()
  for (const activeBlockId of messagesState.activeBlockIds) {
    const activeBlock = messagesState.blocksById.get(activeBlockId)
    if (!activeBlock?.active) {
      continue
    }
    for (const toolId of activeBlock.effectiveToolIds) {
      initiallyActiveToolIds.add(toolId)
    }
  }

  const createdAt = Date.now()
  const block: CompressionBlock = {
    blockId,
    runId: input.runId,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 0,
    summaryTokens: input.summaryTokens,
    durationMs: 0,
    mode: input.mode,
    topic: input.topic,
    batchTopic: input.batchTopic,
    startId: input.startId,
    endId: input.endId,
    anchorMessageId,
    compressMessageId: input.compressMessageId,
    includedBlockIds: included,
    consumedBlockIds: consumed,
    parentBlockIds: [],
    directMessageIds: [],
    directToolIds: [],
    effectiveMessageIds: [...effectiveMessageIds],
    effectiveToolIds: [...effectiveToolIds],
    createdAt,
    summary,
    ...(input.compressCallId !== undefined ? { compressCallId: input.compressCallId } : {})
  }

  messagesState.blocksById.set(blockId, block)
  messagesState.activeBlockIds.add(blockId)
  messagesState.activeByAnchorMessageId.set(anchorMessageId, blockId)

  const deactivatedAt = Date.now()
  for (const consumedBlockId of consumed) {
    const consumedBlock = messagesState.blocksById.get(consumedBlockId)
    if (!consumedBlock?.active) {
      continue
    }

    consumedBlock.active = false
    consumedBlock.deactivatedAt = deactivatedAt
    consumedBlock.deactivatedByBlockId = blockId
    if (!consumedBlock.parentBlockIds.includes(blockId)) {
      consumedBlock.parentBlockIds.push(blockId)
    }

    messagesState.activeBlockIds.delete(consumedBlockId)
    const mappedBlockId = messagesState.activeByAnchorMessageId.get(consumedBlock.anchorMessageId)
    if (mappedBlockId === consumedBlockId) {
      messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
    }
  }

  const removeActiveBlockId = (entry: { activeBlockIds: number[] }, blockIdToRemove: number): void => {
    if (entry.activeBlockIds.length === 0) {
      return
    }
    entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== blockIdToRemove)
  }

  for (const consumedBlockId of consumed) {
    const consumedBlock = messagesState.blocksById.get(consumedBlockId)
    if (!consumedBlock) {
      continue
    }
    for (const messageId of consumedBlock.effectiveMessageIds) {
      const entry = messagesState.byMessageId.get(messageId)
      if (!entry) {
        continue
      }
      removeActiveBlockId(entry, consumedBlockId)
    }
  }

  for (const messageId of selection.messageIds) {
    const tokenCount = selection.messageTokenById.get(messageId) ?? 0
    const existing = messagesState.byMessageId.get(messageId)

    if (!existing) {
      messagesState.byMessageId.set(messageId, {
        tokenCount,
        allBlockIds: [blockId],
        activeBlockIds: [blockId]
      })
      continue
    }

    existing.tokenCount = Math.max(existing.tokenCount, tokenCount)
    if (!existing.allBlockIds.includes(blockId)) {
      existing.allBlockIds.push(blockId)
    }
    if (!existing.activeBlockIds.includes(blockId)) {
      existing.activeBlockIds.push(blockId)
    }
  }

  for (const messageId of block.effectiveMessageIds) {
    if (selection.messageTokenById.has(messageId)) {
      continue
    }
    const existing = messagesState.byMessageId.get(messageId)
    if (!existing) {
      continue
    }
    if (!existing.allBlockIds.includes(blockId)) {
      existing.allBlockIds.push(blockId)
    }
    if (!existing.activeBlockIds.includes(blockId)) {
      existing.activeBlockIds.push(blockId)
    }
  }

  let compressedTokens = 0
  const newlyCompressedMessageIds: string[] = []
  for (const messageId of effectiveMessageIds) {
    const entry = messagesState.byMessageId.get(messageId)
    if (!entry) {
      continue
    }

    const isNowActive = entry.activeBlockIds.length > 0
    const wasActive = initiallyActiveMessages.has(messageId)

    if (isNowActive && !wasActive) {
      compressedTokens += entry.tokenCount
      newlyCompressedMessageIds.push(messageId)
    }
  }

  const newlyCompressedToolIds: string[] = []
  for (const toolId of effectiveToolIds) {
    if (!initiallyActiveToolIds.has(toolId)) {
      newlyCompressedToolIds.push(toolId)
    }
  }

  block.directMessageIds = [...newlyCompressedMessageIds]
  block.directToolIds = [...newlyCompressedToolIds]

  block.compressedTokens = compressedTokens

  state.stats.pruneTokenCounter += compressedTokens
  state.stats.totalPruneTokens += state.stats.pruneTokenCounter
  state.stats.pruneTokenCounter = 0

  return {
    compressedTokens,
    messageIds: selection.messageIds,
    newlyCompressedMessageIds,
    newlyCompressedToolIds
  }
}

// ---------------------------------------------------------------------------
// Persistence: SessionState <-> PersistedState (Maps/Sets <-> records/arrays)
// ---------------------------------------------------------------------------

export function serializeState(state: SessionState, lastUpdated: string = new Date().toISOString()): PersistedState {
  return {
    sessionId: state.sessionId,
    manualMode: state.manualMode,
    prune: {
      tools: Object.fromEntries(state.prune.tools),
      messages: {
        byMessageId: Object.fromEntries(state.prune.messages.byMessageId),
        blocksById: Object.fromEntries(
          Array.from(state.prune.messages.blocksById.entries()).map(([blockId, block]) => [String(blockId), block])
        ),
        activeBlockIds: Array.from(state.prune.messages.activeBlockIds),
        activeByAnchorMessageId: Object.fromEntries(state.prune.messages.activeByAnchorMessageId),
        nextBlockId: state.prune.messages.nextBlockId,
        nextRunId: state.prune.messages.nextRunId
      }
    },
    nudges: {
      contextLimitAnchors: Array.from(state.nudges.contextLimitAnchors),
      turnNudgeAnchors: Array.from(state.nudges.turnNudgeAnchors),
      iterationNudgeAnchors: Array.from(state.nudges.iterationNudgeAnchors)
    },
    stats: { ...state.stats },
    lastUpdated
  }
}

function hydrateBlock(blockId: number, block: Schema.Schema.Type<typeof CompressionBlockSchema>): CompressionBlock {
  return {
    blockId,
    runId: block.runId,
    active: block.active,
    deactivatedByUser: block.deactivatedByUser,
    compressedTokens: block.compressedTokens,
    summaryTokens: block.summaryTokens,
    durationMs: block.durationMs,
    topic: block.topic,
    startId: block.startId,
    endId: block.endId,
    anchorMessageId: block.anchorMessageId,
    compressMessageId: block.compressMessageId,
    includedBlockIds: [...block.includedBlockIds],
    consumedBlockIds: [...block.consumedBlockIds],
    parentBlockIds: [...block.parentBlockIds],
    directMessageIds: [...block.directMessageIds],
    directToolIds: [...block.directToolIds],
    effectiveMessageIds: [...block.effectiveMessageIds],
    effectiveToolIds: [...block.effectiveToolIds],
    createdAt: block.createdAt,
    summary: block.summary,
    ...(block.mode !== undefined ? { mode: block.mode } : {}),
    ...(block.batchTopic !== undefined ? { batchTopic: block.batchTopic } : {}),
    ...(block.compressCallId !== undefined ? { compressCallId: block.compressCallId } : {}),
    ...(block.deactivatedAt !== undefined ? { deactivatedAt: block.deactivatedAt } : {}),
    ...(block.deactivatedByBlockId !== undefined ? { deactivatedByBlockId: block.deactivatedByBlockId } : {})
  }
}

export function hydrateState(persisted: PersistedState): SessionState {
  const state = createEmptySessionState(persisted.sessionId)
  state.manualMode = persisted.manualMode
  state.stats = {
    pruneTokenCounter: persisted.stats.pruneTokenCounter,
    totalPruneTokens: persisted.stats.totalPruneTokens
  }
  state.prune.tools = new Map(Object.entries(persisted.prune.tools))

  const messages = createPruneMessagesState()
  messages.nextBlockId = Math.max(1, persisted.prune.messages.nextBlockId)
  messages.nextRunId = Math.max(1, persisted.prune.messages.nextRunId)
  for (const [messageId, entry] of Object.entries(persisted.prune.messages.byMessageId)) {
    messages.byMessageId.set(messageId, {
      tokenCount: entry.tokenCount,
      allBlockIds: [...entry.allBlockIds],
      activeBlockIds: [...entry.activeBlockIds]
    })
  }
  for (const [blockIdStr, block] of Object.entries(persisted.prune.messages.blocksById)) {
    const blockId = Number.parseInt(blockIdStr, 10)
    if (!Number.isInteger(blockId) || blockId < 1) {
      continue
    }
    messages.blocksById.set(blockId, hydrateBlock(blockId, block))
  }
  for (const blockId of persisted.prune.messages.activeBlockIds) {
    messages.activeBlockIds.add(blockId)
  }
  for (const [anchor, blockId] of Object.entries(persisted.prune.messages.activeByAnchorMessageId)) {
    messages.activeByAnchorMessageId.set(anchor, blockId)
  }
  state.prune.messages = messages

  state.nudges = {
    contextLimitAnchors: new Set(persisted.nudges.contextLimitAnchors),
    turnNudgeAnchors: new Set(persisted.nudges.turnNudgeAnchors),
    iterationNudgeAnchors: new Set(persisted.nudges.iterationNudgeAnchors)
  }

  return state
}

// ---------------------------------------------------------------------------
// Pi-coupled persistence (thin — the pure code above is the testable core)
// ---------------------------------------------------------------------------

/** Persist the reload-relevant slice of state into a "dcp-state" custom entry. */
export function saveState(pi: ExtensionAPI, state: SessionState): void {
  pi.appendEntry("dcp-state", serializeState(state))
}

/**
 * Scan the current branch for the latest "dcp-state" custom entry and hydrate
 * it. `getBranch()` returns root -> leaf (oldest -> newest), so the newest
 * persisted state is the LAST matching entry — iterate from the end.
 */
export function loadState(ctx: ExtensionContext): Effect.Effect<Option.Option<SessionState>> {
  return Effect.sync(() => {
    const branch = ctx.sessionManager.getBranch()
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i]
      if (entry === undefined) {
        continue
      }
      if (entry.type === "custom" && entry.customType === "dcp-state") {
        const data = (entry as CustomEntry<unknown>).data
        return Option.map(Schema.decodeUnknownOption(PersistedStateSchema)(data), hydrateState)
      }
    }
    return Option.none()
  })
}

// ---------------------------------------------------------------------------
// Service: DcpState (Context.Service backed by a Ref<SessionState>)
// ---------------------------------------------------------------------------

export interface DcpStateService {
  readonly get: () => Effect.Effect<SessionState>
  readonly update: (fn: (state: SessionState) => SessionState) => Effect.Effect<void>
}

export class DcpState extends Context.Service<DcpState, DcpStateService>()("dcp/DcpState") {}

export const makeDcpState = (initial: SessionState) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(initial)
    return DcpState.of({
      get: Effect.fn("DcpState.get")(function* () {
        return yield* Ref.get(ref)
      }),
      update: Effect.fn("DcpState.update")(function* (fn) {
        yield* Ref.update(ref, fn)
      })
    })
  })

export const DcpStateLive = Layer.effect(DcpState, makeDcpState(createEmptySessionState()))
