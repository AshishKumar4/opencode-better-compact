import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
    buildPlan,
    COMPACTION_PRESETS,
    createEngine,
    DEFAULT_CUSTOM_COMPACTION,
    normalizeCompactionCustom,
    resolveCompactionProfile,
    summarizeJobs,
    toPlanSnapshot,
    writeTranscript,
    type BoundaryContextPlan,
    type CompactionConfig,
    type CompactionCustomSettings,
    type CompactionPreset,
    type EnginePorts,
    type Logger,
    type Turn,
} from "@better-compact/core"
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    sessionEntryToContextMessages,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { piCodec, piSpec } from "./codec"
import { createPlanStore } from "./plan-store"
import { createSummarizer } from "./summarizer"
import { createTranscriptStore } from "./transcripts"

const CONFIG_FILE = "better-compact.json"
const DEFAULT_CONFIG: CompactionConfig = {
    automatic: true,
    preset: "light",
    summaryEffort: "inherit",
    custom: { ...DEFAULT_CUSTOM_COMPACTION },
}

type CompactionConfigOverride = Omit<Partial<CompactionConfig>, "custom"> & {
    custom?: Partial<CompactionCustomSettings>
}

const logger: Logger = {
    info() {},
    debug() {},
    warn: (message, data) => console.error(`[better-compact] ${message}`, data ?? ""),
    error: (message, data) => console.error(`[better-compact] ${message}`, data ?? ""),
}

export default function betterCompact(pi: ExtensionAPI) {
    const plans = createPlanStore((customType, data) => pi.appendEntry(customType, data))
    const summarizing = new Set<string>()
    let config = mergeCompactionConfig()
    let profile = COMPACTION_PRESETS.light
    let warnedNativeCompaction = false

    const enginePorts = (ctx: ExtensionContext): EnginePorts => ({
        transcripts: createTranscriptStore(ctx.sessionManager.getSessionDir()),
        plans,
        logger,
    })

    const planInputs = (ctx: ExtensionContext, contextLimit: number) => ({
        contextLimit,
        triggerRatio: profile.triggerPercent / 100,
        targetRatio: profile.targetPercent / 100,
        recentToolResultBudgetTokens: profile.recentToolTokens,
        sessionKey: ctx.sessionManager.getSessionId(),
        citablePath: createTranscriptStore(ctx.sessionManager.getSessionDir()).citablePath,
    })

    pi.on("session_start", async (_event, ctx) => {
        plans.restore(ctx.sessionManager)
        const messages = ctx.sessionManager
            .buildContextEntries()
            .flatMap(sessionEntryToContextMessages)
        if (messages.length > 0) {
            plans.adopt(ctx.sessionManager.getSessionId(), piCodec.encode(messages))
        }
        config = await loadCompactionConfig(ctx)
        profile = resolveCompactionProfile({ compaction: config })
    })

    // Better Compact prunes before native compaction would trigger, but the
    // knob belongs to the user: warn once instead of mutating settings.
    pi.on("session_before_compact", (_event, ctx) => {
        if (warnedNativeCompaction) return
        warnedNativeCompaction = true
        ctx.ui.notify(
            'Native compaction is about to rewrite history Better Compact already prunes; set "compaction": { "enabled": false } in pi settings.',
            "warning",
        )
    })

    pi.on("context", async (event, ctx) => {
        try {
            if (!config.automatic) return
            const contextLimit = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow
            if (!contextLimit || contextLimit <= 0) return
            const sessionKey = ctx.sessionManager.getSessionId()
            const turns = piCodec.encode(event.messages)
            plans.adopt(sessionKey, turns)
            const result = await createEngine(piSpec, enginePorts(ctx)).process({
                sessionKey,
                turns,
                contextLimit,
                triggerRatio: profile.triggerPercent / 100,
                targetRatio: profile.targetPercent / 100,
                recentToolResultBudgetTokens: profile.recentToolTokens,
            })
            if (result.outcome === "unchanged") return
            if (result.outcome === "planned" && result.plan.summaryJobs.length > 0) {
                void upgradePlanWithSummaries(ctx, turns, contextLimit, result.plan)
            }
            return { messages: piCodec.decode(result.turns, event.messages) }
        } catch (error) {
            // A failed prune must never break the request; it goes out unpruned.
            logger.error("Better Compact context transform failed", { error: errorText(error) })
        }
    })

    pi.registerCommand("better-compact", {
        description: "Prune older context now (Better Compact)",
        handler: async (_args, ctx) => {
            const contextLimit = ctx.model?.contextWindow
            if (!contextLimit || contextLimit <= 0) {
                ctx.ui.notify("Better Compact: no active model context window.", "warning")
                return
            }
            const sessionKey = ctx.sessionManager.getSessionId()
            if (summarizing.has(sessionKey)) {
                ctx.ui.notify("Better Compact is already summarizing this session.", "info")
                return
            }
            const messages = ctx.sessionManager
                .buildContextEntries()
                .flatMap(sessionEntryToContextMessages)
            if (messages.length === 0) {
                ctx.ui.notify("Better Compact: nothing to prune yet.", "info")
                return
            }

            const turns = piCodec.encode(messages)
            plans.adopt(sessionKey, turns)
            const transcripts = createTranscriptStore(ctx.sessionManager.getSessionDir())
            const priorPlan = await plans.load(sessionKey)
            const inputs = {
                ...planInputs(ctx, contextLimit),
                force: true,
                priorPlan: priorPlan ?? undefined,
            }
            ctx.ui.setStatus("better-compact", "Better Compact: planning…")
            try {
                const plan = buildPlan(turns, inputs, piSpec)
                if (!plan) {
                    ctx.ui.notify("Better Compact: nothing to prune yet.", "info")
                    return
                }
                await writeTranscript(plan, { transcripts, logger, codec: piCodec })
                let finalPlan = plan
                if (plan.summaryJobs.length > 0) {
                    summarizing.add(sessionKey)
                    try {
                        ctx.ui.setStatus(
                            "better-compact",
                            `Better Compact: running ${plan.summaryJobs.length} summary jobs…`,
                        )
                        const summaries = await summarizeJobs({
                            jobs: plan.summaryJobs,
                            summarizer: createSummarizer(ctx, logger),
                            logger,
                            concurrency: profile.summarizerConcurrency,
                        })
                        if (Object.keys(summaries).length > 0) {
                            finalPlan =
                                buildPlan(
                                    turns,
                                    {
                                        ...inputs,
                                        priorPlan: toPlanSnapshot(plan),
                                        assistantSummaries: summaries,
                                    },
                                    piSpec,
                                ) ?? plan
                        }
                    } finally {
                        summarizing.delete(sessionKey)
                    }
                }
                await plans.save(sessionKey, toPlanSnapshot(finalPlan))
                ctx.ui.notify(
                    `Better Compact: ${formatTokens(finalPlan.beforeTokens)} -> ${formatTokens(finalPlan.afterPruneTokens)} tokens; applies from the next request.`,
                    "info",
                )
            } finally {
                ctx.ui.setStatus("better-compact", undefined)
            }
        },
    })

    pi.registerCommand("better-compact-preset", {
        description: "Set the Better Compact preset (light, moderate, or max)",
        handler: async (args, ctx) => {
            const preset = commandPreset(args.trim())
            if (!preset) {
                ctx.ui.notify(
                    "Usage: /better-compact-preset <light|moderate|max>",
                    "warning",
                )
                return
            }
            const path = join(getAgentDir(), CONFIG_FILE)
            try {
                const current = (await readConfigObject(path)) ?? {}
                await writeConfigObject(path, { ...current, preset })
                config = mergeCompactionConfig(config, { preset })
                profile = resolveCompactionProfile({ compaction: config })
                ctx.ui.notify(`Better Compact preset set to ${preset}.`, "info")
            } catch (error) {
                logger.warn("Better Compact preset update failed", {
                    path,
                    error: errorText(error),
                })
                ctx.ui.notify(`Better Compact: could not write ${path}.`, "warning")
            }
        },
    })

    // Summary jobs never block a request: they land in the plan in
    // the background and upgrade the replayed prefix from the next request.
    async function upgradePlanWithSummaries(
        ctx: ExtensionContext,
        turns: Turn[],
        contextLimit: number,
        plan: BoundaryContextPlan,
    ): Promise<void> {
        const sessionKey = plan.sessionId
        if (summarizing.has(sessionKey)) return
        summarizing.add(sessionKey)
        try {
            const summaries = await summarizeJobs({
                jobs: plan.summaryJobs,
                summarizer: createSummarizer(ctx, logger),
                logger,
                concurrency: profile.summarizerConcurrency,
            })
            if (Object.keys(summaries).length === 0) return
            // A stale ctx after a session switch throws here; the catch drops
            // the upgrade instead of writing into the wrong session.
            if (ctx.sessionManager.getSessionId() !== sessionKey) return
            const upgraded = buildPlan(
                turns,
                {
                    ...planInputs(ctx, contextLimit),
                    force: true,
                    priorPlan: toPlanSnapshot(plan),
                    assistantSummaries: { ...plan.assistantSummaries, ...summaries },
                },
                piSpec,
            )
            if (upgraded) await plans.save(sessionKey, toPlanSnapshot(upgraded))
        } catch (error) {
            logger.warn("Better Compact summary upgrade failed", { error: errorText(error) })
        } finally {
            summarizing.delete(sessionKey)
        }
    }
}

async function loadCompactionConfig(ctx: ExtensionContext): Promise<CompactionConfig> {
    const globalPath = join(getAgentDir(), CONFIG_FILE)
    const global = await readConfigOverride(globalPath)
    // Project files are executable policy: only honor them after pi has
    // established trust for the working tree.
    const project = ctx.isProjectTrusted()
        ? await readConfigOverride(join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE))
        : null
    return mergeCompactionConfig(global ?? {}, project ?? {})
}

async function readConfigOverride(path: string): Promise<CompactionConfigOverride | null> {
    try {
        const value = await readConfigObject(path)
        return value ? parseCompactionConfig(value) : null
    } catch (error) {
        logger.warn("Better Compact config ignored", { path, error: errorText(error) })
        return null
    }
}

async function readConfigObject(path: string): Promise<Record<string, unknown> | null> {
    try {
        const value: unknown = JSON.parse(await readFile(path, "utf-8"))
        if (!isRecord(value)) throw new Error("config must be a JSON object")
        return value
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null
        throw error
    }
}

async function writeConfigObject(path: string, value: Record<string, unknown>): Promise<void> {
    await mkdir(getAgentDir(), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 })
        await rename(temporary, path)
    } catch (error) {
        await rm(temporary, { force: true })
        throw error
    }
}

function parseCompactionConfig(value: Record<string, unknown>): CompactionConfigOverride {
    return {
        automatic: typeof value.automatic === "boolean" ? value.automatic : undefined,
        preset: isCompactionPreset(value.preset) ? value.preset : undefined,
        summaryEffort: isSummaryEffort(value.summaryEffort) ? value.summaryEffort : undefined,
        custom: parseCustomConfig(value.custom),
    }
}

function parseCustomConfig(value: unknown): Partial<CompactionCustomSettings> {
    if (!isRecord(value)) return {}
    const custom: Partial<CompactionCustomSettings> = {}
    if (typeof value.triggerPercent === "number" && Number.isFinite(value.triggerPercent)) {
        custom.triggerPercent = value.triggerPercent
    }
    if (typeof value.targetPercent === "number" && Number.isFinite(value.targetPercent)) {
        custom.targetPercent = value.targetPercent
    }
    if (typeof value.recentToolTokens === "number" && Number.isFinite(value.recentToolTokens)) {
        custom.recentToolTokens = value.recentToolTokens
    }
    if (
        typeof value.summarizerConcurrency === "number" &&
        Number.isFinite(value.summarizerConcurrency)
    ) {
        custom.summarizerConcurrency = value.summarizerConcurrency
    }
    return custom
}

function mergeCompactionConfig(...overrides: CompactionConfigOverride[]): CompactionConfig {
    let config: CompactionConfig = {
        ...DEFAULT_CONFIG,
        custom: { ...DEFAULT_CONFIG.custom },
    }
    for (const override of overrides) {
        config = {
            automatic: override.automatic ?? config.automatic,
            preset: override.preset ?? config.preset,
            summaryEffort: override.summaryEffort ?? config.summaryEffort,
            custom: normalizeCompactionCustom({ ...config.custom, ...override.custom }),
        }
    }
    return config
}

function commandPreset(value: string): Exclude<CompactionPreset, "custom"> | null {
    return value === "light" || value === "moderate" || value === "max" ? value : null
}

function isCompactionPreset(value: unknown): value is CompactionPreset {
    return value === "light" || value === "moderate" || value === "max" || value === "custom"
}

function isSummaryEffort(value: unknown): value is CompactionConfig["summaryEffort"] {
    return (
        value === "inherit" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "max"
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error
}

function formatTokens(tokens: number): string {
    return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K` : String(tokens)
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
