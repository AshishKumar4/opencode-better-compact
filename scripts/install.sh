#!/bin/sh
set -eu

REPO="${REPO:-AshishKumar4/opencode-better-compact}"
VERSION="${VERSION:-latest}"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
INSTALL_ROOT="${BETTER_COMPACT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode/plugins/better-compact}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "better-compact installer requires $1" >&2
    exit 1
  fi
}

download() {
  url="$1"
  output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$output"
    return
  fi
  echo "better-compact installer requires curl or wget" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  echo ""
}

need tar
need node

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

archive="$tmp/better-compact.tar.gz"
checksums="$tmp/checksums.txt"

echo "Downloading Better Compact ($VERSION)..."
download "$base/better-compact.tar.gz" "$archive"
download "$base/checksums.txt" "$checksums"

expected="$(grep '  better-compact.tar.gz$' "$checksums" | awk '{print $1}')"
actual="$(sha256_file "$archive")"
if [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
  echo "checksum mismatch for better-compact.tar.gz" >&2
  echo "expected: $expected" >&2
  echo "actual:   $actual" >&2
  exit 1
fi

extract="$tmp/extract"
mkdir -p "$extract"
tar -xzf "$archive" -C "$extract"

installed_version="$(MANIFEST="$extract/manifest.json" node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8")); process.stdout.write(m.version)')"
target="$INSTALL_ROOT/$installed_version"
current="$INSTALL_ROOT/current"

rm -rf "$target"
mkdir -p "$target"
cp -R "$extract"/. "$target"/
rm -rf "$current"
ln -s "$target" "$current"

mkdir -p "$CONFIG_DIR"
SERVER_PATH="$current/dist/index.js" \
TUI_PATH="$current/dist/tui.js" \
CONFIG_DIR="$CONFIG_DIR" \
node <<'NODE'
const fs = require("fs")
const path = require("path")
const { pathToFileURL } = require("url")

const configDir = process.env.CONFIG_DIR
const serverUrl = pathToFileURL(process.env.SERVER_PATH).href
const tuiUrl = pathToFileURL(process.env.TUI_PATH).href

function readJson(file) {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, "utf8").trim()
  if (!text) return {}
  return JSON.parse(text)
}

function update(file, url) {
  const data = readJson(file)
  const plugins = Array.isArray(data.plugin) ? data.plugin : []
  data.plugin = plugins
    .filter((item) => typeof item !== "string" || !/better-compact|opencode-dcp|dynamic-context-pruning/.test(item))
    .concat(url)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
}

update(path.join(configDir, "opencode.json"), serverUrl)
update(path.join(configDir, "tui.json"), tuiUrl)
NODE

echo "Better Compact $installed_version installed. Restart OpenCode to load it."
echo "Server: file://$SERVER_PATH"
echo "TUI:    file://$TUI_PATH"
