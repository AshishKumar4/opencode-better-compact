import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser/lib/esm/main.js"
import type { PluginInput } from "@opencode-ai/plugin"
import {
    DEFAULT_CUSTOM_COMPACTION,
    normalizeCompactionCustom,
    normalizePreset,
    type CompactionConfig,
} from "./compaction-settings"

export type {
    CompactionConfig,
    CompactionCustomSettings,
    CompactionPreset,
    CompactionProfile,
} from "./compaction-settings"
export { COMPACTION_PRESETS, DEFAULT_CUSTOM_COMPACTION, normalizeCompactionCustom, normalizePreset, resolveCompactionProfile } from "./compaction-settings"

type Permission = "ask" | "allow" | "deny"

export interface CompressConfig {
    permission: Permission
}

export interface Commands {
    enabled: boolean
}

export interface ManualModeConfig {
    enabled: boolean
    automaticStrategies: boolean
}

export interface ExperimentalConfig {
    allowSubAgents: boolean
}

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    commands: Commands
    compaction: CompactionConfig
    manualMode: ManualModeConfig
    experimental: ExperimentalConfig
    compress: CompressConfig
}

export const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "autoUpdate",
    "debug",
    "experimental",
    "experimental.allowSubAgents",
    "commands",
    "commands.enabled",
    "compaction",
    "compaction.preset",
    "compaction.custom",
    "compaction.custom.triggerPercent",
    "compaction.custom.targetPercent",
    "compaction.custom.recentToolTokens",
    "compaction.custom.summarizerConcurrency",
    "manualMode",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "compress",
    "compress.permission",
])

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

interface ValidationError {
    key: string
    expected: string
    actual: string
}

export function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }

    if (config.autoUpdate !== undefined && typeof config.autoUpdate !== "boolean") {
        errors.push({ key: "autoUpdate", expected: "boolean", actual: typeof config.autoUpdate })
    }

    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }

    const experimental = config.experimental
    if (experimental !== undefined) {
        if (
            typeof experimental !== "object" ||
            experimental === null ||
            Array.isArray(experimental)
        ) {
            errors.push({ key: "experimental", expected: "object", actual: typeof experimental })
        } else if (
            experimental.allowSubAgents !== undefined &&
            typeof experimental.allowSubAgents !== "boolean"
        ) {
            errors.push({
                key: "experimental.allowSubAgents",
                expected: "boolean",
                actual: typeof experimental.allowSubAgents,
            })
        }
    }

    const commands = config.commands
    if (commands !== undefined) {
        if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
            errors.push({ key: "commands", expected: "object", actual: typeof commands })
        } else if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
            errors.push({
                key: "commands.enabled",
                expected: "boolean",
                actual: typeof commands.enabled,
            })
        }
    }

    const compaction = config.compaction
    if (compaction !== undefined) {
        if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction)) {
            errors.push({ key: "compaction", expected: "object", actual: typeof compaction })
        } else {
            if (
                compaction.preset !== undefined &&
                compaction.preset !== "light" &&
                compaction.preset !== "moderate" &&
                compaction.preset !== "max" &&
                compaction.preset !== "custom"
            ) {
                errors.push({
                    key: "compaction.preset",
                    expected: '"light" | "moderate" | "max" | "custom"',
                    actual: JSON.stringify(compaction.preset),
                })
            }

            const custom = compaction.custom
            if (custom !== undefined) {
                if (typeof custom !== "object" || custom === null || Array.isArray(custom)) {
                    errors.push({ key: "compaction.custom", expected: "object", actual: typeof custom })
                } else {
                    for (const key of ["triggerPercent", "targetPercent", "recentToolTokens", "summarizerConcurrency"] as const) {
                        const value = custom[key]
                        if (value !== undefined && typeof value !== "number") {
                            errors.push({ key: `compaction.custom.${key}`, expected: "number", actual: typeof value })
                        }
                    }
                }
            }
        }
    }

    const manualMode = config.manualMode
    if (manualMode !== undefined) {
        if (typeof manualMode !== "object" || manualMode === null || Array.isArray(manualMode)) {
            errors.push({ key: "manualMode", expected: "object", actual: typeof manualMode })
        } else {
            if (manualMode.enabled !== undefined && typeof manualMode.enabled !== "boolean") {
                errors.push({
                    key: "manualMode.enabled",
                    expected: "boolean",
                    actual: typeof manualMode.enabled,
                })
            }

            if (
                manualMode.automaticStrategies !== undefined &&
                typeof manualMode.automaticStrategies !== "boolean"
            ) {
                errors.push({
                    key: "manualMode.automaticStrategies",
                    expected: "boolean",
                    actual: typeof manualMode.automaticStrategies,
                })
            }
        }
    }

    const compress = config.compress
    if (compress !== undefined) {
        if (typeof compress !== "object" || compress === null || Array.isArray(compress)) {
            errors.push({ key: "compress", expected: "object", actual: typeof compress })
        } else {
            const validValues = ["ask", "allow", "deny"]
            if (compress.permission !== undefined && !validValues.includes(compress.permission)) {
                errors.push({
                    key: "compress.permission",
                    expected: '"ask" | "allow" | "deny"',
                    actual: JSON.stringify(compress.permission),
                })
            }
        }
    }

    return errors
}

function showConfigWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `Better Compact: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    autoUpdate: false,
    debug: false,
    commands: {
        enabled: true,
    },
    compaction: {
        preset: "light",
        custom: { ...DEFAULT_CUSTOM_COMPACTION },
    },
    manualMode: {
        enabled: false,
        automaticStrategies: true,
    },
    experimental: {
        allowSubAgents: false,
    },
    compress: {
        permission: "allow",
    },
}

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "better-compact.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "better-compact.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    const global = existsSync(GLOBAL_CONFIG_PATH_JSONC)
        ? GLOBAL_CONFIG_PATH_JSONC
        : existsSync(GLOBAL_CONFIG_PATH_JSON)
          ? GLOBAL_CONFIG_PATH_JSON
          : null

    let configDir: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "better-compact.jsonc")
        const configJson = join(opencodeConfigDir, "better-compact.json")
        configDir = existsSync(configJsonc)
            ? configJsonc
            : existsSync(configJson)
              ? configJson
              : null
    }

    let project: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "better-compact.jsonc")
            const projectJson = join(opencodeDir, "better-compact.json")
            project = existsSync(projectJsonc)
                ? projectJsonc
                : existsSync(projectJson)
                  ? projectJson
                  : null
        }
    }

    return { global, configDir, project }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "https://raw.githubusercontent.com/AshishKumar4/opencode-better-compact/master/packages/opencode/better-compact.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent = ""
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null }
    }

    try {
        const parsed = parse(fileContent, undefined, { allowTrailingComma: true })
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

function mergeCompress(
    base: PluginConfig["compress"],
    override?: Partial<PluginConfig["compress"]>,
): PluginConfig["compress"] {
    if (!override) {
        return base
    }

    return {
        permission: override.permission ?? base.permission,
    }
}

function mergeCommands(
    base: PluginConfig["commands"],
    override?: Partial<PluginConfig["commands"]>,
): PluginConfig["commands"] {
    if (!override) {
        return base
    }

    return {
        enabled: override.enabled ?? base.enabled,
    }
}

function mergeCompaction(
    base: PluginConfig["compaction"],
    override?: Partial<PluginConfig["compaction"]>,
): PluginConfig["compaction"] {
    if (!override) return base
    return {
        preset: normalizePreset(override.preset ?? base.preset),
        custom: normalizeCompactionCustom({
            ...base.custom,
            ...(override.custom ?? {}),
        }),
    }
}

function mergeManualMode(
    base: PluginConfig["manualMode"],
    override?: Partial<PluginConfig["manualMode"]>,
): PluginConfig["manualMode"] {
    if (override === undefined) return base

    return {
        enabled: override.enabled ?? base.enabled,
        automaticStrategies: override.automaticStrategies ?? base.automaticStrategies,
    }
}

function mergeExperimental(
    base: PluginConfig["experimental"],
    override?: Partial<PluginConfig["experimental"]>,
): PluginConfig["experimental"] {
    if (override === undefined) return base

    return {
        allowSubAgents: override.allowSubAgents ?? base.allowSubAgents,
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: { enabled: config.commands.enabled },
        compaction: {
            preset: config.compaction.preset,
            custom: { ...config.compaction.custom },
        },
        manualMode: {
            enabled: config.manualMode.enabled,
            automaticStrategies: config.manualMode.automaticStrategies,
        },
        experimental: { ...config.experimental },
        compress: { ...config.compress },
    }
}

function mergeLayer(config: PluginConfig, data: Record<string, any>): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        autoUpdate: data.autoUpdate ?? config.autoUpdate,
        debug: data.debug ?? config.debug,
        commands: mergeCommands(config.commands, data.commands as any),
        compaction: mergeCompaction(config.compaction, data.compaction as any),
        manualMode: mergeManualMode(config.manualMode, data.manualMode as any),
        experimental: mergeExperimental(config.experimental, data.experimental as any),
        compress: mergeCompress(config.compress, data.compress as Partial<CompressConfig>),
    }
}

function scheduleParseWarning(ctx: PluginInput, title: string, message: string): void {
    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title,
                    message,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    if (!configPaths.global) {
        createDefaultConfig()
    }

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) {
            continue
        }

        const result = loadConfigFile(layer.path)
        if (result.parseError) {
            scheduleParseWarning(
                ctx,
                `Better Compact: Invalid ${layer.name}`,
                `${layer.path}\n${result.parseError}\nUsing previous/default values`,
            )
            continue
        }

        if (!result.data) {
            continue
        }

        showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
        config = mergeLayer(config, result.data)
    }

    return config
}
