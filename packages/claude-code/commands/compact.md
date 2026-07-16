---
description: Compact this session with Better Compact — prune old tool output and reasoning (keeping every message) and reopen it
allowed-tools: Bash(mkdir:*), Bash(touch:*)
---

Queue a Better Compact compaction of the current session, then tell the user how to finish it.

1. Flag this session for compaction:

   ```
   mkdir -p ~/.better-compact/recompact && touch ~/.better-compact/recompact/"$CLAUDE_CODE_SESSION_ID"
   ```

2. Relay to the user, briefly (include the actual session id from `$CLAUDE_CODE_SESSION_ID`):
   - Compaction is queued. Exit this session with Ctrl-D.
   - If it was started with `better-compact claude --run`, it will prune old tool output and reasoning — keeping every message — and reopen automatically.
   - Otherwise, run `better-compact claude <session-id> --resume` from this directory to compact and reopen it.

Compaction only runs while the session is closed (editing a live transcript is unsafe), which is why it happens on exit. The full transcript is backed up to `~/.better-compact/claude-backups/`.
