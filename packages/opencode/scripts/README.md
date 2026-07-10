# Scripts

> This document is edited and maintained by Claude (Anthropic) and presented as-is.

Packaging and development tooling for the OpenCode plugin. Nothing here ships in the npm package or release tarball.

## Packaging

- `verify-package.mjs` — CI gate: required files, package.json shape, runtime import hygiene, built entrypoint smoke, and exact npm tarball contents.
- `verify-release.mjs` — release gate: the pushed `v*` tag must match this package's version.
- `smoke-opencode-install.mjs` — installs the package through a real OpenCode binary (`opencode plugin ...`) in a sandbox and asserts the server and TUI plugins load.

## Session analysis (dev tools)

- `opencode_api.py` — shared helpers for reading the local OpenCode storage.
- `opencode-find-session`, `opencode-get-message`, `opencode-session-timeline` — locate and inspect stored sessions and messages.
- `opencode-token-stats`, `opencode-message-token-counts`, `opencode-better-compact-stats` — token usage and pruning statistics over stored sessions.
