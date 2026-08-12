# AGENTS.md

`pi-dcp` is a **new package** — an exact port of the `@tarquinen/opencode-dcp` OpenCode plugin to a **Pi extension**. It is not a wrapper: logic is rewritten to operate directly on Pi's `AgentMessage[]`.

- **`PLAN.md` is the spec** — read it first. It has the verified Pi API facts, the OpenCode-hook → Pi-event mapping table, the file-by-file Work Package breakdown, and the stable-identity design.
- `src/main.ts` is currently empty; the port is not yet scaffolded. `package.json` still has a placeholder `test` script and no `pi.extensions` field — add both when scaffolding.
- The source being ported (**not** part of this repo) lives one level up as `../opencode-dynamic-context-pruning` (package `@tarquinen/opencode-dcp`, entry `index.ts` + `lib/**`); read it directly via `read`/`bash` (resolved from `(repo)/../opencode-dynamic-context-pruning/`). **Do not port the parent's toolchain (npm/tsup/prettier) — see below.**

## Implementation context

This port is implemented through **Pi**, not OpenCode. `.opencode/opencode.json` is OpenCode-era config; pi does not parse or honor it, so its `references` (e.g. `dcp-source`) and `agent` subagent entries (`worker`, `explore`) have **no effect** under Pi — do not rely on them. All port work happens in the main Pi session; reach the sibling source by its plain path above rather than via the opencode.json reference key.

## Subagents (`pi-subagents` extension)

The `pi-subagents` extension is installed, so WPs can be delegated to focused child agents and run in parallel. Built-ins: `worker` (implementation), `scout` (codebase recon), `reviewer` (diff/plan review), `oracle` (decision-consistency), `researcher` (web/API lookup), `delegate` (lightweight, parent-model inherit), `visual` (vision). The main session stays the orchestrator: `scout` → `worker` → `reviewer`/`oracle`. See `PLAN.md`'s preamble for the per-WP delegation map. Note: this is about **orchestrating the port** — porting DCP's *own* `allowSubAgents` / subagent-context handling feature remains **out of scope**.

## Toolchain (differs from the parent repo — do not mix)

- Package manager: **`aube`**, not npm/pnpm (lockfile `aube-lock.yaml`). Activated via **`mise`** (`mise.toml` → `aube = "latest"`). Use `aube install`, `aube add <dep>`, `aube run <script>`, `aube test`.
- Formatter/linter: **`biome`** (`biome.json`: 2-space indent, double quotes, no semicolons, no trailing commas, lineWidth 120). Verify with `aube exec biome check src` / `aube exec biome format src`.
- TypeScript 7 via `@effect/tsgo`; runtime dep `effect@^4.0.0-rc.108`, plus `@effect/language-service` for the LSP. Typecheck with `aube exec effect-tsgo --noEmit` (the binary is `effect-tsgo`; `tsc` is also installed).
- Before writing any Effect code, read `node_modules/effect/AGENTS.md` and the local skill `.agents/skills/effect/SKILL.md` (skill name is `effect`, not `effect-ts`).
- `tsconfig.json` is strict with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` — mind these when porting (the parent's `tsconfig` is looser).

## Load-bearing Pi facts (from PLAN.md — source-checked)

- `pi.on("context", handler)` fires before every LLM call; `event.messages` is a deep copy of `AgentMessage[]`. Returns `{ messages: AgentMessage[] }` to replace. Non-destructive — the session tree is untouched.
- `AgentMessage` union: `UserMessage | AssistantMessage | ToolResultMessage | BashExecutionMessage | CustomMessage | BranchSummaryMessage | CompactionSummaryMessage`. `AssistantMessage.content` carries `ToolCall { type:"toolCall", id, name, arguments }` blocks; `ToolResultMessage { toolCallId, … }`.
- Prune/dedup/purge maps are keyed by stable `toolCallId` (`ToolResultMessage.toolCallId`); compression blocks are keyed by stable branch **entry ids** (`ctx.sessionManager.getBranch()` → 8-char hex ids).
- `ctx.getContextUsage()` → `{ tokens, contextWindow, percent } | undefined` — **replaces DCP's manual token counting** for nudge thresholds.
- Persist non-LLM state via `pi.appendEntry("dcp-state", …)` (survives `/reload`, branch-aware; custom entries do NOT enter LLM context). Inject LLM-visible summaries/nudges by returning modified `AgentMessage[]` (or use `CustomMessage` for durable+visible content).
- `pi.registerTool` / `pi.registerCommand` for the `compress` tool and `/dcp` command.
- Config cascade (pi-specific, not the parent's `dcp.jsonc` paths): `~/.pi/agent/dcp.json` > `.pi/dcp.json`.
- Locked scope: core + TUI panel. **Out of scope:** message-mode compress, custom prompt overrides, autoUpdate, secure-mode/auth, subagent handling, protect-tags/protectUserMessages, hallucination stripping. Do not port these.

## Local skills

`.agents/skills/` bundles `effect` (Effect v4 patterns) and `opentui` (Solid/React terminal-UI bindings) — relevant when building the `/dcp` TUI panel via `ctx.ui.custom`.