# Plan: Port DCP (Dynamic Context Pruning) to a Pi Extension

> This is a **handout plan** for the main Pi session with subagent delegation. The work is
> split into independent **Work Packages (WPs)** below. Each WP lists its owner
> files, inputs, outputs, dependencies on other WPs, and acceptance criteria.
> Pick a WP, read its "Context you can rely on" section (no re-discovery needed),
> implement, then run the global Verification steps.
> `(repo)` = `pi-dcp/`, the repo this file lives in. `(src)` = the DCP source in
> the sibling repo at `(repo)/../opencode-dynamic-context-pruning/` (`index.ts` + `lib/**`).
>
> **Subagents** (installed `pi-subagents` extension). The main Pi session is the
> **orchestrator** and sole decision-maker; children never decide scope, merge,
> or release silently. All execution goes through `subagent` with a
> `workflowScript` (the only public execution surface):
> - `runs.run("key", { agent, task, ... })` — one child.
> - `runs.all([ { key, agent, task, ... }, ... ])` — parallel wave.
> - `async: true` by default (do not block the chat); `context: "fresh"` for
>   read-only recon/review, `context: "fork"` when the child needs parent history.
> - `gate: "aube exec vitest run"` for one-shot host verification; cannot combine
>   with `acceptance`.
>
> Built-in agents used by this port:
> - `worker` — single-writer implementation: multi-file edits, porting logic from
>   `(src)`. Default role for every WP implementation pass.
> - `scout` — fast fresh-context codebase recon returning compressed context for
>   handoff. Use to preload `(src)` `lib/**` structure or locate symbols before a WP.
> - `reviewer` — fresh-context review specialist (read-only unless a fix pass is
>   explicit). Use to verify a WP against its acceptance criteria.
> - `oracle` (alias: `advisor`) — forked-context decision-consistency oracle.
>   Use to check a WP's design against the locked Decisions / `PLAN.md` facts.
> - `researcher` — autonomous web researcher for Pi / Effect API lookups the
>   "Verified Pi API facts" block does not already cover.
> - `delegate` — lightweight, parent-model-inheriting agent for small tasks.
> - `visual` (user agent `~/.pi/agent/agents/visual.md`) — vision analysis for TUI
>   screenshots (WP9 panel acceptance).
>
> ### Per-WP delegation pattern
>
> Each WP runs as a three-phase workflow the parent launches with `async: true`:
> (1) a `scout` recon (fresh context, `mission: false`) to hand the worker the
> exact `(src)` symbols + Pi seams; (2) one `worker` implementation pass
> (single-writer — **never two workers in the same worktree**); (3) a fresh-context
> `reviewer` acceptance fanout against the WP's Accept criteria. The parent reads
> the reviewer findings, synthesizes fixes, and either applies them itself or
> launches one follow-up `worker` (`resume` the same worker is fine). `oracle` is
> used up-front only when a WP's design touches a locked Decision.
>
> ```text
> subagent({
>   async: true,
>   workflowScript: `
>     const recon = await runs.run("recon", {
>       agent: "scout", context: "fresh", mission: false,
>       task: "Locate <WP's (src)> symbols <list> in ../opencode-dynamic-context-pruning/lib/... and the matching Pi API surface in node_modules/@earendil-works/pi-coding-agent. Return file:line refs + signature excerpts only."
>     });
>     const impl = await runs.run("impl", {
>       agent: "worker",
>       task: "Implement WP<n> per PLAN.md. Scope: <owner files only>. Write no other files. " + recon.output,
>       gate: "aube exec effect-tsgo --noEmit"
>     });
>     const acc = await runs.all([
>       { key: "accept", agent: "reviewer", context: "fresh",
>         task: "Verify WP<n> against its Accept criteria in PLAN.md. Inspect the diff directly; evidence-backed pass/fail with file:line refs. Do not edit." },
>       { key: "strict", agent: "reviewer", context: "fresh",
>         task: "Audit WP<n> for biome (2-space, no semicolons, no trailing commas) and strict-tsconfig (exactOptionalPropertyTypes, noUncheckedIndexedAccess, verbatimModuleSyntax). Report violations only; do not edit." }
>     ]);
>     return { impl: impl.output, acceptance: acc.map(r => r.output) };
>   `
> })
> ```
>
> Parallel worker waves: WPs with independent owner files may run as concurrent
> `worker` children in one `runs.all`, but only with `worktree: true` per child
> (each gets its own git worktree branched from HEAD). The parent then merges each
> child's `artifactPaths` patch back into the main checkout. Without worktree
> isolation, sequence the workers (single-writer) and keep recon/review parallel.
>
> Each WP's **"Context you can rely on"** section is self-contained so a `worker`
> subagent does not re-discover `(src)` structure; the scout phase just pins
> exact line refs.

## Context

DCP (`@tarquinen/opencode-dcp`, source in the sibling `opencode-dynamic-context-pruning/` repo) is an **OpenCode plugin**
that reduces token usage by non-destructively pruning/compressing conversation
context before it reaches the LLM. It exposes a `compress` tool the model calls
to replace stale conversation spans with high-fidelity summaries, plus automatic
strategies (deduplication, error-input purge) and context-limit nudges.

We want **this exact functionality** as a **Pi extension** (earendil-works/pi).
Pi Discussion #330 confirms its `context` event was built specifically to enable
DCP-style non-destructive pruning, persisted via custom session entries.

## Decisions (locked)

1. **Native Pi rewrite** — logic rewritten to operate on `AgentMessage[]`; no
   OpenCode `{info, parts}` adapter.
2. **Core + TUI panel** scope. **Out of scope:** experimental message-mode
   compress, custom prompt overrides, autoUpdate, secure-mode/auth, subagent
   handling, protect-tags / protectUserMessages, text-complete hallucination
   stripping.
3. **Persistence via `pi.appendEntry("dcp-state", …)`** (branching-aware).

## Verified Pi API facts (source-checked — rely on these)

- `pi.on("context", handler)` fires before every LLM call. `event.messages` is a
  **deep copy of `AgentMessage[]`**. Handler returns `{ messages: AgentMessage[] }`
  to replace. Non-destructive — the session tree is untouched.
- `AgentMessage` union: `UserMessage | AssistantMessage | ToolResultMessage |
  BashExecutionMessage | CustomMessage | BranchSummaryMessage |
  CompactionSummaryMessage`.
  - `AssistantMessage.content` holds `ToolCall { type:"toolCall", id, name, arguments }` blocks.
  - `ToolResultMessage { role:"toolResult", toolCallId, toolName, content, isError, details }`.
  - `BashExecutionMessage { role:"bashExecution", command, output, … excludeFromContext }`.
  - `CustomMessage { role:"custom", customType, content, display, details }` —
    persists *and* enters LLM context (use for injected summaries/nudges if you
    want them durable & visible); otherwise just return ephemeral modified
    `AgentMessage[]`.
- `ctx.sessionManager.getBranch()` (ReadonlySessionManager) → branch entries
  `SessionEntryBase { id, parentId, timestamp, message?, … }` with **stable
  8-char hex ids** — key compression blocks by these; tool-output prune map by
  the stable `toolCallId` (`ToolCall.id` / `ToolResultMessage.toolCallId`).
- `ctx.getContextUsage(): { tokens, contextWindow, percent } | undefined` → live
  counts, **replaces DCP's manual token counting** for nudge thresholds.
- `pi.registerTool({ name, label, description, parameters, async
  execute(toolCallId, params, signal, onUpdate, ctx) })` → returns
  `{ content: ContentBlock[], details }`.
- `pi.registerCommand(name, { description, handler: async (args, ctx) })`.
- `pi.appendEntry(customType, data?)` persists **non-LLM** state in the session
  tree (survives `/reload`, branch-aware). Custom entries do NOT enter LLM
  context. To inject LLM-visible content, return modified `AgentMessage[]` (or
  emit a `CustomMessage`).
- `pi.on("before_agent_start", …)` can modify the system prompt.
- `pi.on("tool_result" / "tool_call" / "tool_execution_start" /
  "tool_execution_end")` for tracking + compress timing.
- `pi.registerEntryRenderer(customType, renderer)` + `ctx.ui.custom(...)` for
  TUI; `ctx.ui.notify / confirm / select` for prompts.
- `ExtensionContext` (in any event/command handler): `ui, mode, hasUI, cwd,
  sessionManager, modelRegistry, model, scopedModels, thinkingLevel, signal,
  getContextUsage(), getSystemPrompt(), compact()`.
- `ExtensionCommandContext` adds `waitForIdle()`, `newSession()`, `fork()`,
  `navigateTree()`, `switchSession()`, `reload()`, `getSystemPromptOptions()`.

## OpenCode hook → Pi event mapping

| DCP (OpenCode)                                  | Pi                                                                  |
|-------------------------------------------------|---------------------------------------------------------------------|
| `experimental.chat.messages.transform`          | `pi.on("context", …)` → return `{ messages }`                       |
| `experimental.chat.system.transform`           | `pi.on("before_agent_start", …)` (augment system prompt)            |
| `tool.compress` (range)                         | `pi.registerTool({ name:"compress" })`                             |
| `command.execute.before` (`/dcp`, `/dcp-compress`) | `pi.registerCommand("dcp" / "dcp-compress", …)`                |
| `event` (compress timing)                        | `pi.on("tool_execution_end", …)` for the compress tool             |
| tool cache / parameter tracking                  | `pi.on("tool_result"/"tool_call", …)`                              |
| session state persistence (`saveSessionState`)   | `pi.appendEntry("dcp-state", …)` + read on `session_start`         |
| chat prune notification                          | `ctx.ui.notify(…)` + injected summary `CustomMessage`              |
| `/dcp` TUI panel                                 | `ctx.ui.custom(…)` (+ `registerEntryRenderer`)                     |
| config `dcp.jsonc`                               | loader: `~/.pi/agent/dcp.json` > `.pi/dcp.json`                    |
| manual token counting / `modelContextLimit`      | `ctx.getContextUsage()`                                            |

## Target repo + toolchain (existing — do not re-scaffold)

The repo **`pi-dcp/`** (this file's location) is already initialized: git, deps
installed via **`aube`**, `biome`, TS7 via `@effect/tsgo`, **`effect@4`**,
bundled local skills for **effect** and **opentui`. `src/main.ts` is empty.

Rules (from `pi-dcp/AGENTS.md`):

- **Package manager: `aube`** (`aube-lock.yaml`, pinned via `mise`). Use
  `aube install`, `aube add <dep>`, `aube run <script>`, `aube exec <bin>`.
  Never introduce npm/pnpm.
- **Formatter/linter: `biome`** (`biome.json`): 2-space, double quotes, no
  semicolons, **no trailing commas**, lineWidth 120. Run
  `aube exec biome check src --write` / `aube exec biome format src --write`.
- **TypeScript 7**, strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` +
  `verbatimModuleSyntax` + `isolatedModules`. Code must satisfy these.
- **Implementation in `effect@^4.0.0-rc.108`**: use `Effect`, `Layer`, `Context.Tag`
  services for state/config/compression, and `Schema` for config + tool params.
  **Read `pi-dcp/.agents/skills/effect/SKILL.md` + `references/` first**
  (CACHING, CONFIG, SCHEMA, SERVICES_LAYERS, STREAMS, TESTING).
- **TUI panel via opentui**: read `pi-dcp/.agents/skills/opentui/SKILL.md` first.

### Shared dependency-graph (stable-identity design)

DCP prunes tool **outputs** keyed by tool call; in Pi each call has a stable
`toolCallId`. Dedup/purge/prune-tool-output maps are keyed by `toolCallId` and
applied in the `context` handler by matching `ToolResultMessage.toolCallId`.

DCP's range compression anchors on message ids and replaces contiguous spans
with a summary injected as a synthetic message. In Pi the compress tool runs
with `ctx` exposing `ctx.sessionManager.getBranch()`, so it records compression
blocks keyed by **branch entry ids** (`startEntryId`, `endEntryId`,
`anchorEntryId`). At `context` time the handler walks the same branch to align
`event.messages` positions → entry ids (branch messages, in order; non-LLM
entries are filtered before `context`, so alignment is index-by-order), then:
(a) drops entries inside pruned ranges, (b) injects a summary `CustomMessage`
at the anchor position.

---

# Work Packages

> WPs are independently assignable. Respect the **Depends on** ordering. Each
> produces code that type-checks under the strict tsconfig and passes `biome`.

## WP0 — Project bootstrap & extension wiring

- **Owner:** `(repo)/package.json`, `(repo)/src/main.ts`.
- **Depends on:** nothing.
- **Context you can rely on:** Pi `ExtensionAPI` factory =
  `export default function (pi: ExtensionAPI) { … }`. Import types from
  `@earendil-works/pi-coding-agent`. The factory may be `async`.
- **Tasks:**
  1. Edit `package.json`: add `"pi": { "extensions": ["./src/main.ts"] }`; set
     `"main": "src/main.ts"`; replace placeholder `test` with
     `"test": "aube exec vitest run"`.
  2. `aube add -D @earendil-works/pi-coding-agent @earendil-works/pi-ai typebox
     @effect/platform @effect/vitest`.
  3. `src/main.ts`: export the factory wired to an Effect `Layer` composition;
     for now stub-register every hook (`context`, `before_agent_start`,
     `session_start`, `session_shutdown`, `tool_call`, `tool_result`,
     `tool_execution_end`), `registerTool("compress", …)`, and
     `registerCommand("dcp"/"dcp-compress")` as no-ops that delegate to services
     to be filled by later WPs. Keep a single `defineAppConfig?` absent (Pi has
     none); just the factory.
  4. Ensure `aube exec tsc --noEmit` (or `@effect/tsgo`) + `biome check` pass.
- **Outputs:** a loadable extension skeleton; empty services with the right
  `Context.Tag` shapes (`Config`, `DcpState`, `Compress`) consumed by later WPs.
- **Accept:** `pi -e ./src/main.ts` loads without errors and the no-op hooks fire.

## WP1 — Config (`src/config.ts`)

- **Owner:** `(repo)/src/config.ts`.
- **Depends on:** WP0 (service tag).
- **Context you can rely on:** DCP defaults live at `(repo)/../opencode-dynamic-context-pruning/lib/config.ts` and
  in `README.md` ("Default Configuration" block). Pi path cascade:
  `~/.pi/agent/dcp.json` (global) > `.pi/dcp.json` (project). JSONC not required;
  use plain JSON + Effect `Schema.parseUnknown`. Drop OpenCode-only fields:
  `autoUpdate`, `secureMode`, `allowSubAgents`, `customPrompts`, `protectTags`,
  `protectUserMessages`, `modelMax/modelMinLimits` may be kept optional.
- **Tasks:** Define `ConfigSchema` (Effect `Schema`) with all kept defaults;
  `loadConfig(ctx): Effect<Config>` resolving the cascade; expose a
  `Config.Tag` service providing the resolved `Config`. Provide
  `getCompressPermission`/`manualMode` accessors mirroring DCP semantics
  (permission: `allow|ask|deny`; `manualMode.enabled` + `automaticStrategies`).
- **Accept:** unit test (`@effect/vitest`) parses global+project overrides and
  asserts project wins; defaults applied when absent.

## WP2 — State service & persistence (`src/state.ts`)

- **Owner:** `(repo)/src/state.ts`.
- **Depends on:** WP0, WP1 (for `sessionId`/`cwd`).
- **Context you can rely on:** Port `SessionState`, `CompressionBlock`,
  `Prune`, `MessageIdState`, `Nudges` from `(repo)/../opencode-dynamic-context-pruning/lib/state/types.ts`, but
  re-key to Pi: prune `tools: Map<toolCallId, tokenCount>`,
  `prune.messages.blocksById: Map<number, Block>` where `Block.startId/endId/
  anchorMessageId/compressMessageId` become **entry ids** (strings) and
  `compressCallId` stays a `toolCallId`. Persist the whole serializable state via
  `pi.appendEntry("dcp-state", data)` (one entry per save; latest wins for load).
  On `session_start`, scan `ctx.sessionManager` entries for the latest
  `customType === "dcp-state"` and hydrate.
- **Tasks:** `DcpState.Tag` service with `get`/`update`; `loadState(ctx)` and
  `saveState(pi)`. Pure functions for `allocateBlockId/RunId`, block nesting
  (`consumedBlockIds`, `parentBlockIds`), `applyCompressionState`,
  `activeBlockIds` resolution. Port the nesting logic from
  `(repo)/../opencode-dynamic-context-pruning/lib/compress/state.ts`.
- **Accept:** unit tests: round-trip save→load; nesting merges overlapping
  blocks (older summary nested inside newer); `activeByAnchorMessageId` updates
  correctly.

## WP3 — Tool-call tracking (`src/tracking.ts`)

- **Owner:** `(repo)/src/tracking.ts`.
- **Depends on:** WP0, WP2 (mutates `DcpState`).
- **Context you can rely on:** `tool_call` event carries
  `{ toolName, input, toolCallId }` (mutate `input` to change args; do NOT for
  tracking). `tool_result` event carries the executed `ToolResultMessage`
  (`toolCallId`, `toolName`, `content`, `details`, `isError`). `currentTurn`
  increments at `turn_start`/`turn_end` boundary; simplest: increment on each
  `tool_execution_end`. DCP records `{ tool, parameters, status, turn,
  tokenCount }` in `toolParameters` (`(repo)/../opencode-dynamic-context-pruning/lib/state/types.ts`). TokenCount
  optional (stats-only); use `@anthropic-ai/tokenizer`? — prefer NOT adding a
  dep; approximate via character/4 or skip (thresholds use `getContextUsage`).
- **Tasks:** handlers `onToolCall`, `onToolResult`, `onTurnEnd` updating
  `DcpState.toolParameters` + `toolIdList` + `currentTurn`. Track compress-timing
  via `tool_execution_start`/`tool_execution_end` when `toolName === "compress"`,
  writing `durationMs` into the relevant `CompressionBlock` (port
  `lib/compress/timing.ts`).
- **Accept:** after a few synthetic tool events, `DcpState` holds one entry per
  `toolCallId` with last turn + status; compress timing recorded.

## WP4 — Prune core (`src/prune.ts`)

- **Owner:** `(repo)/src/prune.ts`.
- **Depends on:** WP1, WP2.
- **Context you can rely on:** `(repo)/../opencode-dynamic-context-pruning/lib/messages/prune.ts` is the spec.
  Operates on the **deep-copy `AgentMessage[]`** from the `context` event.
  Replacement strings:
  - `PRUNED_TOOL_OUTPUT_REPLACEMENT = "[Output removed to save context - information superseded or no longer needed]"`
  - `PRUNED_TOOL_ERROR_REPLACEMENT = "[input removed due to failed tool call]"`
  - `PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"`
  - In Pi: `pruneToolOutputs` replaces `ToolResultMessage.content` text blocks
    with the placeholder (skip protected tools: `task? skill? todowrite?
    todoread? compress batch plan_enter plan_exit write edit read` — adapt the
    default list from README "Protected Tools"; exclude `bash`? keep `read`).
  - `pruneToolErrors` clears `ToolResultMessage.details` (input-bearing) for
    errored results past N turns (config `strategies.purgeErrors.turns`).
  - `applyCompressedRanges`: drop messages whose branch-entry-id is inside a
    range, inject a `CustomMessage` (`customType:"dcp-compression-summary",
    content: summary, display:false`) at the anchor position. Use
    `ctx.sessionManager.getBranch()` to map `event.messages` indices → entry ids
    (walk branch messages in order; pair by index after filtering non-LLM).
- **Tasks:** pure functions; export `prune(messages, ctx, state, config):
  AgentMessage[]`. Also port protected-pattern matching from
  `(repo)/../opencode-dynamic-context-pruning/lib/protected-patterns.ts` (glob on tool args' `path`/`filePath`).
- **Accept:** unit tests:
  - duplicate `read` → earlier output becomes placeholder;
  - errored `bash` result details cleared after N turns (not before);
  - a recorded compression block → span dropped + summary `CustomMessage` at
    anchor; protected tool/file untouched.

## WP5 — Strategies: dedup + purgeErrors (`src/strategies/*.ts`)

- **Owner:** `(repo)/src/strategies/deduplication.ts`,
  `(repo)/src/strategies/purge-errors.ts`.
- **Depends on:** WP2, WP3 (reads `toolIdList` + `toolParameters`), WP4 (writes
  prune map via `state.prune.tools`).
- **Context you can rely on:** `(repo)/../opencode-dynamic-context-pruning/lib/strategies/deduplication.ts` groups
  by `${tool}::${stableJson(normalizedArgs)}` keeping the most recent; marks the
  rest into `state.prune.tools` (`deduplicate`). `(repo)/../opencode-dynamic-context-pruning/lib/strategies/
  purge-errors.ts` marks errored tool inputs (beyond `turns`) into
  `state.prune.tools` (`purgeErrors`). Both honor `config.strategies.*.enabled`,
  `protectedTools`, `protectedFilePatterns`, and
  `manualMode.automaticStrategies` when manual. Computed **before** `prune`
  during the `context` handler so the prune map is fresh each turn (DCP does this
  on compress-tool use; in Pi recompute on every `context` is cheap and avoids
  stale maps).
- **Tasks:** port both; signature `(state, config) => void` mutating the prune
  map; recompute on each `context` invocation.
- **Accept:** unit tests: two identical `read path/X` → earlier marked; errored
  tool older than N turns marked, newer not; protected tools/files exempt; manual
  + `automaticStrategies=false` skips.

## WP6 — Compress range tool (`src/compress/range.ts`, `state.ts`)

- **Owner:** `(repo)/src/compress/range.ts`, `(repo)/src/compress/state.ts`.
- **Depends on:** WP1, WP2, WP3.
- **Context you can rely on:** `(repo)/../opencode-dynamic-context-pruning/lib/compress/range.ts` + `state.ts` +
  `protected-content.ts` + `pipeline.ts` are the spec. The tool is registered via
  `pi.registerTool` with a `typebox`/Effect `Schema` `parameters`:
  `{ topic: string; content: Array<{ startId: string; endId: string; summary:
  string }> }` (these IDs are **branch entry ids** now). `execute` receives `ctx`
  exposing `ctx.sessionManager.getBranch()`; resolve ranges against the branch,
  validate non-overlap, inject nested-block placeholders, append protected tool
  outputs (`task`/`skill`/`todowrite`/`todoread` by default +
  `compress.protectedTools`), append protected-file content if
  `protectedFilePatterns`. Allocate `blockId`/`runId`; write one
  `CompressionBlock` per range to `DcpState`; persist via `saveState(pi)`. Return
  content describing what was compressed (matches DCP's compress-range prompt +
  `RANGE_FORMAT_EXTENSION` at `(repo)/../opencode-dynamic-context-pruning/lib/prompts/extensions/tool.ts`).
- **Tasks:** implement tool + port block-state nesting/active resolution. Provide
  the compress-range prompt text (port `(repo)/../opencode-dynamic-context-pruning/lib/prompts/compress-range.ts`).
- **Accept:** unit test: tool given synthetic branch + ranges writes correct
  blocks with nesting; protected tool outputs appended; returns a clear summary
  string. Manual: model calls `compress`; next `context` call carries summary,
  not the span.

## WP7 — System-prompt injection (`src/system-prompt.ts`)

- **Owner:** `(repo)/src/system-prompt.ts`.
- **Depends on:** WP1.
- **Context you can rely on:** DCP injects its system prompt (port
  `(repo)/../opencode-dynamic-context-pruning/lib/prompts/system.ts` + `extensions/system.ts` protected-tools list)
  into `output.system` in OpenCode. In Pi use
  `pi.on("before_agent_start", …)`: the event can modify the system prompt; or
  append to `ctx.getSystemPrompt()` via the returned result. Confirm the exact
  mutation surface from the Pi `BeforeAgentStartEvent` type at
  `(repo)/node_modules/@earendil-works/pi-coding-agent/dist/` (do not guess).
  Skip injection for internal/summarizer agents (DCP skips by signature — under
  Pi, skip when the system prompt contains compaction/summary signatures, e.g.
  `"Summarize what was done"`).
- **Tasks:** `renderSystemPrompt(config, manualMode): string`; hook that appends
  it once per agent start; include protected-tools list + manual-mode flag.
- **Accept:** after agent start, `ctx.getSystemPrompt()` contains the DCP block;
  compaction-summary agent run does not get it.

## WP8 — Nudges (`src/nudges.ts`)

- **Owner:** `(repo)/src/nudges.ts`.
- **Depends on:** WP1, WP2, WP4 (inject into returned messages).
- **Context you can rely on:** DCP nudge logic at
  `(repo)/../opencode-dynamic-context-pruning/lib/prompts/{context-limit-nudge,turn-nudge,iteration-nudge}.ts`
  + `lib/messages/inject/*`. **Replace** manual token math with
  `ctx.getContextUsage()`: above `compress.maxContextLimit` (number or `"X%"` of
  `contextWindow`) inject strong compress nudges every `nudgeFrequency` calls;
  at/above `minContextLimit` inject turn/iteration reminders past
  `iterationNudgeThreshold` messages since last user message; `nudgeForce`
  strong|soft controls wording. Inject as an ephemeral `UserMessage` or
  `CustomMessage` appended near the head/tail of returned `AgentMessage[]`
  (non-destructive — only in the deep copy).
- **Tasks:** `injectNudges(messages, ctx, state, config): AgentMessage[]`; track
  anchors in `state.nudges` (already in WP2) to avoid duplicates.
- **Accept:** unit tests: high usage → nudge present every N calls; below
  min → none; iteration > threshold → reminder present.

## WP9 — `/dcp` TUI panel + commands (`src/commands/dcp.ts`)

- **Owner:** `(repo)/src/commands/dcp.ts`.
- **Depends on:** WP1, WP2, WP8 (stats/usage), and the opentui skill.
- **Context you can rely on:** Read `(repo)/.agents/skills/opentui/SKILL.md` +
  `docs/` before coding. Build the panel via `ctx.ui.custom((tui, theme, kb,
  done) => { … return { render, invalidate, handleInput } })` (see
  `summarize.ts` example pattern). Subcommands: `stats`, `manual [on|off]`,
  `context`. `manualMode` toggles `state.manualMode`; persist. No-subcommand →
  open panel. Use `ctx.getContextUsage()` for token stats, `DcpState` for prune
  counts + compression blocks.
- **Tasks:** panel showing context usage %, prune token savings, active
  compression blocks (topic, tokens saved, durationMs), manual toggle; keymap
  (Enter/Esc close).
- **Accept:** `pi -e ./src/main.ts`, then `/dcp` opens the panel; `/dcp stats`
  prints stats; `/dcp manual on` enables manual mode and persists.

## WP10 — `/dcp-compress [focus]` command (`src/commands/dcp-compress.ts`)

- **Owner:** `(repo)/src/commands/dcp-compress.ts`.
- **Depends on:** WP6 (compress tool exists), WP1, WP2.
- **Context you can rely on:** DCP's manual trigger (`handleManualTriggerCommand`
  in `(repo)/../opencode-dynamic-context-pruning/lib/commands/index.ts`) sends a prompt asking the model to run
  one compression pass, optionally focused. In Pi: enqueue a user message
  describing the compress task (include the active compress-range instructions
  from WP6). Use `ctx.sendMessage` / `pi.sendMessage` (or
  `ctx.sessionManager`) to deliver a user message that nudges the model to call
  the `compress` tool. Set `state.pendingManualTrigger` then the `context`
  handler ensures the next call carries it (mirror DCP's
  `applyPendingManualTrigger`).
- **Tasks:** command handler; focus text passed through to the prompt.
- **Accept:** `/dcp-compress auth` emits a user message whose content tells the
  model to compress, focused on "auth"; model then calls `compress`.

## WP11 — Integration into `context` handler (`src/main.ts` refine)

- **Owner:** `(repo)/src/main.ts` (the `context` handler body).
- **Depends on:** WP2, WP3, WP4, WP5, WP6, WP8.
- **Context you can rely on:** This is the heart. Order of operations in the
  `context` handler (mirror DCP `createChatMessageTransformHandler`):
  1. `loadState`-ensured (session wisession); `sync` (recompute `toolIdList`,
     `currentTurn` consistency).
  2. recompute strategies: `deduplicate`, `purgeErrors` → prune map.
  3. `prune(messages)` → pruned array.
  4. `injectNudges(messages)`.
  5. return `{ messages }`.
  Also wire `session_start`→load state, `session_shutdown`→save state,
  `tool_*`→WP3, `before_agent_start`→WP7, `registerTool`→WP6,
  `registerCommand`→WP9/WP10. Notify via `ctx.ui.notify` on compression events
  per `config.pruneNotification` (`off|minimal|detailed`, `chat|toast`).
- **Tasks:** assemble the pipeline; error policy: never throw from handlers
  (Pi contract) — on error, `ctx.ui.notify` + return messages unchanged.
- **Accept:** full end-to-end Verification below passes.

---

# Global Verification

1. `aube exec tsgo --noEmit` (or project typecheck) passes; `aube exec biome
   check src` clean.
2. Unit (`aube exec vitest run`): WP1, WP2, WP4, WP5, WP6, WP8 green.
3. Manual: `pi -e ./src/main.ts` loads; `compress` tool present & callable.
4. Compress a span via the model → *next* `context` (trace with a temporary
   `before_provider_request` log hook) carries the summary `CustomMessage` and
   omits the span; session tree raw messages intact.
5. Dedup: same `read` twice → earlier output is placeholder in context, retained
   in session file.
6. Persistence: append a `dcp-state` entry, restart/reload → compression still
   applied on next `context`; branch off → pruning is branch-scoped (not on the
   new branch's earlier entries until recorded there).
7. Nudges: drive context near `maxContextLimit` → compress nudge present; below
   `minContextLimit` → none.
8. `/dcp` panel opens; `/dcp manual on` persists; `/dcp-compress <focus>`
   triggers one compression pass.

# Dependency summary (assign bottom-up, parallelize siblings)

```
WP0 ──► WP1 ─┬─► WP7
            └─► WP2 ─┬─► WP3 ──► WP5
                      ├─► WP4 ──┐
                      └─► WP6 ──┤
                                 ├─► WP8 ──► WP11
                                 ├─► WP9
                                 └─► WP10
```

## Delegation waves (orchestration order)

Topological waves the parent launches in order. Within a wave, items are
independent and may fan out via `runs.all` (workers use `worktree: true`);
waves run sequentially because downstream WPs import upstream services.

| Wave | WPs (owner files are disjoint) | Agents |
|------|-------------------------------|--------|
| 1 | WP0 | scout → worker → reviewer |
| 2 | WP1, WP2 | scout → worker → reviewer (parallel, `worktree:true`) |
| 3 | WP3, WP4, WP7 | scout → worker → reviewer (parallel, `worktree:true`); `oracle` first for WP3 design of `toolCallId` map |
| 4 | WP5, WP6 | scout → `oracle`/worker → reviewer (parallel, `worktree:true`); `oracle` first for WP6 range/nesting identity |
| 5 | WP8 | scout → worker → reviewer |
| 6 | WP9, WP10 | scout → worker → reviewer (parallel, `worktree:true`); `visual` for WP9 TUI acceptance |
| 7 | WP11 (integration) | worker only, after WP1–10 accepted; then the global Verification fanout (fresh reviewers, `runs.all`) |

Wave-7 integration gate: before WP11, run `subagent({ action: "mission.list" })`
to confirm all upstream WPs landed with passing acceptance; WP11 is the single
writer for `src/main.ts` and owns the end-to-end Verification checklist. Any
unapproved Pi-API ambiguity mid-port is escalated: `researcher` for docs,
`oracle` for design, parent decides.