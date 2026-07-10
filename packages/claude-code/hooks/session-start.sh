#!/usr/bin/env sh
# Spawn-if-absent: `start` is idempotent through the daemon's lockfile and
# health check. SessionStart stdout is injected into the session context, so
# stay silent there; problems go to stderr and never block the session.
if command -v better-compact-proxy >/dev/null 2>&1; then
    better-compact-proxy start >/dev/null 2>&1 \
        || echo "better-compact: proxy failed to start; see ~/.better-compact/proxy.log" >&2
else
    echo "better-compact: better-compact-proxy not found on PATH; requests are not being pruned" >&2
fi
exit 0
