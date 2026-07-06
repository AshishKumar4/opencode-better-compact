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
} from "./compaction-settings"

export type {
    CompactionConfig,
    CompactionCustomSettings,
    CompactionPreset,
    CompactionProfile,
} from "./compaction-settings"
export { COMPACTION_PRESETS, DEFAULT_CUSTOM_COMPACTION, normalizeCompactionCustom, normalizePreset, normalizeSummaryEffort, resolveCompactionProfile } from "./compaction-settings"

type Permission = "ask" | "allow" | "deny"
type CompressMode = "range" | "message"

export interface Deduplication {
    enabled: boolean
    protectedTools: string[]
}

export interface CompressConfig {
    mode: CompressMode
    permission: Permission
    showCompression: boolean
    summaryBuffer: boolean
    maxContextLimit: number | `${number}%`
    minContextLimit: number | `${number}%`
    modelMaxLimits?: Record<string, number | `${number}%`>
    modelMinLimits?: Record<string, number | `${number}%`>
    nudgeFrequency: number
    iterationNudgeThreshold: number
    nudgeForce: "strong" | "soft"
    protectedTools: string[]
    protectTags: boolean
    protectUserMessages: boolean
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface ManualModeConfig {
    enabled: boolean
    automaticStrategies: boolean
}

export interface PurgeErrors {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface TurnProtection {
    enabled: boolean
    turns: number
}

export interface ExperimentalConfig {
    allowSubAgents: boolean
    customPrompts: boolean
}

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    pruneNotificationType: "chat" | "toast"
    commands: Commands
    compaction: CompactionConfig
    manualMode: ManualModeConfig
    turnProtection: TurnProtection
    experimental: ExperimentalConfig
    protectedFilePatterns: string[]
    compress: CompressConfig
    strategies: {
        deduplication: Deduplication
        purgeErrors: PurgeErrors
    }
}

type CompressOverride = Partial<CompressConfig>

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "compress",
    "batch",
    "plan_enter",
    "plan_exit",
    "write",
    "edit",
]

const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread"]

export const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "autoUpdate",
    "debug",
    "showUpdateToasts",
    "pruneNotification",
    "pruneNotificationType",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "experimental",
    "experimental.allowSubAgents",
    "experimental.customPrompts",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "compaction",
    "compaction.automatic",
    "compaction.preset",
    "compaction.summaryEffort",
    "compaction.custom",
    "compaction.custom.triggerPercent",
    "compaction.custom.targetPercent",
    "compaction.custom.recentToolTokens",
    "compaction.custom.summarizerConcurrency",
    "manualMode",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "compress",
    "compress.mode",
    "compress.permission",
    "compress.showCompression",
    "compress.summaryBuffer",
    "compress.maxContextLimit",
    "compress.minContextLimit",
    "compress.modelMaxLimits",
    "compress.modelMinLimits",
    "compress.nudgeFrequency",
    "compress.iterationNudgeThreshold",
    "compress.nudgeForce",
    "compress.protectedTools",
    "compress.protectTags",
    "compress.protectUserMessages",
    "strategies",
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
])

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        // model*Limits are dynamic maps keyed by providerID/modelID; do not recurse into arbitrary IDs.
        if (fullKey === "compress.modelMaxLimits" || fullKey === "compress.modelMinLimits") {
            continue
        }

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

    if (config.pruneNotification !== undefined) {
        const validValues = ["off", "minimal", "detailed"]
        if (!validValues.includes(config.pruneNotification)) {
            errors.push({
                key: "pruneNotification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.pruneNotification),
            })
        }
    }

    if (config.pruneNotificationType !== undefined) {
        const validValues = ["chat", "toast"]
        if (!validValues.includes(config.pruneNotificationType)) {
            errors.push({
                key: "pruneNotificationType",
                expected: '"chat" | "toast"',
                actual: JSON.stringify(config.pruneNotificationType),
            })
        }
    }

    if (config.protectedFilePatterns !== undefined) {
        if (!Array.isArray(config.protectedFilePatterns)) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: typeof config.protectedFilePatterns,
            })
        } else if (!config.protectedFilePatterns.every((v: unknown) => typeof v === "string")) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: "non-string entries",
            })
        }
    }

    if (config.turnProtection) {
        if (
            config.turnProtection.enabled !== undefined &&
            typeof config.turnProtection.enabled !== "boolean"
        ) {
            errors.push({
                key: "turnProtection.enabled",
                expected: "boolean",
                actual: typeof config.turnProtection.enabled,
            })
        }

        if (
            config.turnProtection.turns !== undefined &&
            typeof config.turnProtection.turns !== "number"
        ) {
            errors.push({
                key: "turnProtection.turns",
                expected: "number",
                actual: typeof config.turnProtection.turns,
            })
        }
        if (typeof config.turnProtection.turns === "number" && config.turnProtection.turns < 1) {
            errors.push({
                key: "turnProtection.turns",
                expected: "positive number (>= 1)",
                actual: `${config.turnProtection.turns}`,
            })
        }
    }

    const experimental = config.experimental
    if (experimental !== undefined) {
        if (
            typeof experimental !== "object" ||
            experimental === null ||
            Array.isArray(experimental)
        ) {
            errors.push({
                key: "experimental",
                expected: "object",
                actual: typeof experimental,
            })
        } else {
            if (
                experimental.allowSubAgents !== undefined &&
                typeof experimental.allowSubAgents !== "boolean"
            ) {
                errors.push({
                    key: "experimental.allowSubAgents",
                    expected: "boolean",
                    actual: typeof experimental.allowSubAgents,
                })
            }

            if (
                experimental.customPrompts !== undefined &&
                typeof experimental.customPrompts !== "boolean"
            ) {
                errors.push({
                    key: "experimental.customPrompts",
                    expected: "boolean",
                    actual: typeof experimental.customPrompts,
                })
            }
        }
    }

    const commands = config.commands
    if (commands !== undefined) {
        if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
            errors.push({
                key: "commands",
                expected: "object",
                actual: typeof commands,
            })
        } else {
            if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
                errors.push({
                    key: "commands.enabled",
                    expected: "boolean",
                    actual: typeof commands.enabled,
                })
            }
            if (commands.protectedTools !== undefined && !Array.isArray(commands.protectedTools)) {
                errors.push({
                    key: "commands.protectedTools",
                    expected: "string[]",
                    actual: typeof commands.protectedTools,
                })
            }
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

    const manualMode = config.manualMode
    if (manualMode !== undefined) {
        if (typeof manualMode !== "object" || manualMode === null || Array.isArray(manualMode)) {
            errors.push({
                key: "manualMode",
                expected: "object",
                actual: typeof manualMode,
            })
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
            errors.push({
                key: "compress",
                expected: "object",
                actual: typeof compress,
            })
        } else {
            if (
                compress.mode !== undefined &&
                compress.mode !== "range" &&
                compress.mode !== "message"
            ) {
                errors.push({
                    key: "compress.mode",
                    expected: '"range" | "message"',
                    actual: JSON.stringify(compress.mode),
                })
            }

            if (
                compress.summaryBuffer !== undefined &&
                typeof compress.summaryBuffer !== "boolean"
            ) {
                errors.push({
                    key: "compress.summaryBuffer",
                    expected: "boolean",
                    actual: typeof compress.summaryBuffer,
                })
            }

            if (
                compress.nudgeFrequency !== undefined &&
                typeof compress.nudgeFrequency !== "number"
            ) {
                errors.push({
                    key: "compress.nudgeFrequency",
                    expected: "number",
                    actual: typeof compress.nudgeFrequency,
                })
            }

            if (typeof compress.nudgeFrequency === "number" && compress.nudgeFrequency < 1) {
                errors.push({
                    key: "compress.nudgeFrequency",
                    expected: "positive number (>= 1)",
                    actual: `${compress.nudgeFrequency} (will be clamped to 1)`,
                })
            }

            if (
                compress.iterationNudgeThreshold !== undefined &&
                typeof compress.iterationNudgeThreshold !== "number"
            ) {
                errors.push({
                    key: "compress.iterationNudgeThreshold",
                    expected: "number",
                    actual: typeof compress.iterationNudgeThreshold,
                })
            }

            if (
                compress.nudgeForce !== undefined &&
                compress.nudgeForce !== "strong" &&
                compress.nudgeForce !== "soft"
            ) {
                errors.push({
                    key: "compress.nudgeForce",
                    expected: '"strong" | "soft"',
                    actual: JSON.stringify(compress.nudgeForce),
                })
            }

            if (compress.protectedTools !== undefined && !Array.isArray(compress.protectedTools)) {
                errors.push({
                    key: "compress.protectedTools",
                    expected: "string[]",
                    actual: typeof compress.protectedTools,
                })
            }

            if (compress.protectTags !== undefined && typeof compress.protectTags !== "boolean") {
                errors.push({
                    key: "compress.protectTags",
                    expected: "boolean",
                    actual: typeof compress.protectTags,
                })
            }

            if (
                compress.protectUserMessages !== undefined &&
                typeof compress.protectUserMessages !== "boolean"
            ) {
                errors.push({
                    key: "compress.protectUserMessages",
                    expected: "boolean",
                    actual: typeof compress.protectUserMessages,
                })
            }

            if (
                typeof compress.iterationNudgeThreshold === "number" &&
                compress.iterationNudgeThreshold < 1
            ) {
                errors.push({
                    key: "compress.iterationNudgeThreshold",
                    expected: "positive number (>= 1)",
                    actual: `${compress.iterationNudgeThreshold} (will be clamped to 1)`,
                })
            }

            const validateLimitValue = (
                key: string,
                value: unknown,
                actualValue: unknown = value,
            ): void => {
                const isValidNumber = typeof value === "number"
                const isPercentString = typeof value === "string" && value.endsWith("%")

                if (!isValidNumber && !isPercentString) {
                    errors.push({
                        key,
                        expected: 'number | "${number}%"',
                        actual: JSON.stringify(actualValue),
                    })
                }
            }

            const validateModelLimits = (
                key: "compress.modelMaxLimits" | "compress.modelMinLimits",
                limits: unknown,
            ): void => {
                if (limits === undefined) {
                    return
                }

                if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
                    errors.push({
                        key,
                        expected: "Record<string, number | ${number}%>",
                        actual: typeof limits,
                    })
                    return
                }

                for (const [providerModelKey, limit] of Object.entries(limits)) {
                    const isValidNumber = typeof limit === "number"
                    const isPercentString =
                        typeof limit === "string" && /^\d+(?:\.\d+)?%$/.test(limit)
                    if (!isValidNumber && !isPercentString) {
                        errors.push({
                            key: `${key}.${providerModelKey}`,
                            expected: 'number | "${number}%"',
                            actual: JSON.stringify(limit),
                        })
                    }
                }
            }

            if (compress.maxContextLimit !== undefined) {
                validateLimitValue("compress.maxContextLimit", compress.maxContextLimit)
            }

            if (compress.minContextLimit !== undefined) {
                validateLimitValue("compress.minContextLimit", compress.minContextLimit)
            }

            validateModelLimits("compress.modelMaxLimits", compress.modelMaxLimits)
            validateModelLimits("compress.modelMinLimits", compress.modelMinLimits)

            const validValues = ["ask", "allow", "deny"]
            if (compress.permission !== undefined && !validValues.includes(compress.permission)) {
                errors.push({
                    key: "compress.permission",
                    expected: '"ask" | "allow" | "deny"',
                    actual: JSON.stringify(compress.permission),
                })
            }

            if (
                compress.showCompression !== undefined &&
                typeof compress.showCompression !== "boolean"
            ) {
                errors.push({
                    key: "compress.showCompression",
                    expected: "boolean",
                    actual: typeof compress.showCompression,
                })
            }
        }
    }

    const strategies = config.strategies
    if (strategies) {
        if (
            strategies.deduplication?.enabled !== undefined &&
            typeof strategies.deduplication.enabled !== "boolean"
        ) {
            errors.push({
                key: "strategies.deduplication.enabled",
                expected: "boolean",
                actual: typeof strategies.deduplication.enabled,
            })
        }

        if (
            strategies.deduplication?.protectedTools !== undefined &&
            !Array.isArray(strategies.deduplication.protectedTools)
        ) {
            errors.push({
                key: "strategies.deduplication.protectedTools",
                expected: "string[]",
                actual: typeof strategies.deduplication.protectedTools,
            })
        }

        if (strategies.purgeErrors) {
            if (
                strategies.purgeErrors.enabled !== undefined &&
                typeof strategies.purgeErrors.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.enabled",
                    expected: "boolean",
                    actual: typeof strategies.purgeErrors.enabled,
                })
            }

            if (
                strategies.purgeErrors.turns !== undefined &&
                typeof strategies.purgeErrors.turns !== "number"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.turns",
                    expected: "number",
                    actual: typeof strategies.purgeErrors.turns,
                })
            }
            // Warn if turns is 0 or negative - will be clamped to 1
            if (
                typeof strategies.purgeErrors.turns === "number" &&
                strategies.purgeErrors.turns < 1
            ) {
                errors.push({
                    key: "strategies.purgeErrors.turns",
                    expected: "positive number (>= 1)",
                    actual: `${strategies.purgeErrors.turns} (will be clamped to 1)`,
                })
            }
            if (
                strategies.purgeErrors.protectedTools !== undefined &&
                !Array.isArray(strategies.purgeErrors.protectedTools)
            ) {
                errors.push({
                    key: "strategies.purgeErrors.protectedTools",
                    expected: "string[]",
                    actual: typeof strategies.purgeErrors.protectedTools,
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
    pruneNotification: "detailed",
    pruneNotificationType: "chat",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    compaction: {
        automatic: true,
        preset: "light",
        summaryEffort: "inherit",
        custom: { ...DEFAULT_CUSTOM_COMPACTION },
    },
    manualMode: {
        enabled: false,
        automaticStrategies: true,
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    experimental: {
        allowSubAgents: false,
        customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
        mode: "range",
        permission: "allow",
        showCompression: false,
        summaryBuffer: true,
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
        protectTags: false,
        protectUserMessages: false,
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [],
        },
    },
}

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "better-compact.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "better-compact.json")

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
  "$schema": "https://raw.githubusercontent.com/AshishKumar4/opencode-better-compact/master/better-compact.schema.json"
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
  "$schema": "https://raw.githubusercontent.com/AshishKumar4/opencode-better-compact/master/better-compact.schema.json"
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

function mergeStrategies(
    base: PluginConfig["strategies"],
    override?: Partial<PluginConfig["strategies"]>,
): PluginConfig["strategies"] {
    if (!override) {
        return base
    }

    return {
        deduplication: {
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
            protectedTools: [
                ...new Set([
                    ...base.deduplication.protectedTools,
                    ...(override.deduplication?.protectedTools ?? []),
                ]),
            ],
        },
        purgeErrors: {
            enabled: override.purgeErrors?.enabled ?? base.purgeErrors.enabled,
            turns: override.purgeErrors?.turns ?? base.purgeErrors.turns,
            protectedTools: [
                ...new Set([
                    ...base.purgeErrors.protectedTools,
                    ...(override.purgeErrors?.protectedTools ?? []),
                ]),
            ],
        },
    }
}

function mergeCompress(
    base: PluginConfig["compress"],
    override?: CompressOverride,
): PluginConfig["compress"] {
    if (!override) {
        return base
    }

    return {
        mode: override.mode ?? base.mode,
        permission: override.permission ?? base.permission,
        showCompression: override.showCompression ?? base.showCompression,
        summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
        maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
        minContextLimit: override.minContextLimit ?? base.minContextLimit,
        modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits,
        modelMinLimits: override.modelMinLimits ?? base.modelMinLimits,
        nudgeFrequency: override.nudgeFrequency ?? base.nudgeFrequency,
        iterationNudgeThreshold: override.iterationNudgeThreshold ?? base.iterationNudgeThreshold,
        nudgeForce: override.nudgeForce ?? base.nudgeForce,
        protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
        protectTags: override.protectTags ?? base.protectTags,
        protectUserMessages: override.protectUserMessages ?? base.protectUserMessages,
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
        protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
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
        customPrompts: override.customPrompts ?? base.customPrompts,
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        compaction: {
            automatic: config.compaction.automatic,
            preset: config.compaction.preset,
            summaryEffort: config.compaction.summaryEffort,
            custom: { ...config.compaction.custom },
        },
        manualMode: {
            enabled: config.manualMode.enabled,
            automaticStrategies: config.manualMode.automaticStrategies,
        },
        turnProtection: { ...config.turnProtection },
        experimental: { ...config.experimental },
        protectedFilePatterns: [...config.protectedFilePatterns],
        compress: {
            ...config.compress,
            modelMaxLimits: { ...config.compress.modelMaxLimits },
            modelMinLimits: { ...config.compress.modelMinLimits },
            protectedTools: [...config.compress.protectedTools],
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools],
            },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                protectedTools: [...config.strategies.purgeErrors.protectedTools],
            },
        },
    }
}

function mergeLayer(config: PluginConfig, data: Record<string, any>): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        autoUpdate: data.autoUpdate ?? config.autoUpdate,
        debug: data.debug ?? config.debug,
        pruneNotification: data.pruneNotification ?? config.pruneNotification,
        pruneNotificationType: data.pruneNotificationType ?? config.pruneNotificationType,
        commands: mergeCommands(config.commands, data.commands as any),
        compaction: mergeCompaction(config.compaction, data.compaction as any),
        manualMode: mergeManualMode(config.manualMode, data.manualMode as any),
        turnProtection: {
            enabled: data.turnProtection?.enabled ?? config.turnProtection.enabled,
            turns: data.turnProtection?.turns ?? config.turnProtection.turns,
        },
        experimental: mergeExperimental(config.experimental, data.experimental as any),
        protectedFilePatterns: [
            ...new Set([...config.protectedFilePatterns, ...(data.protectedFilePatterns ?? [])]),
        ],
        compress: mergeCompress(config.compress, data.compress as CompressOverride),
        strategies: mergeStrategies(config.strategies, data.strategies as any),
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
            unsafeLayer = true
            if (options?.warnings !== false) {
                showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
            }
            continue
        }
        config = mergeLayer(config, result.data)
    }

    if (unsafeLayer) {
        config.enabled = false
        config.commands.enabled = false
        config.compaction.automatic = false
        config.compress.permission = "deny"
        config.autoUpdate = false
    }

    return config
}
