import type { ResolvedConfig } from "../core/config.js"
import { getFilePathsFromParameters, isFilePathProtected, isToolNameProtected } from "../core/prune.js"
import type { SessionState } from "../core/state.js"

// ---------------------------------------------------------------------------
// Automatic context-pruning strategies.
//
// Both strategies are PURE and mutate `state` in place. They follow the
// mark-then-apply contract: they write pruned tool-call ids into
// `state.prune.tools`, which `pruneToolOutputs` / `pruneToolErrors` then apply.
// ---------------------------------------------------------------------------

/**
 * Deduplication — prune older tool calls that have an identical tool name +
 * normalized parameters, keeping only the most recent occurrence.
 */
export const deduplicate = (state: SessionState, config: ResolvedConfig): void => {
  if (state.manualMode !== false && !config.manualMode.automaticStrategies) return
  if (!config.strategies.deduplication.enabled) return

  const allToolIds = state.toolIdList
  if (allToolIds.length === 0) return

  // Filter out ids already pruned.
  const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))
  if (unprunedIds.length === 0) return

  const protectedTools = config.strategies.deduplication.protectedTools

  // Group by signature (tool name + normalized parameters).
  const signatureMap = new Map<string, string[]>()
  for (const id of unprunedIds) {
    const metadata = state.toolParameters.get(id)
    if (metadata === undefined) continue

    if (isToolNameProtected(metadata.tool, protectedTools)) continue

    const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters)
    if (isFilePathProtected(filePaths, config.protectedFilePatterns)) continue

    const signature = createToolSignature(metadata.tool, metadata.parameters)
    const ids = signatureMap.get(signature)
    if (ids === undefined) {
      signatureMap.set(signature, [id])
    } else {
      ids.push(id)
    }
  }

  // Keep only the most recent (last) in each group.
  const newPruneIds: string[] = []
  for (const ids of signatureMap.values()) {
    if (ids.length > 1) {
      newPruneIds.push(...ids.slice(0, -1))
    }
  }

  state.stats.totalPruneTokens += getTotalToolTokens(state, newPruneIds)

  if (newPruneIds.length > 0) {
    for (const id of newPruneIds) {
      const entry = state.toolParameters.get(id)
      state.prune.tools.set(id, entry?.tokenCount ?? 0)
    }
  }
}

/**
 * Purge Errors — prune tool inputs for tools that errored once they are older
 * than a configurable number of turns. The error message is preserved (via
 * `pruneToolErrors` clearing only `details`), the potentially large inputs are
 * dropped.
 */
export const purgeErrors = (state: SessionState, config: ResolvedConfig): void => {
  if (state.manualMode !== false && !config.manualMode.automaticStrategies) return
  if (!config.strategies.purgeErrors.enabled) return

  const allToolIds = state.toolIdList
  if (allToolIds.length === 0) return

  const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))
  if (unprunedIds.length === 0) return

  const protectedTools = config.strategies.purgeErrors.protectedTools
  const turnThreshold = Math.max(1, config.strategies.purgeErrors.turns)

  const newPruneIds: string[] = []
  for (const id of unprunedIds) {
    const metadata = state.toolParameters.get(id)
    if (metadata === undefined) continue

    if (isToolNameProtected(metadata.tool, protectedTools)) continue

    const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters)
    if (isFilePathProtected(filePaths, config.protectedFilePatterns)) continue

    if (metadata.status !== "error") continue

    const turnAge = state.currentTurn - metadata.turn
    if (turnAge >= turnThreshold) {
      newPruneIds.push(id)
    }
  }

  if (newPruneIds.length > 0) {
    state.stats.totalPruneTokens += getTotalToolTokens(state, newPruneIds)
    for (const id of newPruneIds) {
      const entry = state.toolParameters.get(id)
      state.prune.tools.set(id, entry?.tokenCount ?? 0)
    }
  }
}

/**
 * Superseded Writes — drop earlier write/edit tool calls to a file once a
 * later write/edit to the SAME path exists (the filesystem is the source of
 * truth, so the earlier full content is redundant).
 *
 * Unlike `deduplicate`/`purgeErrors` (which only replace the toolResult text
 * or clear error `details`), this strategy marks the WHOLE toolCall+result
 * pair for dropping: the large payload lives in the assistant `toolCall`
 * arguments (`{ path, content }` / `{ path, edits[] }`), not the ~40-byte
 * toolResult text. The dedicated `dropSupersededWrites` applier removes the
 * assistant toolCall block and its toolResult atomically (no orphaned `tool`
 * role message).
 *
 * Grouping is by file path ONLY (later write or edit supersedes any earlier
 * write/edit to the same path). Errored tool calls are never marked — the
 * error text is signal and `purgeErrors` owns that path.
 */
export const supersededWrites = (state: SessionState, config: ResolvedConfig): void => {
  if (state.manualMode !== false && !config.manualMode.automaticStrategies) return
  if (!config.strategies.supersededWrites.enabled) return

  const allToolIds = state.toolIdList
  if (allToolIds.length === 0) return

  // Filter out ids already pruned.
  const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))
  if (unprunedIds.length === 0) return

  const protectedTools = config.strategies.supersededWrites.protectedTools

  // Group write/edit tool calls by file path, preserving oldest->newest order.
  const byPath = new Map<string, string[]>()
  for (const id of unprunedIds) {
    const metadata = state.toolParameters.get(id)
    if (metadata === undefined) continue

    // Only successful file mutations are superseded; errored calls keep their
    // error signal (and belong to purgeErrors).
    if (metadata.tool !== "write" && metadata.tool !== "edit") continue
    if (metadata.status !== "completed") continue

    if (isToolNameProtected(metadata.tool, protectedTools)) continue

    const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters)
    if (isFilePathProtected(filePaths, config.protectedFilePatterns)) continue

    const path = filePaths[0]
    if (path === undefined || path.length === 0) continue

    const ids = byPath.get(path)
    if (ids === undefined) {
      byPath.set(path, [id])
    } else {
      ids.push(id)
    }
  }

  // Keep only the most recent (last) write/edit per path; mark earlier ones.
  const newPruneIds: string[] = []
  for (const ids of byPath.values()) {
    if (ids.length > 1) {
      newPruneIds.push(...ids.slice(0, -1))
    }
  }

  if (newPruneIds.length > 0) {
    state.stats.totalPruneTokens += getTotalToolTokens(state, newPruneIds)
    for (const id of newPruneIds) {
      const entry = state.toolParameters.get(id)
      state.prune.tools.set(id, entry?.tokenCount ?? 0)
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// and lib/token-utils.ts:131-138). No tokenizer dependency is added.
// ---------------------------------------------------------------------------

function createToolSignature(tool: string, parameters: unknown): string {
  if (!parameters) return tool
  return `${tool}::${JSON.stringify(sortObjectKeys(normalizeParameters(parameters)))}`
}

function normalizeParameters(params: unknown): unknown {
  if (typeof params !== "object" || params === null) return params
  if (Array.isArray(params)) return params

  const record = params as Record<string, unknown>
  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (value !== undefined && value !== null) {
      normalized[key] = value
    }
  }
  return normalized
}

function sortObjectKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value
  if (Array.isArray(value)) return value.map(sortObjectKeys)

  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortObjectKeys(record[key])
  }
  return sorted
}

function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
  let total = 0
  for (const id of toolIds) {
    const entry = state.toolParameters.get(id)
    total += entry?.tokenCount ?? 0
  }
  return total
}
