# Scripts

> This document is edited and maintained by Claude (Anthropic) and presented as-is.

Packaging and development tooling for the OpenCode plugin. Nothing here ships in the npm package or release tarball.

## Packaging

- `install.sh` — the end-user installer uploaded with each GitHub release; downloads the tarball, verifies its checksum, installs under `~/.local/share/opencode/plugins/better-compact/`, and registers the plugin entry points.
- `package-release.mjs` — stages the release tarball (`.release/better-compact.tar.gz`) with its manifest and checksum.
- `verify-package.mjs` — CI gate: required files, package.json shape, runtime import hygiene, and tarball contents.

## Session analysis (dev tools)

- `opencode_api.py` — shared helpers for reading the local OpenCode storage.
- `opencode-find-session`, `opencode-get-message`, `opencode-session-timeline` — locate and inspect stored sessions and messages.
- `opencode-token-stats`, `opencode-message-token-counts`, `opencode-better-compact-stats` — token usage and pruning statistics over stored sessions.
