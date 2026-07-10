#!/usr/bin/env sh
# Better Compact for Claude Code — installer.
# 1. Builds and links the better-compact-proxy bin.
# 2. Points Claude Code at the proxy via ~/.claude/settings.json `env`
#    (merged, never clobbered; a pre-existing ANTHROPIC_BASE_URL becomes the
#    proxy's upstream so gateway users keep working).
# 3. Prints exactly what changed and how to undo it (restoring, not discarding,
#    a preserved upstream).
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
BIN_PATH="${BIN_DIR}/better-compact-proxy"
CLI_PATH="${REPO_ROOT}/packages/proxy/dist/cli.js"
SETTINGS="${HOME}/.claude/settings.json"
CONFIG_DIR="${HOME}/.better-compact"
CONFIG_JSON="${CONFIG_DIR}/config.json"
PROXY_URL="http://127.0.0.1:42817/anthropic"

command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }

# Validate every config file we will touch BEFORE any mutation. On invalid
# JSON, name the file and change nothing — no half-install, no stack trace.
for file in "$SETTINGS" "$CONFIG_JSON"; do
    if [ -f "$file" ]; then
        node -e 'const {readFileSync}=require("node:fs");const p=process.argv[1];try{JSON.parse(readFileSync(p,"utf8")||"{}")}catch(e){console.error(`error: ${p} is not valid JSON (${e.message}); fix or remove it, then re-run.`);process.exit(1)}' "$file" || exit 1
    fi
done

command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm is required (corepack enable)" >&2; exit 1; }

echo "Building @better-compact/proxy..."
(cd "$REPO_ROOT" && pnpm install --silent && pnpm --filter @better-compact/proxy build >/dev/null)

mkdir -p "$BIN_DIR"
cat > "$BIN_PATH" <<WRAPPER
#!/usr/bin/env sh
exec node "$CLI_PATH" "\$@"
WRAPPER
chmod +x "$BIN_PATH"
echo "Linked $BIN_PATH -> $CLI_PATH"

case ":${PATH}:" in
    *":${BIN_DIR}:"*) : ;;
    *)
        echo "warning: ${BIN_DIR} is not on your PATH. Add it so 'better-compact-proxy' resolves:"
        echo "  export PATH=\"${BIN_DIR}:\$PATH\""
        ;;
esac

mkdir -p "${HOME}/.claude" "$CONFIG_DIR"
UNDO_HINTS="$(mktemp)"
trap 'rm -f "$UNDO_HINTS"' EXIT INT TERM
SHELL_BASE_URL="${ANTHROPIC_BASE_URL:-}" BIN_PATH="$BIN_PATH" CONFIG_DIR="$CONFIG_DIR" \
    node - "$SETTINGS" "$CONFIG_JSON" "$PROXY_URL" "$UNDO_HINTS" <<'MERGE'
const { readFileSync, writeFileSync, existsSync } = require("node:fs")
const [settingsPath, configPath, proxyUrl, undoPath] = process.argv.slice(2)

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf-8") || "{}") : {})
const settings = read(settingsPath)
const config = read(configPath)

const priorEnv = settings.env ?? {}
const settingsBaseUrl =
    typeof priorEnv.ANTHROPIC_BASE_URL === "string" ? priorEnv.ANTHROPIC_BASE_URL : ""
const shellBaseUrl = process.env.SHELL_BASE_URL ?? ""
const existingPreserved =
    typeof config.anthropicUpstream === "string" ? config.anthropicUpstream : ""
// Only remove DISABLE_AUTO_COMPACT on undo if this install is what added it.
const addedDisableAutoCompact = priorEnv.DISABLE_AUTO_COMPACT === undefined

// A real pre-existing upstream (from settings or the invoking shell) that is
// not already our proxy.
const previous =
    settingsBaseUrl && settingsBaseUrl !== proxyUrl
        ? settingsBaseUrl
        : shellBaseUrl && shellBaseUrl !== proxyUrl
          ? shellBaseUrl
          : ""
if (previous) {
    config.anthropicUpstream = previous
    console.log(`Preserved existing ANTHROPIC_BASE_URL as proxy upstream: ${previous}`)
}
writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n")

settings.env = { ...priorEnv, ANTHROPIC_BASE_URL: proxyUrl, DISABLE_AUTO_COMPACT: "1" }
writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + "\n")
console.log(`Wrote env.ANTHROPIC_BASE_URL=${proxyUrl} and env.DISABLE_AUTO_COMPACT=1 to ${settingsPath}`)

// The exact value to restore on undo: a real prior upstream this run moved, or
// one a previous install already preserved in config.json.
const restoreValue = previous || existingPreserved
const undo = ["  better-compact-proxy stop"]
undo.push(
    restoreValue
        ? `  set env.ANTHROPIC_BASE_URL back to "${restoreValue}" in ${settingsPath}`
        : `  remove env.ANTHROPIC_BASE_URL from ${settingsPath}`,
)
if (addedDisableAutoCompact) undo.push(`  remove env.DISABLE_AUTO_COMPACT from ${settingsPath}`)
undo.push(`  rm ${process.env.BIN_PATH}`)
undo.push(
    restoreValue
        ? `  rm -r ${process.env.CONFIG_DIR}   # safe once the upstream above is restored`
        : `  rm -r ${process.env.CONFIG_DIR}`,
)
writeFileSync(undoPath, undo.join("\n") + "\n")
MERGE

"$BIN_PATH" start

echo ""
echo "Better Compact is installed. Changes made:"
echo "  - $BIN_PATH (wrapper for the proxy CLI)"
echo "  - $SETTINGS: env.ANTHROPIC_BASE_URL=$PROXY_URL, env.DISABLE_AUTO_COMPACT=1"
echo "  - $CONFIG_JSON (proxy upstream + preset)"
echo "  - proxy daemon started (lockfile $CONFIG_DIR/proxy.json, log $CONFIG_DIR/proxy.log)"
echo ""
echo "To undo:"
cat "$UNDO_HINTS"
echo ""
echo "Note for OAuth (subscription) logins: OAuth was verified working through the"
echo "proxy on Claude Code 2.1.205 with no extra configuration. If a different"
echo "version rejects OAuth against a custom base URL, see the README section on"
echo "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL."