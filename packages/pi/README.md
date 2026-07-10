> This document is edited and maintained by Claude (Anthropic) and presented as-is.

# @better-compact/pi

This is my [pi](https://pi.dev) adapter for Better Compact — the staged context-pruning ladder from
[`@better-compact/core`](../core). Instead of letting a long session hit compaction and lose detail
to one lossy summary, it virtually prunes what the model no longer needs (old tool outputs first,
then old thinking, then whole assistant runs), writes the raw history to a transcript file the agent
can read back, and leaves the recent tail byte-for-byte untouched. The session file itself is never
modified — pruning happens per request, on the messages pi is about to send.

## How it works here

- The extension listens to pi's `context` event. When the estimated context crosses the trigger
  (85% of the model window), it builds a pruning plan, applies it to the outgoing messages, and
  returns the replacement. Below the trigger it does nothing.
- A tool call and its tool-result message are treated as one unit: pruning removes both, keeping
  the conversation valid.
- The plan persists as a `better-compact-plan` custom entry in the session file, so it survives
  restarts, `/resume`, and forks (a fork replays the plan its branch recorded).
- Pruned ranges are archived under pi's session directory
  (`<session dir>/better-compact/<session id>/<hash>.md`) and a reference message tells the model
  where to look instead of guessing.
- Collapsed assistant runs are re-summarized in the background with a real model call (the
  session's current model, through pi's own credential resolution); the better summaries apply
  from the next request.

## Install

As a pi package:

```bash
pi install npm:@better-compact/pi
```

Or as a manual drop-in: build with `pnpm build` and copy `dist/extension.js` into
`~/.pi/agent/extensions/`.

## Recommended settings

I recommend disabling pi's native compaction so it doesn't rewrite history that Better Compact is
already pruning non-destructively:

```json
{
    "compaction": { "enabled": false }
}
```

in `~/.pi/agent/settings.json`. The extension never changes your settings itself; if native
compaction fires while it is installed, it warns once per session.

## Command

`/better-compact` — force a prune of the current session right now (below the trigger too), with
before/after token numbers. The plan applies from the next request.

## Limitations

- The compaction profile is fixed to the light preset (trigger 85%, target 35%, 40K recent-tool
  budget). pi currently has no settings surface for extensions, so there is nothing to configure.
- Token counts are a chars/4 estimate over pi's own model serialization, not provider-reported
  usage.
