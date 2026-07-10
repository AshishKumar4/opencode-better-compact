#!/usr/bin/env sh
# Better Compact for Claude Code — installer.
# 1. Builds and links the better-compact-proxy bin.
# 2. Points Claude Code at the proxy via ~/.claude/settings.json `env`
#    (merged, never clobbered; a pre-existing ANTHROPIC_BASE_URL becomes the
#    proxy's upstream so gateway users keep working).
# 3. Prints exactly what changed and how to undo it.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
BIN_PATH="${BIN_DIR}/better-compact-proxy"
CLI_PATH="${REPO_ROOT}/packages/proxy/dist/cli.js"
SETTINGS="${HOME}/.claude/settings.json"
CONFIG_DIR="${HOME}/.better-compact"
PROXY_URL="http://127.0.0.1:42817/anthropic"

command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }
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

mkdir -p "${HOME}/.claude" "$CONFIG_DIR"
SHELL_BASE_URL="${ANTHROPIC_BASE_URL:-}" node - "$SETTINGS" "$CONFIG_DIR/config.json" "$PROXY_URL" <<'MERGE'
const { readFileSync, writeFileSync, existsSync } = require("node:fs")
const [settingsPath, configPath, proxyUrl] = process.argv.slice(2)

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {})
const settings = read(settingsPath)
const config = read(configPath)

const previous = settings.env?.ANTHROPIC_BASE_URL ?? process.env.SHELL_BASE_URL ?? ""
if (previous && previous !== proxyUrl) {
    config.anthropicUpstream = previous
    console.log(`Preserved existing ANTHROPIC_BASE_URL as proxy upstream: ${previous}`)
}
writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n")

settings.env = {
    ...settings.env,
    ANTHROPIC_BASE_URL: proxyUrl,
    DISABLE_AUTO_COMPACT: "1",
}
writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + "\n")
console.log(`Wrote env.ANTHROPIC_BASE_URL=${proxyUrl} and env.DISABLE_AUTO_COMPACT=1 to ${settingsPath}`)
MERGE

"$BIN_PATH" start

cat <<DONE

Better Compact is installed. Changes made:
  - $BIN_PATH (wrapper for the proxy CLI)
  - $SETTINGS: env.ANTHROPIC_BASE_URL=$PROXY_URL, env.DISABLE_AUTO_COMPACT=1
  - $CONFIG_DIR/config.json (proxy upstream + preset)
  - proxy daemon started (lockfile $CONFIG_DIR/proxy.json, log $CONFIG_DIR/proxy.log)

To undo:
  better-compact-proxy stop
  remove env.ANTHROPIC_BASE_URL and env.DISABLE_AUTO_COMPACT from $SETTINGS
  rm $BIN_PATH && rm -r $CONFIG_DIR

Note for OAuth (subscription) logins: Claude Code may treat a custom base URL
as a third-party gateway. If requests fail with auth errors, see the README
section on _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL.
DONE
