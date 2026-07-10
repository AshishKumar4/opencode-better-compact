---
description: Show Better Compact proxy status and the current session's pruning stats
allowed-tools: Bash(better-compact-proxy status), Bash(ls:*), Bash(cat:*)
---

Report the Better Compact state to the user:

1. Run `better-compact-proxy status` and relay whether the daemon is running, its port, and its
   upstream.
2. Find this session's plan: `ls -t ~/.better-compact/plans/` and `cat` the most recently modified
   file (plans are keyed by a hash of the session's first user message, so the newest one belongs
   to the most recently active session).
3. If a plan exists, summarize it: `beforeTokens` → `afterPruneTokens`, which `stages` applied,
   and the `transcriptRelativePath` where the pruned raw history is preserved. If none exists,
   say the session has not crossed the pruning trigger yet.

Keep it short: a few lines, no tables.
