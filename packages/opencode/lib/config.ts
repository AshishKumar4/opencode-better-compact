import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js"
import type { PluginInput } from "@opencode-ai/plugin"
import {
    DEFAULT_CUSTOM_COMPACTION,
    normalizeCompactionCustom,
    normalizePreset,
    normalizeSummaryEffort,
    type CompactionConfig,
} from "@better-compact/core"

export type {
    CompactionConfig,
    CompactionCustomSettings,
    CompactionPreset,
    CompactionProfile,
    SummaryEffort,
} from "@better-compact/core"
export {
    COMPACTION_PRESETS,
    DEFAULT_CUSTOM_COMPACTION,
    normalizeCompactionCustom,
    normalizePreset,
    normalizeSummaryEffort,
    resolveCompactionProfile,
} from "@better-compact/core"

type Permission = "ask" | "allow" | "deny"

export interface CompressConfig {
    permission: Permission
}

export interface Commands {
    enabled: boolean
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
    "compaction.automatic",
    "compaction.preset",
    "compaction.summaryEffort",
    "compaction.custom",
    "compaction.custom.triggerPercent",
    "compaction.custom.targetPercent",
    "compaction.custom.recentToolTokens",
    "compaction.custom.summarizerConcurrency",
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
            if (compaction.automatic !== undefined && typeof compaction.automatic !== "boolean") {
                errors.push({
                    key: "compaction.automatic",
                    expected: "boolean",
                    actual: typeof compaction.automatic,
                })
            }
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
            if (
                compaction.summaryEffort !== undefined &&
                !["inherit", "low", "medium", "high", "max"].includes(compaction.summaryEffort)
            ) {
                errors.push({
                    key: "compaction.summaryEffort",
                    expected: '"inherit" | "low" | "medium" | "high" | "max"',
                    actual: JSON.stringify(compaction.summaryEffort),
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
        automatic: true,
        preset: "light",
        summaryEffort: "inherit",
        custom: { ...DEFAULT_CUSTOM_COMPACTION },
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
const SCHEMA_URL =
    "https://raw.githubusercontent.com/AshishKumar4/better-compact/master/packages/opencode/better-compact.schema.json"

function globalConfigPath(): string {
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC)) return GLOBAL_CONFIG_PATH_JSONC
    if (existsSync(GLOBAL_CONFIG_PATH_JSON)) return GLOBAL_CONFIG_PATH_JSON
    return GLOBAL_CONFIG_PATH_JSONC
}

export function hasGlobalCompactionConfig(): boolean {
    const path = globalConfigPath()
    if (!existsSync(path)) return false
    const result = loadConfigFile(path)
    return !!result.data?.compaction && typeof result.data.compaction === "object"
}

export function loadGlobalCompactionConfig(): CompactionConfig {
    const path = globalConfigPath()
    if (!existsSync(path)) return deepCloneConfig(defaultConfig).compaction
    const result = loadConfigFile(path)
    return mergeCompaction(deepCloneConfig(defaultConfig).compaction, result.data?.compaction)
}

export type SaveGlobalCompactionResult =
    | { ok: true; path: string }
    | { ok: false; path: string; error: string }

export function saveGlobalCompactionConfig(compaction: CompactionConfig): SaveGlobalCompactionResult {
    const path = globalConfigPath()
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
        if (!existsSync(GLOBAL_CONFIG_DIR)) mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
        const original = existsSync(path)
            ? readFileSync(path, "utf-8")
            : `{
  "$schema": "${SCHEMA_URL}"
}
`
        const errors: ParseError[] = []
        const parsed = parse(original, errors, { allowTrailingComma: true })
        if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { ok: false, path, error: "The global Better Compact config is invalid JSONC." }
        }

        const normalized = mergeCompaction(deepCloneConfig(defaultConfig).compaction, compaction)
        const values: Array<{ path: Array<string>; value: unknown }> = [
            { path: ["compaction", "automatic"], value: normalized.automatic },
            { path: ["compaction", "preset"], value: normalized.preset },
            { path: ["compaction", "summaryEffort"], value: normalized.summaryEffort },
            {
                path: ["compaction", "custom", "triggerPercent"],
                value: normalized.custom.triggerPercent,
            },
            {
                path: ["compaction", "custom", "targetPercent"],
                value: normalized.custom.targetPercent,
            },
            {
                path: ["compaction", "custom", "recentToolTokens"],
                value: normalized.custom.recentToolTokens,
            },
            {
                path: ["compaction", "custom", "summarizerConcurrency"],
                value: normalized.custom.summarizerConcurrency,
            },
        ]
        let updated = original
        for (const item of values) {
            updated = applyEdits(
                updated,
                modify(updated, item.path, item.value, {
                    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
                }),
            )
        }
        const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
        writeFileSync(temp, updated, { encoding: "utf-8", mode })
        const temporaryHandle = openSync(temp, "r")
        try {
            fsyncSync(temporaryHandle)
        } finally {
            closeSync(temporaryHandle)
        }
        renameSync(temp, path)
        const directoryHandle = openSync(dirname(path), "r")
        try {
            fsyncSync(directoryHandle)
        } finally {
            closeSync(directoryHandle)
        }
        return { ok: true, path }
    } catch (error) {
        rmSync(temp, { force: true })
        return {
            ok: false,
            path,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

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
  "$schema": "${SCHEMA_URL}"
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
    } catch (error) {
        return {
            data: null,
            parseError: error instanceof Error ? error.message : "Failed to read config",
        }
    }

    try {
        const errors: ParseError[] = []
        const parsed = parse(fileContent, errors, { allowTrailingComma: true })
        if (errors.length > 0) {
            return {
                data: null,
                parseError: `JSONC parse error at offset ${errors[0].offset}`,
            }
        }
        if (
            parsed === undefined ||
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
        ) {
            return { data: null, parseError: "Config root must be an object" }
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
        automatic: override.automatic ?? base.automatic,
        preset: normalizePreset(override.preset ?? base.preset),
        summaryEffort: normalizeSummaryEffort(override.summaryEffort ?? base.summaryEffort),
        custom: normalizeCompactionCustom({
            ...base.custom,
            ...(override.custom ?? {}),
        }),
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
            automatic: config.compaction.automatic,
            preset: config.compaction.preset,
            summaryEffort: config.compaction.summaryEffort,
            custom: { ...config.compaction.custom },
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

export function getConfig(ctx: PluginInput, options?: { warnings?: boolean }): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    let unsafeLayer = false
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
            unsafeLayer = true
            if (options?.warnings === false) continue
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

        const invalidKeys = getInvalidConfigKeys(result.data)
        const typeErrors = validateConfigTypes(result.data)
        if (invalidKeys.length > 0 || typeErrors.length > 0) {
            if (options?.warnings !== false) {
                showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
            }
        }
        if (typeErrors.length > 0) {
            unsafeLayer = true
            continue
        }
        config = mergeLayer(config, result.data)
    }

    // A malformed or unreadable layer could be hiding a stricter intent
    // (deny, disabled); fail closed instead of running on defaults.
    if (unsafeLayer) {
        config.enabled = false
        config.commands.enabled = false
        config.compaction.automatic = false
        config.compress.permission = "deny"
        config.autoUpdate = false
    }

    return config
}
