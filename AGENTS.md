# AGENTS.md

`pi-dcp` is a **new package** — an exact port of the `@tarquinen/opencode-dcp` OpenCode plugin (source lives in the parent repo, `../index.ts` + `../lib/**`) to a **Pi extension**. It is not a wrapper: logic is rewritten to operate directly on Pi's `AgentMessage[]`.

- **`../PLAN.md` is the spec** — read it first. It has the verified Pi API facts, the OpenCode-hook → Pi-event mapping table, the file-by-file plan, and the stable-identity design.
- `src/main.ts` is currently empty; the port is not yet scaffolded. `package.json` still has a placeholder `test` script and no `pi.extensions` field.

## Toolchain (differs from the parent repo — do not mix)

- Package manager: **`aube`**, not npm/pnpm (lockfile `aube-lock.yaml`). It is pinned/activated via **`mise`** (`mise.toml` → `aube = "latest"`). Use `aube install`, `aube add <dep>`, `aube run <script>`, `aube test`.
- Formatter/linter: **`biome`**, not Prettier (`biome.json`: 2-space indent, double quotes, no semicolons, no trailing commas, lineWidth 120). Run `aube exec biome check src` / `aube exec biome format src`.
- TypeScript 7 via `@effect/tsgo` + `@effect/language-service`; runtime dep `effect@^4.0.0-rc.108`.
- Before writing any Effect code, read `node_modules/effect/AGENTS.md` (see `.agents/skills/effect-ts/SKILL.md`).

## Load-bearing Pi facts (from PLAN.md)

- `pi.on("context", handler)` fires before every LLM call; returns `{ messages: AgentMessage[] }` to replace a deep copy. Non-destructive — the session tree is untouched.
- Prune/dedup/purge maps are keyed by stable `toolCallId` (`ToolResultMessage.toolCallId`); compression blocks are keyed by stable branch **entry ids** (`ctx.sessionManager.getBranch()` → 8-char hex ids).
- `ctx.getContextUsage()` replaces manual token counting for nudge thresholds.
- Persist state via `pi.appendEntry("dcp-state", …)` (survives `/reload`, branch-aware); inject LLM-visible summaries/nudges by returning modified `AgentMessage[]` from the `context` handler.
- Config cascade (pi-specific, not the parent's `dcp.jsonc` paths): `~/.pi/agent/dcp.json` > `.pi/dcp.json`.

## Local skills

`.agents/skills/` bundles `effect` and `opentui` (Solid/React terminal-UI bindings) — relevant when building the `/dcp` TUI panel via `ctx.ui.custom`.
