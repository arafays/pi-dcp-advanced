# AGENTS.md

`pi-dcp` is a Pi extension: an exact port of the OpenCode plugin `@tarquinen/opencode-dcp` rewritten to operate directly on Pi's `AgentMessage[]` (not a wrapper). Entry point is `src/main.ts` (a Pi `ExtensionFactory`, `export default async function (pi)`), wired via `"pi": { "extensions": ["./src/main.ts"] }` in `package.json`.

The upstream source it ports lives one level up at `../opencode-dynamic-context-pruning` (`index.ts` + `lib/**`); read it directly by path. Do NOT port the parent's toolchain (npm/tsup/prettier) — this repo uses aube/biome/tsgo.

## Toolchain

- Package manager is `aube` (not npm/pnpm/yarn; lockfile `aube-lock.yaml`), activated via `mise` (`mise.toml` → `aube = "latest"`). Run project binaries with `aube exec <bin>` (alias `aube x`).
- Runtime is Effect v4 (`effect@^4.0.0-rc.108`); tests use `@effect/vitest` (pinned `4.0.0-rc.108`).

Verified commands:

- `aube test` — runs the `test` script (`aube exec vitest run`; 14 files, 125 tests). Single file: `aube exec vitest run src/core/state.test.ts`; single test: append `-t "name"`.
- `aube exec tsc --noEmit` — typecheck (`typescript@^7.0.2` = the native Go compiler, patched with the Effect LSP, so it also emits Effect suggestions).
- `aube exec effect-tsgo diagnostics --project tsconfig.json` — dedicated Effect LSP diagnostics pass (also `--file`, `--format json|text|pretty|github-actions`).
- `aube exec biome check src` — lint+format; `aube exec biome format src --write` to autofix.

tsgo / Effect LSP (`@effect/tsgo`):

- `@effect/tsgo` is a superset of native `tsgo` with the Effect language service built in. `typescript@7` (native) is required alongside it; both are devDeps. `prepare` (`aube exec effect-tsgo patch`) patches the native `tsc` binary so `tsc --noEmit` emits Effect diagnostics (idempotent — skips if already patched; `effect-tsgo unpatch` reverts). The `tsconfig.json` `plugins: [{ "name": "@effect/language-service" }]` entry activates the LSP (the plugin name stays `@effect/language-service` even though the package is `@effect/tsgo`).
- Do NOT use `effect-tsgo --noEmit` — the `effect-tsgo`/`tsgo` binary is the Effect language-service CLI (subcommands `patch`/`unpatch`/`diagnostics`/`setup`/`config`/`get-exe-path`), not a drop-in `tsc`. Typecheck with `tsc`.
- Effect diagnostics surface as `suggestion` severity by default (`ignoreEffectSuggestionsInTscExitCode: true`), so `tsc --noEmit` still exits 0.

Gotchas:

- `biome.json` style differs from TS defaults: 2-space indent, double quotes, NO semicolons, no trailing commas, lineWidth 120.
- `tsconfig.json` is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `module: nodenext`. Relative imports must use `.js` extensions; type-only imports must use `import type`.

## Differential tests (do not "fix" them)

`*.diff.test.ts` files import the REAL upstream source directly, e.g. `import ... from "../../../opencode-dynamic-context-pruning/lib/compress/state.ts"` — extensionless `.ts` imports that vitest/esbuild resolves but tsgo/nodenext rejects. They are runtime-only: `tsconfig.json` excludes `src/**/*.diff.test.ts` from typecheck. They assert structural parity between the port and upstream. Keep those imports as-is.

## Architecture

- `src/main.ts` — the extension factory. Registers event hooks (`session_start`, `session_shutdown`, `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_end`, `before_agent_start`, `context`) + the `compress` tool + `/dcp` and `/dcp-compress` commands. Handlers NEVER throw — on error they notify (when a UI exists) and return unchanged results.
- `src/core/` — config, state, tracking, prune, message-ids, nudges, system-prompt.
- `src/strategies/` — `deduplicate` + `purgeErrors` (mark-then-apply: write pruned tool-call ids into `state.prune.tools`; pure, mutate `state` in place).
- `src/compress/` — the `compress` range tool.
- `src/commands/` — `dcp-tui` (`/dcp` panel) and `dcp-command` (`/dcp-compress` trigger).

Config cascade: `~/.pi/agent/dcp.json` (global) > `.pi/dcp.json` (project), deep-merged over defaults; missing files fall back to defaults (see `src/core/config.ts`). `.pi/` is gitignored.

Durable state (prune map, nudges, stats, manualMode) persists via `pi.appendEntry("dcp-state", …)` (see `src/core/state.ts` `saveState`/`loadState`); custom entries do NOT enter LLM context. LLM-visible content is injected by returning modified `AgentMessage[]` from the `context` handler.

## Skills

`.agents/skills/` (and `.claude/skills/`) bundle `effect` (Effect v4 patterns) and `opentui` (terminal-UI bindings). Read `node_modules/effect/AGENTS.md` and `.agents/skills/effect/SKILL.md` before writing Effect code.
