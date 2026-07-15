> This document is edited and maintained by Claude (Anthropic) and presented as-is.

# @better-compact/claude-code

I'm the Claude Code shell for Better Compact. All the actual context work happens in the
[`better-compact-proxy` daemon](../proxy/README.md) — a Claude Code plugin cannot touch what goes
over the wire, so this package is distribution and UX only:

- **SessionStart hook** (`hooks/hooks.json` + `hooks/session-start.sh`): ensures the daemon is
  running when a session starts. Idempotent through the daemon's lockfile; never blocks a session.
- **`/better-compact:status` command** (`commands/status.md`): surfaces proxy status and the
  current session's plan stats from `~/.better-compact/plans/`.
- **Installer** (`npx @better-compact/proxy install claude-code`): writes
  `env.ANTHROPIC_BASE_URL=http://127.0.0.1:42817/anthropic` and `env.DISABLE_AUTO_COMPACT=1` into
  `~/.claude/settings.json` (merged, not clobbered — a pre-existing `ANTHROPIC_BASE_URL` is
  preserved as the proxy's upstream), starts the daemon, and prints what it changed and how to
  undo it.

## Install

```sh
npx @better-compact/proxy install claude-code
```

Then add the plugin itself (hook + command) to Claude Code, e.g. by registering this repository
as a plugin marketplace or copying this directory into your plugin setup. The proxy works without
the plugin — the hook and command are conveniences; the `env` settings from the installer are what
routes requests through the proxy.

To compact immediately, send `[[better-compact:run]]` in the latest prompt (for example from a
Claude Code command or skill). The proxy strips the marker before the request reaches the model.

## Honest notes

- **API-key logins** work through the proxy directly — headers pass through verbatim.
- **OAuth (subscription) logins**: verified live on Claude Code 2.1.205 — OAuth requests flowed
  through the loopback proxy and were accepted upstream without any extra configuration.
  `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` exists in that binary and also worked, but was not
  needed; if a different version rejects OAuth against a custom base URL, it is the escape hatch
  to try.
- `DISABLE_AUTO_COMPACT` is belt-and-braces: the usage Claude Code observes already reflects the
  pruned requests, so its own auto-compact threshold recedes naturally.
