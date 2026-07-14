# Better Compact

OpenCode plugin that keeps long-running sessions usable with staged, pruning-first context management.

Better Compact preserves raw user intent, prunes old tool-heavy context first, writes transcript references for exact recall, and summarizes old assistant turns only when lighter pruning is not enough.

## Install

Requires OpenCode 1.17.13 or a newer 1.x release. Install globally with OpenCode's built-in plugin manager:

```bash
opencode plugin better-compact --global
```

Install an explicit version:

```bash
opencode plugin better-compact@0.1.5 --global
```

OpenCode downloads the prebuilt package with its embedded package manager and updates both plugin configurations:

```text
~/.config/opencode/opencode.json
~/.config/opencode/tui.json
```

OpenCode also preserves and updates existing `opencode.jsonc` and `tui.jsonc` files.

No separate Node.js, Bun, pnpm, npm, curl, or tar installation is required.

Restart OpenCode after installation.

## Commands

- `/better-compact` runs staged pruning immediately.
- `/better-compact context` shows the token-usage breakdown for the current session.
- `/better-compact stats` shows the active pruning plan for the current session.
- `/better-compact help` lists the available commands.
- `/better-compact-settings` opens global compaction and summary-effort settings.

## How It Works

Better Compact applies a virtual context plan to OpenCode's outgoing model request. It does not rewrite OpenCode's durable session history.

Default light mode:

- Prunes loaded skill context.
- Prunes old tool calls/results while preserving recent tool context.
- Prunes thinking/reasoning only if needed.
- Prunes remaining tool calls/results only if needed.
- Summarizes high-value old assistant turns only if needed.
- Writes raw transcripts under `.opencode/better-compact/sessions/...` for exact recall (private file modes, gitignored).

The TUI shows live progress, context-window bars, stages completed, and final savings.

OpenCode does not expose provider error bodies or retry control to in-process plugins, so Better
Compact cannot reactively retry an overflow there. Proactive threshold triggering is the primary
protection; the standalone proxy adds one forced-compaction retry as a backstop.

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
        "automatic": true,
        "preset": "light",
        "summaryEffort": "inherit",
    },
}
```

Compaction strength:

- **Gentle** (`light`): waits longer and preserves more recent tool output.
- **Balanced** (`moderate`): compacts earlier and keeps a moderate recent tool window.
- **Aggressive** (`max`): frees the most working room and keeps less old tool output verbatim.
- **Custom**: choose the automatic trigger, deep-summary goal, and recent tool-output budget.

Summary effort is configured separately. `inherit` uses the model default. Low, medium, high, and max are applied only when the active model advertises a matching variant; unsupported levels safely fall back to the model default.

The settings panel saves global behavior to `~/.config/opencode/better-compact.jsonc`, preserving comments and unrelated settings. Changes apply to subsequent manual and automatic runs without restarting OpenCode.

## Uninstall

Remove `better-compact` from the `plugin` arrays in the JSON or JSONC equivalents of:

```text
~/.config/opencode/opencode.json
~/.config/opencode/tui.json
```

Restart OpenCode.

## Development

This package is the OpenCode adapter in the Better Compact pnpm workspace; the platform-neutral pruning ladder lives in `@better-compact/core` and is bundled into the published artifacts. From the repository root:

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
- host-shaped OpenTUI visual/runtime tests under Bun
- production build
- package verification

Tag releases as `v*`:

```bash
git tag v0.1.5
git push origin v0.1.5
```

The release workflow verifies that the tag matches this package's version, builds and tests the compiled server and TUI artifacts, publishes the package to npm with provenance, and creates the GitHub Release.

## Upstream

Better Compact is forked from [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), originally published as `@tarquinen/opencode-dcp` by tarquinen and contributors.

This fork keeps the upstream AGPL-3.0-or-later license and builds on the original plugin architecture while changing the product direction to boundary-time context pruning and Better Compact branding.

## License

AGPL-3.0-or-later
