# Better Compact

I got tired of watching coding agents hit their context limit and replace hours of careful work with a single lossy summary. Better Compact is my answer: a staged, pruning-first context ladder that preserves raw user intent, prunes old tool-heavy context first, writes transcript references for exact recall, and summarizes old assistant turns only when lighter pruning is not enough.

The ladder is the product. It runs the same stages everywhere:

1. Prune loaded skill context.
2. Prune old tool calls/results while preserving a recent-tool budget.
3. Prune thinking/reasoning, only if still needed.
4. Prune remaining tool calls/results, only if still needed.
5. Summarize high-value old assistant turns, only if still needed.
6. Fall back to a prefix summary as a last resort.

Every step writes raw transcripts to disk and injects a reference message, so the agent can always read back the exact history it lost. Plans are cached, validated with a range hash, replayed deterministically across requests (which keeps provider prompt caches warm), and rebuilt when the context regrows past the trigger.

## Platforms

The ladder lives in a platform-neutral core (`packages/core`) that operates on a canonical message IR; each platform gets a thin codec/adapter around it:

| Platform | Status | How it integrates |
| --- | --- | --- |
| [OpenCode](https://opencode.ai) | Shipping (`packages/opencode`) | In-process message transform plugin |
| pi | Designed (Phase 2) | In-process `context` event extension |
| Claude Code | Designed (Phase 3) | Local proxy on `ANTHROPIC_BASE_URL` |
| Codex | Designed (Phase 4) | Local proxy on `openai_base_url` |

The full design, including the IR, the codec contract, and the proxy engine, lives in [docs/architecture.md](docs/architecture.md).

## Install (OpenCode)

Install the latest GitHub release:

```bash
curl -fsSL https://github.com/AshishKumar4/opencode-better-compact/releases/latest/download/install.sh | sh
```

Install an explicit version:

```bash
VERSION=v0.1.0 curl -fsSL https://github.com/AshishKumar4/opencode-better-compact/releases/latest/download/install.sh | sh
```

The installer downloads the prebuilt release tarball, verifies its checksum, installs it under `~/.local/share/opencode/plugins/better-compact/<version>`, and registers the server and TUI plugins in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`. Restart OpenCode after installation.

The OpenCode plugin's commands, configuration, presets, and uninstall steps are documented in [packages/opencode/README.md](packages/opencode/README.md).

## Development

This is a pnpm workspace:

```
packages/
├── core/        @better-compact/core — the platform-neutral ladder, pure, zero runtime dependencies
└── opencode/    better-compact — the OpenCode plugin (hooks, codec, TUI, commands, state)
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
  "plugin": ["file:///path/to/opencode-better-compact/packages/opencode/index.ts"]
}
```

And for the TUI plugin, in `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["file:///path/to/opencode-better-compact/packages/opencode/tui.tsx"]
}
```

## Releases

CI verifies every push/PR with typecheck, tests, build, and package verification. Tagging `v*` builds the compiled artifacts, packages `better-compact.tar.gz` with `checksums.txt`, and uploads them with `install.sh` to GitHub Releases.

## Upstream

Better Compact is forked from [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), originally published as `@tarquinen/opencode-dcp` by tarquinen and contributors.

This fork keeps the upstream AGPL-3.0-or-later license and builds on the original plugin architecture while changing the product direction to boundary-time context pruning and Better Compact branding.

## License

AGPL-3.0-or-later
