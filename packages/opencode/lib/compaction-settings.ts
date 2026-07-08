export type CompactionPreset = "light" | "moderate" | "max" | "custom"

export interface CompactionCustomSettings {
    triggerPercent: number
    targetPercent: number
    recentToolTokens: number
    summarizerConcurrency: number
}

export interface CompactionConfig {
    preset: CompactionPreset
    custom: CompactionCustomSettings
}

export interface CompactionProfile extends CompactionCustomSettings {
    preset: CompactionPreset
}

export const COMPACTION_PRESETS: Record<Exclude<CompactionPreset, "custom">, CompactionProfile> = {
    light: {
        preset: "light",
        triggerPercent: 85,
        targetPercent: 35,
        recentToolTokens: 40_000,
        summarizerConcurrency: 4,
    },
    moderate: {
        preset: "moderate",
        triggerPercent: 75,
        targetPercent: 25,
        recentToolTokens: 30_000,
        summarizerConcurrency: 6,
    },
    max: {
        preset: "max",
        triggerPercent: 60,
        targetPercent: 15,
        recentToolTokens: 12_000,
        summarizerConcurrency: 8,
    },
}

export const DEFAULT_CUSTOM_COMPACTION: CompactionCustomSettings = {
    triggerPercent: 85,
    targetPercent: 35,
    recentToolTokens: 40_000,
    summarizerConcurrency: 4,
}

export function normalizeCompactionCustom(input: Partial<CompactionCustomSettings> | undefined): CompactionCustomSettings {
    return {
        triggerPercent: clampPercent(input?.triggerPercent, DEFAULT_CUSTOM_COMPACTION.triggerPercent),
        targetPercent: clampPercent(input?.targetPercent, DEFAULT_CUSTOM_COMPACTION.targetPercent),
        recentToolTokens: clampInteger(input?.recentToolTokens, 0, 200_000, DEFAULT_CUSTOM_COMPACTION.recentToolTokens),
        summarizerConcurrency: clampInteger(input?.summarizerConcurrency, 1, 16, DEFAULT_CUSTOM_COMPACTION.summarizerConcurrency),
    }
}

export function resolveCompactionProfile(config: { compaction: CompactionConfig }, override?: Partial<CompactionConfig>): CompactionProfile {
    const preset = normalizePreset(override?.preset ?? config.compaction.preset)
    const custom = normalizeCompactionCustom({
        ...config.compaction.custom,
        ...(override?.custom ?? {}),
    })
    if (preset === "custom") return { preset, ...custom }
    return COMPACTION_PRESETS[preset]
}

export function normalizePreset(value: unknown): CompactionPreset {
    return value === "light" || value === "moderate" || value === "max" || value === "custom" ? value : "light"
}

function clampPercent(value: unknown, fallback: number): number {
    return clampInteger(value, 1, 99, fallback)
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback
    return Math.max(min, Math.min(max, numeric))
}
