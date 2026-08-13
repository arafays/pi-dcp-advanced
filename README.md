# pi-dcp — Dynamic Context Pruning for Pi

Native Dynamic Context Pruning (DCP) for [Pi](https://pi.dev)'s `AgentMessage[]` context. DCP keeps the agent's context window sharp by deduplicating redundant tool output, purging error noise, pruning superseded file writes, and compressing closed conversation ranges into dense summaries — automatically, every turn, before each LLM call.

## How it works

DCP runs as a Pi extension. Its `context` handler inspects the message list on every turn and applies a `mark-then-apply` prune pipeline:

1. **Strategies** mark messages for pruning:
   - `deduplication` — drops repeated tool results and near-duplicate tool calls.
   - `purgeErrors` — removes failed tool calls and their error output (older than `turns` turns).
   - `supersededWrites` — removes stale `write`/`edit` results superseded by a later write to the same file.
2. **Message ids** — assigns `mNNNN` reference ids to user/assistant/toolResult messages so the model can target compression boundaries precisely.
3. **Compression** — the `compress` tool (exposed to the model) replaces a closed `[startId, endId]` range with an exhaustive technical summary. This is crystallization, not cleanup: the summary becomes the authoritative record.
4. **Nudges** — injects context-limit / turn / iteration reminders when the context grows near limits.
5. **State persistence** — the prune map, nudge state, and stats survive restarts via `pi.appendEntry("dcp-state", …)` (custom entries never enter LLM context).

A range-mode port of Claude Code's DCP, running natively on Pi's event system.

## Install

Pi packages run with full system access — review the source before installing.

```bash
# From git (pinned ref recommended)
pi install git:github.com/arafays/pi-dcp-advanced@v1.0.0

# Or a raw URL / SSH
pi install https://github.com/arafays/pi-dcp-advanced@v1.0.0
pi install ssh://git@github.com/arafays/pi-dcp-advanced@v1.0.0
```

Manage with `pi list` / `pi remove` / `pi update --extensions`. Try it without installing: `pi -e git:github.com/arafays/pi-dcp-advanced`.

## Commands

| Command | Description |
|---------|-------------|
| `/dcp` | TUI panel: view stats, toggle strategies and manual mode. |
| `/dcp-compress` | Trigger one compression pass on demand. |
| `/system-prompt` | Full-screen overlay of the current system prompt + tool definitions (`c` copies, `Esc`/`q` closes). |

## Configuration

Config resolves from a deep-merged cascade: `~/.pi/agent/dcp.json` (global) → `.pi/dcp.json` (project) → defaults. Missing files fall back to defaults.

```json
{
  "enabled": true,
  "debug": false,
  "pruneNotification": "detailed",
  "pruneNotificationType": "chat",
  "commands": { "enabled": true, "protectedTools": ["task", "skill", "todowrite", "todoread", "compress", "batch", "plan_enter", "plan_exit", "write", "edit"] },
  "manualMode": { "enabled": false, "automaticStrategies": true },
  "turnProtection": { "enabled": false, "turns": 4 },
  "protectedFilePatterns": [],
  "compress": {
    "mode": "range",
    "permission": "allow",
    "showCompression": false,
    "summaryBuffer": true,
    "maxContextLimit": 100000,
    "minContextLimit": 50000,
    "nudgeFrequency": 5,
    "iterationNudgeThreshold": 15,
    "nudgeForce": "soft",
    "protectedTools": ["task", "skill", "todowrite", "todoread"]
  },
  "strategies": {
    "deduplication": { "enabled": true, "protectedTools": [] },
    "purgeErrors": { "enabled": true, "turns": 4, "protectedTools": [] },
    "supersededWrites": { "enabled": true, "protectedTools": [] }
  }
}
```

Key fields:
- `compress.permission` — `"ask"` (prompt before each compression), `"allow"`, or `"deny"`.
- `compress.maxContextLimit` / `minContextLimit` — absolute token counts or a `"X%"` fraction of the model context window; controls compression and nudge behavior.
- `manualMode.enabled` — when `true`, strategies only run when the model explicitly requests them.

## Development

Package manager is [`aube`](https://github.com/aube/aube) (activated via `mise`), runtime is [Effect v4](https://effect.website).

```bash
mise install        # activates aube
aube install        # install deps
aube test           # vitest (11 files, 130 tests)
aube exec tsc --noEmit   # typecheck
aube exec biome check src   # lint + format
```

## License

[MIT](./LICENSE)
