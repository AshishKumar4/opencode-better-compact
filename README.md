# Better Compact

I got tired of watching coding agents hit their context limit and replace hours of careful work with a single lossy summary. Better Compact is my answer: a staged, pruning-first context ladder that preserves raw user intent, prunes old tool-heavy context first, writes transcript references for exact recall, and summarizes old assistant turns only when lighter pruning is not enough.

The ladder is the product. Each platform declares its own ordered stage array — the same stages in the same order, minus the ones that platform has no concept of (skill and todo preservation exist only where the platform has skills/todos: OpenCode and Claude Code have both; pi has neither):

1. Prune loaded skill context. _(skill-aware platforms only)_
2. Supersede repeated reads of the same target and purge stale failed-tool inputs.
3. Prune old tool calls/results while preserving a recent-tool budget — pruned tools leave one-line stubs (tool, target, status; error strings verbatim), so the action record survives.
4. Prune thinking/reasoning, only if still needed.
5. Prune remaining tool calls/results, only if still needed.
6. Summarize high-value old assistant turns, only if still needed.
7. Fall back to a rolling prefix summary as a last resort.

Todo state, where a platform exposes it in-band, is preserved through the tool-pruning stages so the model never loses its task list.

Every step writes raw transcripts to disk and injects a reference message, so the agent can always read back the exact history it lost. Plans are cached, validated with a range hash, replayed deterministically across requests (which keeps provider prompt caches warm), and rebuilt when the context regrows past the trigger.

## Platforms

The ladder lives in a platform-neutral core (`packages/core`) that operates on a canonical message IR; each platform gets a thin codec/adapter around it:

| Platform                        | Status                                               | How it integrates                    |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| [OpenCode](https://opencode.ai) | Shipping (`packages/opencode`)                       | In-process message transform plugin  |
| pi                              | Shipping (`packages/pi`)                             | In-process `context` event extension |
| Claude Code                     | Shipping (`packages/cli` + `packages/claude-code`) | On-disk session compaction (`better-compact claude`) |

Claude Code enforces its context ceiling client-side and seeds its meter from token counts
recorded inside the session transcript, so nothing on the wire can manage it; Better Compact
compacts the transcript on disk instead (`better-compact claude`) — pruning in place while keeping
every message, and resetting the stale accounting so the meter reflects reality (`--aggressive`
reproduces Claude Code's own summarize-and-sever compaction when stubbing alone is not enough).
The full design, including the IR and the codec contract, lives in
[docs/architecture.md](docs/architecture.md).

## Install

### OpenCode

Requires OpenCode 1.17.13 or a newer 1.x release. Install globally with OpenCode's built-in plugin manager:

```bash
opencode plugin better-compact --global
```

OpenCode downloads the prebuilt npm package with its embedded package manager and registers the server and TUI plugins in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json` (JSONC equivalents are preserved). Restart OpenCode after installation. Commands, configuration, presets, and uninstall steps: [packages/opencode/README.md](packages/opencode/README.md).

Two OpenCode package-cache behaviors worth knowing (verified against OpenCode 1.17.13 source):
its cache never re-resolves an installed package — a bare install stays on whatever version it
first fetched, and a partially failed first install is reused forever without any error in the
logs (TUI plugin load errors appear only in the in-app console overlay). If the plugin seems
absent or stale — no `/better-compact` in autocomplete, no progress UI — reset the cache and
restart:

```bash
rm -rf ~/.cache/opencode/packages/better-compact*
```

To upgrade deliberately, prefer a pinned install (`opencode plugin better-compact@0.2.2 --global`),
which gets a fresh per-version cache directory.

### Claude Code

```bash
npm install -g @better-compact/cli
better-compact claude <sessionId> --resume   # compact a closed session and reopen it
```

The default keeps every message — old tool inputs/outputs become short stubs, old reasoning is
dropped, the recent tail stays verbatim — and clears the stale token accounting Claude Code's
context meter is seeded from. For the in-session `/better-compact:compact` command and the
`better-compact claude --run` auto-reopen launcher, add the plugin:

```bash
claude plugin marketplace add AshishKumar4/better-compact
claude plugin install better-compact@better-compact
```

Details and flags (`--aggressive`, `--from-backup`, `--keep-tokens`): [packages/cli/README.md](packages/cli/README.md) and [packages/claude-code/README.md](packages/claude-code/README.md).

### pi

Not yet on npm — build from source (`pnpm build` in `packages/pi`, then drop `dist/extension.js`
into `~/.pi/agent/extensions`). Details: [packages/pi/README.md](packages/pi/README.md).

## Development

This is a pnpm workspace:

```
packages/
├── core/         @better-compact/core — the platform-neutral ladder, pure, zero runtime dependencies
├── opencode/     better-compact — the OpenCode plugin (hooks, codec, TUI, commands, state)
├── pi/           @better-compact/pi — the pi extension (codec, plan store, summarizer)
├── cli/          @better-compact/cli — the better-compact CLI (Claude Code on-disk session compaction)
└── claude-code/  @better-compact/claude-code — the Claude Code plugin (/better-compact:compact command)
```

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run check:package
```

Tests include a golden pre/post harness (`packages/opencode/tests/golden-boundary.test.ts`) that pins the exact transform outputs as JSON fixtures; regenerate deliberately with `GOLDEN_UPDATE=1` only when a behavior change is intentional.

For local development, point OpenCode at this checkout:

```json
{
    "plugin": ["file:///path/to/better-compact/packages/opencode/index.ts"]
}
```

And for the TUI plugin, in `~/.config/opencode/tui.json`:

```json
{
    "plugin": ["file:///path/to/better-compact/packages/opencode/tui.tsx"]
}
```

## Releases

Published packages: [`better-compact`](https://www.npmjs.com/package/better-compact) (OpenCode plugin), [`@better-compact/cli`](https://www.npmjs.com/package/@better-compact/cli) (Claude Code on-disk compaction), and [`@better-compact/core`](https://www.npmjs.com/package/@better-compact/core) (the ladder, for embedding in other harnesses).

CI verifies every push/PR with typecheck, tests (including the Bun-hosted TUI suite), build, package verification, and an OpenCode plugin-manager install smoke test. Three tag-driven release pipelines publish to npm with provenance: `v*` (OpenCode plugin — verifies the tag against the package version, packs a deterministic tarball, smoke-installs it through real OpenCode versions, and creates the GitHub Release), `cli-v*` (the CLI), and `core-v*` (the core). The release runbook lives in [RELEASING.md](RELEASING.md).

## Upstream

Better Compact is forked from [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), originally published as `@tarquinen/opencode-dcp` by tarquinen and contributors.

This fork keeps the upstream AGPL-3.0-or-later license and builds on the original plugin architecture while changing the product direction to boundary-time context pruning and Better Compact branding.

## License

AGPL-3.0-or-later
