import { Type } from "@earendil-works/pi-ai"
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Context, Layer } from "effect"

// ---------------------------------------------------------------------------
// Service tags
//
// Thin declarations for now. Later WPs fill the real logic:
//   - Config   (WP1) — resolved DCP config from the dcp.json cascade
//   - DcpState (WP2) — mutable prune/compression session state
//   - Compress (WP6) — the range-compression tool implementation
// ---------------------------------------------------------------------------

export interface ConfigService {
  /** Whether DCP pruning is enabled. */
  readonly enabled: boolean
}

export interface DcpStateService {
  /** Stable session id this state belongs to ("" until hydrated). */
  readonly sessionId: string
}

export interface CompressService {
  /** Compression mode. Only "range" is in scope for the Pi port. */
  readonly mode: "range"
}

export class Config extends Context.Service<Config, ConfigService>()("dcp/Config") {}
export class DcpState extends Context.Service<DcpState, DcpStateService>()("dcp/DcpState") {}
export class Compress extends Context.Service<Compress, CompressService>()("dcp/Compress") {}

/** Stub service implementations — replaced by later WPs. */
export const ConfigLive = Layer.succeed(Config, { enabled: true })
export const DcpStateLive = Layer.succeed(DcpState, { sessionId: "" })
export const CompressLive = Layer.succeed(Compress, { mode: "range" })

/** Composed service layer the prune pipeline will run against (WP11 wires it). */
export const DcpServicesLayer = Layer.mergeAll(ConfigLive, DcpStateLive, CompressLive)

/** Compress tool stub — WP6 fills the real range params and execution logic. */
const compressTool = defineTool({
  name: "compress",
  label: "Compress Context",
  description: "Replace stale conversation spans with high-fidelity summaries (stub).",
  parameters: Type.Object({}),
  async execute() {
    return { content: [], details: {} }
  }
})

/**
 * Pi extension factory.
 *
 * Registers the DCP event hooks, tool, and commands as no-op stubs. The real
 * prune pipeline is assembled in WP11; each hook is wired to the corresponding
 * service above in later WPs.
 */
export default function (pi: ExtensionAPI): void {
  // context — fires before every LLM call; the full prune pipeline (WP11) runs here.
  pi.on("context", (event) => ({ messages: event.messages }))

  // system prompt injection (WP7) — no-op for now.
  pi.on("before_agent_start", async () => {})

  // state persistence (WP2) — no-op for now.
  pi.on("session_start", async () => {})
  pi.on("session_shutdown", async () => {})

  // tool tracking (WP3) — no-op for now.
  pi.on("tool_call", async () => {})
  pi.on("tool_result", async () => {})
  pi.on("tool_execution_end", async () => {})

  // compress tool (WP6) — no-op stub for now.
  pi.registerTool(compressTool)

  // commands (WP9/WP10) — no-op stubs for now.
  pi.registerCommand("dcp", {
    description: "Dynamic Context Pruning controls (stub).",
    async handler() {}
  })
  pi.registerCommand("dcp-compress", {
    description: "Trigger one compression pass (stub).",
    async handler() {}
  })
}
