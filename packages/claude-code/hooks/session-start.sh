#!/usr/bin/env sh
# Spawn-if-absent: `start` is idempotent through the daemon's lockfile and
# health check. SessionStart stdout is injected into the session context, so
# stay silent there; problems go to stderr and never block the session.
if command -v better-compact-proxy >/dev/null 2>&1; then
    PROXY=better-compact-proxy
elif [ -x "${HOME}/.local/bin/better-compact-proxy" ]; then
    # The installer links the launcher here. Fall back to the absolute path
    # when ~/.local/bin is not on PATH (e.g. a non-login shell after reboot),
    # so an off-PATH launcher does not leave every request hitting a dead port.
    PROXY="${HOME}/.local/bin/better-compact-proxy"
else
    echo "better-compact: better-compact-proxy not found on PATH or in ~/.local/bin; requests are not being pruned" >&2
    exit 0
fi

"$PROXY" start >/dev/null 2>&1 \
    || echo "better-compact: proxy failed to start; see ~/.better-compact/proxy.log" >&2
exit 0