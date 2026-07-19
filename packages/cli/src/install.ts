import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Earlier releases wired Claude Code through a local pruning proxy on this
// host and disabled native auto-compaction. Both are retired — on-disk
// compaction (`better-compact claude`) replaced them — so setup now means
// unwinding that legacy redirect if present.
const LEGACY_PROXY_HOST = "127.0.0.1:42817"

export interface ClaudeCodeSetupResult {
    settingsPath: string
    removedBaseUrl: boolean
    restoredBaseUrl: string | null
    removedDisableAutoCompact: boolean
}

export function installClaudeCode(home = homedir()): ClaudeCodeSetupResult {
    const settingsPath = join(home, ".claude", "settings.json")
    const settings = readClaudeJson(settingsPath)
    const legacyConfigPath = join(home, ".better-compact", "config.json")
    const legacyConfig = readClaudeJson(legacyConfigPath)
    const env = jsonObjectProperty(settings, "env", settingsPath)
    const currentBaseUrl = stringProperty(env, "ANTHROPIC_BASE_URL")
    const preservedUpstream = stringProperty(legacyConfig, "anthropicUpstream")

    let removedBaseUrl = false
    let restoredBaseUrl: string | null = null
    if (currentBaseUrl && currentBaseUrl.includes(LEGACY_PROXY_HOST)) {
        if (preservedUpstream) {
            env.ANTHROPIC_BASE_URL = preservedUpstream
            restoredBaseUrl = preservedUpstream
        } else {
            delete env.ANTHROPIC_BASE_URL
        }
        removedBaseUrl = true
    }
    const removedDisableAutoCompact = env.DISABLE_AUTO_COMPACT !== undefined
    if (removedDisableAutoCompact) delete env.DISABLE_AUTO_COMPACT

    if (Object.keys(env).length > 0) settings.env = env
    else delete settings.env

    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + "\n")

    return { settingsPath, removedBaseUrl, restoredBaseUrl, removedDisableAutoCompact }
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
