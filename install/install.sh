#!/usr/bin/env sh
set -eu

command -v node >/dev/null 2>&1 || {
    printf '%s\n' "error: Node.js is required; install Node.js and re-run." >&2
    exit 1
}
command -v npm >/dev/null 2>&1 || {
    printf '%s\n' "error: npm is required; install npm and re-run." >&2
    exit 1
}

if [ "$#" -gt 0 ]; then
    case "$1" in
        claude-code | codex) targets="$1" ;;
        *)
            printf "error: unsupported target '%s'. Valid targets: claude-code, codex\n" "$1" >&2
            exit 1
            ;;
    esac
else
    targets=""
    if command -v claude >/dev/null 2>&1; then
        targets="claude-code"
    fi
    if command -v codex >/dev/null 2>&1; then
        targets="${targets}${targets:+ }codex"
    fi
    if [ -z "$targets" ]; then
        printf '%s\n' "error: no supported agent CLI found. Valid targets: claude-code, codex" >&2
        exit 1
    fi
fi

printf '%s\n' "Installing @better-compact/cli@latest globally with npm..."
npm install -g @better-compact/cli@latest
printf '%s\n' "Installed @better-compact/cli@latest globally."

for target in $targets; do
    printf "Configuring Better Compact for %s...\n" "$target"
    better-compact install "$target"
    printf "Configured Better Compact for %s.\n" "$target"
done
