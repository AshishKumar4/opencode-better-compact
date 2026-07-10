import {
    buildPlan,
    COMPACTION_PRESETS,
    createEngine,
    summarizeJobs,
    toPlanSnapshot,
    writeTranscript,
    type BoundaryContextPlan,
    type EnginePorts,
    type Logger,
    type Turn,
} from "@better-compact/core"
import {
    sessionEntryToContextMessages,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { piCodec, piSpec } from "./codec"
import { createPlanStore } from "./plan-store"
import { createSummarizer } from "./summarizer"
import { createTranscriptStore } from "./transcripts"

// pi exposes no settings surface to extensions, so the compaction profile is
// the light preset rather than user-configurable.
const profile = COMPACTION_PRESETS.light

const logger: Logger = {
    info() {},
    debug() {},
    warn: (message, data) => console.error(`[better-compact] ${message}`, data ?? ""),
    error: (message, data) => console.error(`[better-compact] ${message}`, data ?? ""),
}

export default function betterCompact(pi: ExtensionAPI) {
    const plans = createPlanStore((customType, data) => pi.appendEntry(customType, data))
    const summarizing = new Set<string>()
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

    pi.on("session_start", (_event, ctx) => {
        plans.restore(ctx.sessionManager)
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
            const contextLimit = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow
            if (!contextLimit || contextLimit <= 0) return
            const sessionKey = ctx.sessionManager.getSessionId()
            const turns = piCodec.encode(event.messages)
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
            const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)
            if (messages.length === 0) {
                ctx.ui.notify("Better Compact: nothing to prune yet.", "info")
                return
            }

            const turns = piCodec.encode(messages)
            const transcripts = createTranscriptStore(ctx.sessionManager.getSessionDir())
            const inputs = { ...planInputs(ctx, contextLimit), force: true }
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
                            `Better Compact: summarizing ${plan.summaryJobs.length} assistant runs…`,
                        )
                        const summaries = await summarizeJobs({
                            jobs: plan.summaryJobs,
                            summarizer: createSummarizer(ctx, logger),
                            logger,
                            concurrency: profile.summarizerConcurrency,
                        })
                        if (Object.keys(summaries).length > 0) {
                            finalPlan = buildPlan(turns, { ...inputs, assistantSummaries: summaries }, piSpec) ?? plan
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

    // Assistant-run summaries never block a request: they land in the plan in
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

function formatTokens(tokens: number): string {
    return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K` : String(tokens)
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
