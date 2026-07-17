# @better-compact/claude-code

The Claude Code plugin for Better Compact. Claude Code enforces its context ceiling
**client-side** — it refuses to send once the transcript is too large — so a wire proxy
can't help. What controls the ceiling is the session transcript on disk, which Claude Code
re-derives context from on resume. Better Compact compacts that transcript directly (via the
`better-compact` CLI); this plugin is the in-session UX for it.

- **`/better-compact:compact` command** (`commands/compact.md`): flags the current session for
  compaction and tells you to exit. On exit, `better-compact claude --run` prunes old tool output
  and reasoning — **keeping every message** — and reopens the session automatically. Without the
  launcher it prints the one-shot `better-compact claude <id> --resume`.

## Setup

1. Install the CLI (provides the `better-compact` command):

   ```sh
   npm install -g @better-compact/cli
   ```

2. Add this plugin to Claude Code (register the repository as a plugin marketplace, or copy this
   directory into your plugin setup) to get the `/better-compact:compact` command.

3. If you previously pointed Claude Code at the proxy, undo it:

   ```sh
   better-compact install claude-code
   ```

   This removes the `env.ANTHROPIC_BASE_URL` redirect and re-enables native auto-compaction. The
   proxy could never manage Claude Code's ceiling, and `DISABLE_AUTO_COMPACT` removed its safety
   net — on-disk compaction replaces both.

## Usage

Launch Claude Code through the wrapper so compaction can reopen the session:

```sh
better-compact claude --run          # or: better-compact claude --run --resume <id>
```

When a long session gets heavy, run `/better-compact:compact` and press Ctrl-D. Better Compact
prunes old tool output and reasoning (keeping the whole conversation), then reopens the session.

Any time, from a session's project directory with the session closed:

```sh
better-compact claude <sessionId> --resume        # prune + reopen
better-compact claude <sessionId> --aggressive    # summarize old turns (last resort; drops them from view)
better-compact claude <sessionId> --from-backup   # restore full history, then compact
```

The full transcript is always backed up to `~/.better-compact/claude-backups/` before any change.
