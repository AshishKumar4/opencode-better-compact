# Better Compact

I got tired of watching coding agents hit their context limit and replace hours of careful work with a single lossy summary. Better Compact is my answer: a staged, pruning-first context ladder that preserves raw user intent, prunes old tool-heavy context first, writes transcript references for exact recall, and summarizes old assistant turns only when lighter pruning is not enough.

The ladder is the product. Each platform declares its own ordered stage array — the same stages in the same order, minus the ones that platform has no concept of (skill and todo preservation exist only where the platform has skills/todos: OpenCode and Claude Code have both; pi and Codex have neither):

1. Prune loaded skill context. _(skill-aware platforms only)_
2. Prune old tool calls/results while preserving a recent-tool budget.
3. Prune thinking/reasoning, only if still needed.
4. Prune remaining tool calls/results, only if still needed.
5. Summarize high-value old assistant turns, only if still needed.
6. Fall back to a prefix summary as a last resort.

Todo state, where a platform exposes it in-band, is preserved through the tool-pruning stages so the model never loses its task list.

Every step writes raw transcripts to disk and injects a reference message, so the agent can always read back the exact history it lost. Plans are cached, validated with a range hash, replayed deterministically across requests (which keeps provider prompt caches warm), and rebuilt when the context regrows past the trigger.

## Platforms

The ladder lives in a platform-neutral core (`packages/core`) that operates on a canonical message IR; each platform gets a thin codec/adapter around it:

| Platform                        | Status                                               | How it integrates                    |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| [OpenCode](https://opencode.ai) | Shipping (`packages/opencode`)                       | In-process message transform plugin  |
| pi                              | Shipping (`packages/pi`)                             | In-process `context` event extension |
| Claude Code                     | Shipping (`packages/cli` + `packages/claude-code`) | Local proxy on `ANTHROPIC_BASE_URL`  |
| Codex                           | Shipping (`packages/cli`)                          | Local proxy on `openai_base_url`     |

The full design, including the IR, the codec contract, and the proxy engine, lives in [docs/architecture.md](docs/architecture.md).

## Install (OpenCode)

Requires OpenCode 1.17.13 or a newer 1.x release. Install globally with OpenCode's built-in plugin manager:

```bash
opencode plugin better-compact --global
```

OpenCode downloads the prebuilt npm package with its embedded package manager and registers the server and TUI plugins in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json` (JSONC equivalents are preserved). Restart OpenCode after installation.

The OpenCode plugin's commands, configuration, presets, and uninstall steps are documented in [packages/opencode/README.md](packages/opencode/README.md).

## Development

This is a pnpm workspace:

```
packages/
├── core/         @better-compact/core — the platform-neutral ladder, pure, zero runtime dependencies
├── opencode/     better-compact — the OpenCode plugin (hooks, codec, TUI, commands, state)
├── pi/           @better-compact/pi — the pi extension (codec, plan store, summarizer)
├── proxy/        @better-compact/cli — the better-compact daemon (Anthropic + OpenAI Responses codecs, Codex installer)
└── claude-code/  @better-compact/claude-code — the Claude Code plugin shell over the proxy
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

CI verifies every push/PR with typecheck, tests (including the Bun-hosted TUI suite), build, package verification, and an OpenCode plugin-manager install smoke test. Tagging `v*` verifies the tag against the package version, packs a deterministic npm tarball, smoke-installs it through OpenCode, publishes it to npm with provenance, and creates the GitHub Release.

## Upstream

Better Compact is forked from [Opencode-DCP/opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning), originally published as `@tarquinen/opencode-dcp` by tarquinen and contributors.

This fork keeps the upstream AGPL-3.0-or-later license and builds on the original plugin architecture while changing the product direction to boundary-time context pruning and Better Compact branding.

## License

AGPL-3.0-or-later
