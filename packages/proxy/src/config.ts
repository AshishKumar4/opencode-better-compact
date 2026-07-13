import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { COMPACTION_PRESETS, normalizePreset, type CompactionProfile } from "@better-compact/core"

export const DEFAULT_PORT = 42817
export const DEFAULT_UPSTREAM = "https://api.anthropic.com"
// Codex's default `openai` provider base_url already carries `/v1` and appends
// `/responses` (verified: model-provider-info/src/lib.rs:254, provider url join).
// The proxy serves `/openai/responses`, so `/v1` lives in the upstream base.
export const DEFAULT_OPENAI_UPSTREAM = "https://api.openai.com/v1"
export const CHATGPT_CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex"

export interface ProxyPaths {
    home: string
    lockfile: string
    configFile: string
    logFile: string
    plansDir: string
    transcriptsDir: string
    capturesDir: string
    debugDir: string
}

export function proxyPaths(home: string = join(homedir(), ".better-compact")): ProxyPaths {
    return {
        home,
        lockfile: join(home, "proxy.json"),
        configFile: join(home, "config.json"),
        logFile: join(home, "proxy.log"),
        plansDir: join(home, "plans"),
        transcriptsDir: join(home, "transcripts"),
        capturesDir: join(home, "captures"),
        debugDir: join(home, "debug"),
    }
}

export interface ProxyConfig {
    // Upstream for /anthropic/*. The installer preserves a pre-existing
    // ANTHROPIC_BASE_URL here so existing gateway users keep working.
    anthropicUpstream: string
    // Upstream for /openai/*. The installer preserves a pre-existing
    // openai_base_url here so existing custom-gateway Codex users keep working.
    openaiUpstream: string
    profile: CompactionProfile
}

export function loadConfig(paths: ProxyPaths): ProxyConfig {
    let raw: Record<string, unknown> = {}
    try {
        raw = JSON.parse(readFileSync(paths.configFile, "utf-8")) as Record<string, unknown>
    } catch {
        // Missing or unreadable config means defaults.
    }
    const anthropic =
        typeof raw.anthropicUpstream === "string" ? raw.anthropicUpstream : DEFAULT_UPSTREAM
    const openai =
        typeof raw.openaiUpstream === "string" ? raw.openaiUpstream : DEFAULT_OPENAI_UPSTREAM
    const preset = normalizePreset(raw.preset)
    return {
        anthropicUpstream: anthropic.replace(/\/+$/, ""),
        openaiUpstream: openai.replace(/\/+$/, ""),
        profile: COMPACTION_PRESETS[preset === "custom" ? "light" : preset],
    }
}
