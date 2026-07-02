# Better Compact

OpenCode plugin that improves long-session context with runtime-owned, pruning-first context management.

Better Compact keeps long-running OpenCode sessions useful with staged context pruning, raw user-message preservation, assistant-turn summaries, and transcript references for exact recall.

## Upstream

Better Compact is forked from [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), originally published as `@tarquinen/opencode-dcp` by tarquinen and contributors.

This fork keeps the upstream AGPL-3.0-or-later license and builds on the original plugin architecture while changing the product direction to boundary-time context pruning and Better Compact branding.

## Installation

For local development, point OpenCode at this checkout:

```json
{
  "plugin": ["file:///path/to/opencode-better-compact/index.ts"]
}
```

For the TUI plugin, add this to `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["file:///path/to/opencode-better-compact/tui.tsx"]
}
```

Restart OpenCode after changing plugin config.

## How It Works

Better Compact applies a pruning-first context plan instead of OpenCode native compaction.

- Triggers around 85% context usage.
- Preserves raw user messages before summarizing anything else.
- Preserves the latest user turns and recent tail verbatim.
- Prunes reasoning, loaded skill context, old tool calls/results, and old todo churn first.
- Summarizes old contiguous assistant turns when deterministic pruning is not enough.
- Writes raw transcript references under `.opencode/better-compact/sessions/...` so exact prior details remain recoverable.
- Uses last-resort prefix summary only when lighter stages still leave context too large.

## Commands

- `/better-compact` runs Better Compact pruning immediately and reports each stage.
- `/better-compact-settings` opens the Better Compact TUI panel.

## Configuration

Better Compact searches config files in this order:

1. `~/.config/opencode/better-compact.jsonc` or `better-compact.json`
2. `$OPENCODE_CONFIG_DIR/better-compact.jsonc` or `better-compact.json`
3. `.opencode/better-compact.jsonc` or `better-compact.json`

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/AshishKumar4/opencode-better-compact/main/better-compact.schema.json",
  "enabled": true,
  "autoUpdate": false,
  "debug": false
}
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

AGPL-3.0-or-later
