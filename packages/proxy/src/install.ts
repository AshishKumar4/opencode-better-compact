import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { DEFAULT_PORT, type ProxyPaths } from "./config"

export const CODEX_PROXY_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}/openai`

export type CodexConfigEdit =
    | {
          ok: true
          content: string
          // A pre-existing custom base_url to preserve as our upstream, or null
          // when there was none (or it already pointed at the proxy).
          previousBaseUrl: string | null
          action: "replaced" | "appended"
      }
    | { ok: false; reason: string }

const KEY = "openai_base_url"

// Conservative line-level TOML edit — no parser dependency. We only touch a
// single root-table `openai_base_url` assignment: replace it, or append one if
// absent. Anything we cannot edit unambiguously (the key nested inside a table,
// duplicated, or overridden by a `[model_providers.openai]` provider) is
// refused so we never corrupt a config we do not fully understand.
export function editCodexConfig(content: string, proxyBaseUrl: string): CodexConfigEdit {
    const lines = content.split("\n")
    const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line))
    const rootEnd = firstTableIndex === -1 ? lines.length : firstTableIndex

    if (lines.some((line) => /^\s*\[\s*model_providers\.openai\b/.test(line))) {
        return {
            ok: false,
            reason: "a custom [model_providers.openai] provider is configured; its base_url overrides openai_base_url. Point that provider's base_url at the proxy by hand.",
        }
    }

    const assignmentIndexes = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => new RegExp(`^\\s*${KEY}\\s*=`).test(line))
        .map(({ index }) => index)

    if (assignmentIndexes.length > 1) {
        return {
            ok: false,
            reason: `found ${assignmentIndexes.length} openai_base_url assignments; edit config.toml by hand.`,
        }
    }
    if (assignmentIndexes.length === 1 && assignmentIndexes[0] >= rootEnd) {
        return {
            ok: false,
            reason: "openai_base_url is defined inside a table section; edit config.toml by hand.",
        }
    }

    const replacement = `${KEY} = "${proxyBaseUrl}"`

    if (assignmentIndexes.length === 1) {
        const index = assignmentIndexes[0]
        const previous = parseTomlString(lines[index])
        const next = [...lines]
        next[index] = replacement
        return {
            ok: true,
            content: next.join("\n"),
            previousBaseUrl: preservableUpstream(previous, proxyBaseUrl),
            action: "replaced",
        }
    }

    const next = [...lines]
    // Insert at the end of the root table (before the first table header), so
    // the assignment stays a top-level key.
    next.splice(rootEnd, 0, replacement)
    return {
        ok: true,
        content: normalizeTrailing(next.join("\n")),
        previousBaseUrl: null,
        action: "appended",
    }
}

function parseTomlString(line: string): string | null {
    const match = line.match(new RegExp(`^\\s*${KEY}\\s*=\\s*(.+?)\\s*$`))
    if (!match) return null
    const raw = match[1].trim()
    const quoted = raw.match(/^"([^"]*)"$/) || raw.match(/^'([^']*)'$/)
    return quoted ? quoted[1] : raw
}

// A localhost/proxy value is our own prior install, not a real upstream.
function preservableUpstream(previous: string | null, proxyBaseUrl: string): string | null {
    if (!previous || previous === proxyBaseUrl) return null
    if (/127\.0\.0\.1|localhost/.test(previous)) return null
    return previous
}

function normalizeTrailing(content: string): string {
    return content.endsWith("\n") ? content : `${content}\n`
}

export interface CodexInstallResult {
    codexConfigPath: string
    action: "replaced" | "appended"
    previousBaseUrl: string | null
    configJsonPath: string
}

// Applies the config.toml edit and records a preserved upstream in the proxy's
// config.json. Throws with a user-facing message when the edit is refused.
export function installCodex(paths: ProxyPaths, home = homedir()): CodexInstallResult {
    const codexConfigPath = join(home, ".codex", "config.toml")
    const existing = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf-8") : ""
    const edit = editCodexConfig(existing, CODEX_PROXY_BASE_URL)
    if (!edit.ok) throw new Error(edit.reason)

    mkdirSync(dirname(codexConfigPath), { recursive: true })
    writeFileSync(codexConfigPath, edit.content)

    if (edit.previousBaseUrl) {
        const config = readConfigJson(paths.configFile)
        config.openaiUpstream = edit.previousBaseUrl
        mkdirSync(dirname(paths.configFile), { recursive: true })
        writeFileSync(paths.configFile, JSON.stringify(config, null, 4) + "\n")
    }

    return {
        codexConfigPath,
        action: edit.action,
        previousBaseUrl: edit.previousBaseUrl,
        configJsonPath: paths.configFile,
    }
}

function readConfigJson(path: string): Record<string, unknown> {
    try {
        return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
    } catch {
        return {}
    }
}
