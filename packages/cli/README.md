# @better-compact/cli

On-disk context compaction for Claude Code sessions. Claude Code enforces its context ceiling
client-side and anchors its meter on token counts recorded inside the session transcript, so
nothing on the wire can help it — what controls the ceiling is the transcript on disk, which
Claude Code re-derives context from on resume. This CLI compacts that transcript directly.

## Usage

```sh
better-compact claude [sessionId] [--resume] [--aggressive] [--from-backup] [--keep-tokens N]
better-compact claude --run [claude args...]
```

Compacts a **closed** session's transcript (`~/.claude/projects/<project>/<sessionId>.jsonl`) so it
reopens under the context limit. The default keeps **every message**: old tool outputs and oversized
tool inputs become short stubs (tool name, call id, and primary target preserved), old reasoning
blocks are dropped, and the recent tail (`--keep-tokens`, default 25k) stays verbatim. It also
zeroes the stale input-side token counts Claude Code seeds its context meter from — recorded usage
that describes requests which no longer exist (output tokens are kept) — and resumes with the
model's `[1m]` long-context variant when the transcript proves the session needs it.

- `--aggressive` reproduces Claude Code's own `/compact` (append-only `compact_boundary` +
  summary entries; old turns leave the context). Use it when stubbing alone cannot fit the window.
- `--from-backup` restores each entry's original content from the accumulated backups (oldest
  version wins; turns added after any backup are kept), then compacts.
- `--resume` reopens the session afterward, inheriting your terminal.
- `--run` wraps `claude` so the `/better-compact:compact` command (from the
  [companion plugin](../claude-code/README.md)) can queue a compaction: exit the session and it
  prunes and reopens automatically — no tmux, no wrapper scripts.

Every run backs up the original to `~/.better-compact/claude-backups/` before writing, verifies
the rewritten transcript's integrity, and refuses to touch a live session (registry pid check plus
a scan for still-starting `claude --resume` processes).

## Setup

```sh
npm install -g @better-compact/cli
better-compact install claude-code   # only needed to unwind a legacy proxy redirect
```

Earlier releases routed Claude Code through a local wire proxy and disabled native
auto-compaction; both are retired. `install claude-code` removes that legacy redirect from
`~/.claude/settings.json` if present (restoring any preserved real gateway URL) and re-enables
native auto-compaction. On a fresh machine it is a no-op — there is nothing to wire up.

## How it decides what to prune

The pruning decisions come from the shared Better Compact ladder
([`@better-compact/core`](../core/README.md)) over the same Anthropic-wire codec that models
Claude Code's transcript content: tool calls and their results pair into single items, inline
system-reminders are preserved (and re-positioned as user-role reminders where the API's
placement rules require), and unknown content survives verbatim.
