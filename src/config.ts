import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { Context, Effect, Layer, Schema } from "effect"

// ---------------------------------------------------------------------------
// Literal + union schemas
// ---------------------------------------------------------------------------

export const PermissionSchema = Schema.Literals(["ask", "allow", "deny"])
export type Permission = typeof PermissionSchema.Type

export const NudgeForceSchema = Schema.Literals(["strong", "soft"])
export type NudgeForce = typeof NudgeForceSchema.Type

export const PruneNotificationSchema = Schema.Literals(["off", "minimal", "detailed"])
export type PruneNotification = typeof PruneNotificationSchema.Type

export const PruneNotificationTypeSchema = Schema.Literals(["chat", "toast"])
export type PruneNotificationType = typeof PruneNotificationTypeSchema.Type

/** `number` tokens or a `"X%"` fraction of the model context window. */
export const ContextLimitSchema = Schema.Union([
  Schema.Number,
  Schema.TemplateLiteral([Schema.Number, Schema.Literal("%")])
])
export type ContextLimit = typeof ContextLimitSchema.Type

// ---------------------------------------------------------------------------
// Section schemas + interfaces
// ---------------------------------------------------------------------------

export const DeduplicationSchema = Schema.Struct({
  enabled: Schema.Boolean,
  protectedTools: Schema.Array(Schema.String)
})
export interface Deduplication extends Schema.Schema.Type<typeof DeduplicationSchema> {}

export const PurgeErrorsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  turns: Schema.Number,
  protectedTools: Schema.Array(Schema.String)
})
export interface PurgeErrors extends Schema.Schema.Type<typeof PurgeErrorsSchema> {}

export const CommandsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  protectedTools: Schema.Array(Schema.String)
})
export interface Commands extends Schema.Schema.Type<typeof CommandsSchema> {}

export const ManualModeSchema = Schema.Struct({
  enabled: Schema.Boolean,
  automaticStrategies: Schema.Boolean
})
export interface ManualModeConfig extends Schema.Schema.Type<typeof ManualModeSchema> {}

export const TurnProtectionSchema = Schema.Struct({
  enabled: Schema.Boolean,
  turns: Schema.Number
})
export interface TurnProtection extends Schema.Schema.Type<typeof TurnProtectionSchema> {}

export const CompressConfigSchema = Schema.Struct({
  mode: Schema.Literal("range"),
  permission: PermissionSchema,
  showCompression: Schema.Boolean,
  summaryBuffer: Schema.Boolean,
  maxContextLimit: ContextLimitSchema,
  minContextLimit: ContextLimitSchema,
  modelMaxLimits: Schema.optionalKey(Schema.Record(Schema.String, ContextLimitSchema)),
  modelMinLimits: Schema.optionalKey(Schema.Record(Schema.String, ContextLimitSchema)),
  nudgeFrequency: Schema.Number,
  iterationNudgeThreshold: Schema.Number,
  nudgeForce: NudgeForceSchema,
  protectedTools: Schema.Array(Schema.String)
})
export interface CompressConfig extends Schema.Schema.Type<typeof CompressConfigSchema> {}

export const StrategiesSchema = Schema.Struct({
  deduplication: DeduplicationSchema,
  purgeErrors: PurgeErrorsSchema
})
export interface Strategies extends Schema.Schema.Type<typeof StrategiesSchema> {}

export const ConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  debug: Schema.Boolean,
  pruneNotification: PruneNotificationSchema,
  pruneNotificationType: PruneNotificationTypeSchema,
  commands: CommandsSchema,
  manualMode: ManualModeSchema,
  turnProtection: TurnProtectionSchema,
  protectedFilePatterns: Schema.Array(Schema.String),
  compress: CompressConfigSchema,
  strategies: StrategiesSchema
})

/** Fully-resolved DCP config (what `loadConfig` returns). */
export type ResolvedConfig = Schema.Schema.Type<typeof ConfigSchema>

// ---------------------------------------------------------------------------
// Defaults (ported from `lib/config.ts` `defaultConfig`, OpenCode-only fields dropped)
// ---------------------------------------------------------------------------

const DEFAULT_PROTECTED_TOOLS = [
  "task",
  "skill",
  "todowrite",
  "todoread",
  "compress",
  "batch",
  "plan_enter",
  "plan_exit",
  "write",
  "edit"
]

const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread"]

export const defaultConfig: ResolvedConfig = {
  enabled: true,
  debug: false,
  pruneNotification: "detailed",
  pruneNotificationType: "chat",
  commands: { enabled: true, protectedTools: [...DEFAULT_PROTECTED_TOOLS] },
  manualMode: { enabled: false, automaticStrategies: true },
  turnProtection: { enabled: false, turns: 4 },
  protectedFilePatterns: [],
  compress: {
    mode: "range",
    permission: "allow",
    showCompression: false,
    summaryBuffer: true,
    maxContextLimit: 100000,
    minContextLimit: 50000,
    nudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",
    protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS]
  },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] }
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface ConfigError {
  readonly _tag: "ConfigError"
  readonly reason: string
}

const configError = (reason: string): ConfigError => ({ _tag: "ConfigError", reason })

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  readonly globalPath?: string
  readonly projectPath?: string
}

const defaultGlobalPath = (): string => join(homedir(), ".pi", "agent", "dcp.json")
const defaultProjectPath = (): string => join(process.cwd(), ".pi", "dcp.json")

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Deep-merges plain objects left-to-right; later sources win on conflicts. */
const deepMerge = (...sources: ReadonlyArray<unknown>): unknown => {
  const out: Record<string, unknown> = {}
  for (const source of sources) {
    if (!isPlainObject(source)) continue
    for (const key of Object.keys(source)) {
      const incoming = source[key]
      const existing = out[key]
      if (isPlainObject(existing) && isPlainObject(incoming)) {
        out[key] = deepMerge(existing, incoming)
      } else {
        out[key] = incoming
      }
    }
  }
  return out
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const readJsonFile = (path: string): Effect.Effect<unknown, ConfigError> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await exists(path))) return undefined
      const text = await readFile(path, "utf8")
      return JSON.parse(text) as unknown
    },
    catch: (cause) => configError(`Failed to read config at ${path}: ${String(cause)}`)
  })

/**
 * Resolves DCP config from the Pi cascade: `~/.pi/agent/dcp.json` (global) >
 * `.pi/dcp.json` (project). Project wins on conflicts; missing files fall back
 * to defaults. Paths are injectable for testing.
 */
export const loadConfig = (options: LoadConfigOptions = {}): Effect.Effect<ResolvedConfig, ConfigError> =>
  Effect.gen(function* () {
    const globalRaw = yield* readJsonFile(options.globalPath ?? defaultGlobalPath())
    const projectRaw = yield* readJsonFile(options.projectPath ?? defaultProjectPath())
    const merged = deepMerge(defaultConfig, globalRaw, projectRaw)
    return yield* Schema.decodeUnknownEffect(ConfigSchema)(merged).pipe(
      Effect.mapError((cause) => configError(`Invalid dcp config: ${String(cause)}`))
    )
  })

// ---------------------------------------------------------------------------
// Service tag + layer
// ---------------------------------------------------------------------------

/** Resolved DCP config plus the accessors the prune pipeline relies on. */
export interface ConfigService extends ResolvedConfig {
  readonly getCompressPermission: () => Permission
  readonly getManualMode: () => ManualModeConfig
}

export class Config extends Context.Service<Config, ConfigService>()("dcp/Config") {}

const toService = (data: ResolvedConfig): ConfigService => ({
  ...data,
  getCompressPermission: () => data.compress.permission,
  getManualMode: () => data.manualMode
})

/** Static default-config service. WP11 overlays `loadConfig`'s resolved value. */
export const ConfigLive = Layer.succeed(Config, toService(defaultConfig))
