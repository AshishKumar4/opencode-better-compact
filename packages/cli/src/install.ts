import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CHATGPT_CODEX_UPSTREAM, DEFAULT_PORT, type ProxyPaths } from "./config"

export const CODEX_PROXY_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}/openai`
export const ANTHROPIC_PROXY_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}/anthropic`

const CODEX_BACKEND_AUTH_MODES = new Set([
    "chatgpt",
    "chatgptAuthTokens",
    "headers",
    "agentIdentity",
    "personalAccessToken",
])
const INFERRED_UPSTREAM_SOURCE = "codex-auth"

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
    // A table header is a line that is exactly `[section]` (optionally trailed
    // by a comment). Matching any line that merely starts with `[` would treat
    // a multiline-array element like `["nested"],` as a section boundary.
    const firstTableIndex = lines.findIndex((line) => /^\s*\[[^\]]*\]\s*(#.*)?$/.test(line))
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

export interface ClaudeCodeInstallResult {
    settingsPath: string
    configJsonPath: string
    previousBaseUrl: string | null
    undoSteps: string[]
}

export function installClaudeCode(paths: ProxyPaths, home = homedir()): ClaudeCodeInstallResult {
    const settingsPath = join(home, ".claude", "settings.json")
    const settings = readClaudeJson(settingsPath)
    const config = readClaudeJson(paths.configFile)
    const priorEnv = jsonObjectProperty(settings, "env", settingsPath)
    const settingsBaseUrl = stringProperty(priorEnv, "ANTHROPIC_BASE_URL")
    const shellBaseUrl = process.env.ANTHROPIC_BASE_URL || null
    const existingPreserved = stringProperty(config, "anthropicUpstream")
    const previousBaseUrl =
        realAnthropicUpstream(settingsBaseUrl) ?? realAnthropicUpstream(shellBaseUrl)
    const addedDisableAutoCompact = priorEnv.DISABLE_AUTO_COMPACT === undefined

    if (previousBaseUrl) config.anthropicUpstream = previousBaseUrl

    settings.env = {
        ...priorEnv,
        ANTHROPIC_BASE_URL: ANTHROPIC_PROXY_BASE_URL,
        DISABLE_AUTO_COMPACT: "1",
    }

    mkdirSync(dirname(paths.configFile), { recursive: true })
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(paths.configFile, JSON.stringify(config, null, 4) + "\n")
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + "\n")

    const restoreBaseUrl = previousBaseUrl ?? existingPreserved
    const undoSteps = [
        "better-compact stop",
        restoreBaseUrl
            ? `set env.ANTHROPIC_BASE_URL back to "${restoreBaseUrl}" in ${settingsPath}`
            : `remove env.ANTHROPIC_BASE_URL from ${settingsPath}`,
    ]
    if (addedDisableAutoCompact) {
        undoSteps.push(`remove env.DISABLE_AUTO_COMPACT from ${settingsPath}`)
    }

    return {
        settingsPath,
        configJsonPath: paths.configFile,
        previousBaseUrl,
        undoSteps,
    }
}

// Applies the config.toml edit and records a preserved upstream in the proxy's
// config.json. Throws with a user-facing message when the edit is refused.
export function installCodex(paths: ProxyPaths, home = homedir()): CodexInstallResult {
    const codexHome = process.env.CODEX_HOME || join(home, ".codex")
    const codexConfigPath = join(codexHome, "config.toml")
    const existing = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf-8") : ""
    const edit = editCodexConfig(existing, CODEX_PROXY_BASE_URL)
    if (!edit.ok) throw new Error(edit.reason)

    const config = readConfigJson(paths.configFile)
    const originalConfig = JSON.stringify(config)
    const configuredUpstream =
        typeof config.openaiUpstream === "string" ? config.openaiUpstream : null
    const inferredUpstream = codexAuthUpstream(codexHome)
    if (edit.previousBaseUrl) {
        config.openaiUpstream = edit.previousBaseUrl
        delete config.openaiUpstreamSource
    } else if (!configuredUpstream || config.openaiUpstreamSource === INFERRED_UPSTREAM_SOURCE) {
        if (inferredUpstream) {
            config.openaiUpstream = inferredUpstream
            config.openaiUpstreamSource = INFERRED_UPSTREAM_SOURCE
        } else {
            delete config.openaiUpstream
            delete config.openaiUpstreamSource
        }
    }
    if (JSON.stringify(config) !== originalConfig) {
        mkdirSync(dirname(paths.configFile), { recursive: true })
        writeFileSync(paths.configFile, JSON.stringify(config, null, 4) + "\n")
    }

    mkdirSync(dirname(codexConfigPath), { recursive: true })
    writeFileSync(codexConfigPath, edit.content)

    return {
        codexConfigPath,
        action: edit.action,
        previousBaseUrl: edit.previousBaseUrl,
        configJsonPath: paths.configFile,
    }
}

function codexAuthUpstream(codexHome: string): string | null {
    try {
        const raw: unknown = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf-8"))
        if (!raw || typeof raw !== "object") return null
        const authMode = Reflect.get(raw, "auth_mode")
        if (typeof authMode === "string") {
            return CODEX_BACKEND_AUTH_MODES.has(authMode) ? CHATGPT_CODEX_UPSTREAM : null
        }
        if (Reflect.get(raw, "personal_access_token") != null) return CHATGPT_CODEX_UPSTREAM
        if (Reflect.get(raw, "bedrock_api_key") != null) return null
        if (Reflect.get(raw, "OPENAI_API_KEY") != null) return null
        return CHATGPT_CODEX_UPSTREAM
    } catch {
        return null
    }
}

function readConfigJson(path: string): Record<string, unknown> {
    return readJsonObject(path, (error) =>
        error
            ? new Error(`${path} must contain a valid JSON object`, { cause: error })
            : new Error(`${path} must contain a valid JSON object`),
    )
}

function readClaudeJson(path: string): Record<string, unknown> {
    return readJsonObject(
        path,
        (error) => {
            if (!error) return new Error(`${path} must contain a JSON object`)
            const detail = error instanceof Error ? error.message : String(error)
            return new Error(
                `${path} is not valid JSON (${detail}); fix or remove it, then re-run.`,
                { cause: error },
            )
        },
        true,
    )
}

function readJsonObject(
    path: string,
    invalid: (error: unknown | null) => Error,
    allowEmpty = false,
): Record<string, unknown> {
    if (!existsSync(path)) return {}
    let raw: unknown
    try {
        const content = readFileSync(path, "utf-8")
        raw = JSON.parse(allowEmpty && !content ? "{}" : content)
    } catch (error) {
        throw invalid(error)
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw invalid(null)
    }
    return raw as Record<string, unknown>
}

function jsonObjectProperty(
    object: Record<string, unknown>,
    key: string,
    path: string,
): Record<string, unknown> {
    const value = object[key]
    if (value === undefined) return {}
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path} ${key} must contain a JSON object`)
    }
    return value as Record<string, unknown>
}

function stringProperty(object: Record<string, unknown>, key: string): string | null {
    return typeof object[key] === "string" ? object[key] : null
}

function realAnthropicUpstream(value: string | null): string | null {
    return value && value !== ANTHROPIC_PROXY_BASE_URL ? value : null
}
