import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { COMPACTION_PRESETS, normalizePreset, type CompactionProfile } from "@better-compact/core"

export const DEFAULT_PORT = 42817
export const DEFAULT_UPSTREAM = "https://api.anthropic.com"

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
    profile: CompactionProfile
}

export function loadConfig(paths: ProxyPaths): ProxyConfig {
    let raw: Record<string, unknown> = {}
    try {
        raw = JSON.parse(readFileSync(paths.configFile, "utf-8")) as Record<string, unknown>
    } catch {
        // Missing or unreadable config means defaults.
    }
    const upstream = typeof raw.anthropicUpstream === "string" ? raw.anthropicUpstream : DEFAULT_UPSTREAM
    const preset = normalizePreset(raw.preset)
    return {
        anthropicUpstream: upstream.replace(/\/+$/, ""),
        profile: COMPACTION_PRESETS[preset === "custom" ? "light" : preset],
    }
}
