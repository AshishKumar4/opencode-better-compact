# Better Compact

OpenCode plugin that keeps long-running sessions usable with staged, pruning-first context management.

Better Compact preserves raw user intent, prunes old tool-heavy context first, writes transcript references for exact recall, and summarizes old assistant turns only when lighter pruning is not enough.

## Install

Install the latest GitHub release:

```bash
curl -fsSL https://github.com/AshishKumar4/opencode-better-compact/releases/latest/download/install.sh | sh
```

Install an explicit version:

```bash
VERSION=v0.1.0 curl -fsSL https://github.com/AshishKumar4/opencode-better-compact/releases/latest/download/install.sh | sh
```

The installer downloads the prebuilt release tarball, verifies its checksum when `sha256sum` or `shasum` is available, installs it under:

```text
~/.local/share/opencode/plugins/better-compact/<version>
```

Then it updates:

```text
~/.config/opencode/opencode.json
~/.config/opencode/tui.json
```

Restart OpenCode after installation.

## Commands

- `/better-compact` runs staged pruning immediately.
- `/better-compact context` shows the token-usage breakdown for the current session.
- `/better-compact stats` shows the active pruning plan for the current session.
- `/better-compact help` lists the available commands.
- `/better-compact-settings` opens the TUI panel for presets and custom thresholds.

## How It Works

Better Compact applies a virtual context plan to OpenCode's outgoing model request. It does not rewrite OpenCode's durable session history.

Default light mode:

- Prunes loaded skill context.
- Prunes old tool calls/results while preserving recent tool context.
- Prunes thinking/reasoning only if needed.
- Prunes remaining tool calls/results only if needed.
- Summarizes high-value old assistant turns only if needed.
- Writes raw transcripts under `.opencode/better-compact/sessions/...` for exact recall.

The TUI shows live progress, context-window bars, stages completed, and final savings.

## Configuration

Better Compact searches config files in this order:

1. `~/.config/opencode/better-compact.jsonc` or `better-compact.json`
2. `$OPENCODE_CONFIG_DIR/better-compact.jsonc` or `better-compact.json`
3. `.opencode/better-compact.jsonc` or `better-compact.json`

Example:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/AshishKumar4/opencode-better-compact/master/packages/opencode/better-compact.schema.json",
  "enabled": true,
  "autoUpdate": false,
  "debug": false,
  "compaction": {
    "preset": "light"
  }
}
```

Presets:

- `light`: default, preserves more recent tool context.
- `moderate`: stronger pruning and more parallel summarization.
- `max`: aggressive pruning for heavily saturated sessions.
- `custom`: use `/better-compact-settings` to dial trigger, target, recent tool budget, and parallel jobs.

## Uninstall

Remove Better Compact entries from:

```text
~/.config/opencode/opencode.json
~/.config/opencode/tui.json
```

Then remove installed files:

```bash
rm -rf ~/.local/share/opencode/plugins/better-compact
```

Restart OpenCode.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

For local development, point OpenCode at this checkout:

```json
{
  "plugin": ["file:///path/to/opencode-better-compact/packages/opencode/index.ts"]
}
```

For the TUI plugin, add this to `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["file:///path/to/opencode-better-compact/packages/opencode/tui.tsx"]
}
```

Restart OpenCode after changing plugin config.

## Releases

CI uses pnpm and verifies every push/PR with:

- typecheck
- tests
- production build
- package verification

Tag releases as `v*`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds compiled server and TUI artifacts, packages `better-compact.tar.gz`, writes `checksums.txt`, and uploads both with `install.sh` to GitHub Releases.

## Upstream

Better Compact is forked from [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), originally published as `@tarquinen/opencode-dcp` by tarquinen and contributors.

This fork keeps the upstream AGPL-3.0-or-later license and builds on the original plugin architecture while changing the product direction to boundary-time context pruning and Better Compact branding.

## License

AGPL-3.0-or-later
