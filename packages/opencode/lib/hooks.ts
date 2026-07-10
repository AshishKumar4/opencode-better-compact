import { resolveCompactionProfile, type CompactionConfig } from "@better-compact/core"
import type { RuntimeState, SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import {
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
} from "./messages"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import { handleContextCommand, handleHelpCommand, handleStatsCommand } from "./commands"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { saveSessionState } from "./state"
import {
    buildBoundaryContextPlan,
    findMatchingBoundaryPlan,
    formatBoundaryReport,
    appendBoundaryLog,
    applyBoundaryPlanSnapshot,
    completeBoundaryJob,
    failBoundaryJob,
    processBoundaryTransform,
    setBoundaryStage,
    startBoundaryJob,
    storeBoundaryPlan,
    summarizeBoundaryJobs,
    updateBoundaryCounters,
    updateBoundaryPercent,
    writeBoundaryTranscript,
    type BoundaryContextPlan,
} from "./boundary"
import { getCurrentParams, getCurrentTokenUsage } from "./token-utils"
import { sendIgnoredMessage } from "./ui/notification"

export function createSystemPromptHandler(
    runtime: RuntimeState,
    logger: Logger,
    config: PluginConfig,
) {
    return async (
        input: {
            sessionID?: string
            model: { id?: string; providerID?: string; limit: { context: number } }
        },
        output: { system: string[] },
    ) => {
        if (input.model?.limit?.context) {
            if (input.model.providerID && input.model.id) {
                runtime.setModelLimit(input.model.providerID, input.model.id, input.model.limit.context)
            }
            if (input.sessionID) {
                runtime.get(input.sessionID).modelContextLimit = input.model.limit.context
            }
            logger.debug("Cached model context limit", { limit: input.model.limit.context })
        }
    }
}

export function createChatMessageTransformHandler(
    client: any,
    runtime: RuntimeState,
    logger: Logger,
    config: PluginConfig,
    hostPermissions: HostPermissionSnapshot,
    workingDirectory = process.cwd(),
    loadConfig: () => PluginConfig = () => config,
) {
    // The incoming array is narrowed to WithParts by filterMessagesInPlace,
    // the single trust boundary between the host SDK's message types and ours.
    return async (_input: {}, output: { messages: unknown[] }) => {
        const currentConfig = loadConfig()
        if (!currentConfig.enabled) return
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        const sessionId = messages.find((message) => typeof message.info?.sessionID === "string")?.info.sessionID
        if (!sessionId || runtime.isScratch(sessionId)) {
            return
        }

        const state = await runtime.prepare(sessionId, messages, currentConfig.manualMode.enabled)
        const currentParams = getCurrentParams(state, messages, logger)
        if (currentParams.providerId && currentParams.modelId) {
            state.modelContextLimit = await runtime.resolveModelLimit(
                currentParams.providerId,
                currentParams.modelId,
            )
        }

        syncCompressPermissionState(state, currentConfig, hostPermissions, messages)

        if (state.isSubAgent && !currentConfig.experimental.allowSubAgents) {
            return
        }

        stripHallucinations(messages)

        if (!state.boundary.activePlan && messages.length >= 3) {
            const inherited = await findMatchingBoundaryPlan(sessionId, messages, workingDirectory, logger)
            if (inherited) {
                state.boundary.activePlan = inherited
                await saveSessionState(state, logger).catch((error) => {
                    logger.warn("Failed to persist inherited Better Compact plan", {
                        error: error instanceof Error ? error.message : String(error),
                    })
                })
            }
        }

        const automaticAllowed =
            currentConfig.compaction.automatic && compressPermission(state, currentConfig) === "allow"
        if (automaticAllowed) {
            await runAutomaticTransform({
                client,
                runtime,
                state,
                logger,
                config: currentConfig,
                workingDirectory,
                sessionId,
                messages,
                params: currentParams,
            })
        } else if (state.boundary.activePlan && compressPermission(state, currentConfig) !== "deny") {
            // Automatic replanning is off; a stale-but-valid plan still beats
            // sending raw history.
            applyBoundaryPlanSnapshot(messages, state.boundary.activePlan, { allowRegrown: true })
        }
        stripStaleMetadata(messages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, messages)
        }
    }
}

// One automatic compaction at a time per session: the winner builds and
// commits the plan; a concurrent transform waits and replays the committed
// plan onto its own request. Any failure degrades to an unpruned request.
async function runAutomaticTransform(input: {
    client: any
    runtime: RuntimeState
    state: SessionState
    logger: Logger
    config: PluginConfig
    workingDirectory: string
    sessionId: string
    messages: WithParts[]
    params: ReturnType<typeof getCurrentParams>
}): Promise<void> {
    try {
        let planned: BoundaryContextPlan | null = null
        const started = input.runtime.startCompaction(input.sessionId, async () => {
            planned = await processBoundaryTransform({
                state: input.state,
                logger: input.logger,
                config: input.config,
                directory: input.workingDirectory,
                messages: input.messages,
                providerReportedTokens: getCurrentTokenUsage(input.state, input.messages),
                summarize: (jobs) =>
                    summarizeBoundaryJobs({
                        client: input.client,
                        runtime: input.runtime,
                        logger: input.logger,
                        parentSessionId: input.sessionId,
                        jobs,
                        params: input.params,
                        concurrency: resolveCompactionProfile(input.config).summarizerConcurrency,
                    }),
            })
        })
        const active = input.runtime.activeCompaction(input.sessionId)
        if (active) await active
        if (started) {
            if (planned) await showAutomaticCompactionToast(input.client, planned)
            return
        }
        const latestPlan = input.state.boundary.activePlan
        if (latestPlan) {
            applyBoundaryPlanSnapshot(input.messages, latestPlan, { allowRegrown: true })
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        input.logger.error("Automatic Better Compact failed; request continues unpruned", { error: message })
        try {
            await input.client.tui.showToast({
                body: {
                    title: "Better Compact failed",
                    message,
                    variant: "error",
                    duration: 7000,
                },
            })
        } catch {}
    }
}

async function showAutomaticCompactionToast(client: any, plan: BoundaryContextPlan): Promise<void> {
    try {
        await client.tui.showToast({
            body: {
                title: "Better Compact applied",
                message: `${formatCompactTokens(visibleBeforeTokens(plan))} → ${formatCompactTokens(plan.afterPruneTokens)} estimated active history`,
                variant: "success",
                duration: 5000,
            },
        })
    } catch {}
}

export function createCommandExecuteHandler(
    client: any,
    runtime: RuntimeState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
    loadConfig: () => PluginConfig = () => config,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        const currentConfig = loadConfig()
        if (!currentConfig.enabled || !currentConfig.commands.enabled) {
            return
        }

        if (input.command === "better-compact" || input.command === "better-compact-settings") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = filterMessages(messagesResponse.data || messagesResponse)

            const state = await runtime.prepare(input.sessionID, messages, currentConfig.manualMode.enabled)

            syncCompressPermissionState(state, currentConfig, hostPermissions, messages)

            const effectivePermission = compressPermission(state, currentConfig)
            if (effectivePermission === "deny") {
                output.parts.length = 0
                return
            }

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const subcommand = input.command === "better-compact-settings" ? "settings" : args[0]?.toLowerCase() || "compress"

            const commandCtx = {
                client,
                state,
                config: currentConfig,
                logger,
                sessionId: input.sessionID,
                messages,
            }

            if (subcommand === "context") {
                await handleContextCommand(commandCtx)
                output.parts.length = 0
                return
            }

            if (subcommand === "stats") {
                await handleStatsCommand(commandCtx)
                output.parts.length = 0
                return
            }

            if (subcommand === "help") {
                await handleHelpCommand(commandCtx)
                output.parts.length = 0
                return
            }

            if (subcommand === "settings") {
                const params = getCurrentParams(state, messages, logger)
                await sendIgnoredMessage(
                    client,
                    input.sessionID,
                    "Open Better Compact settings from the command palette with /better-compact-settings.",
                    params,
                    logger,
                )
                output.parts.length = 0
                return
            }

            if (subcommand === "compress") {
                const started = runtime.startCompaction(input.sessionID, async () => {
                    try {
                        await runBetterCompact({
                            client,
                            runtime,
                            state,
                            logger,
                            config: currentConfig,
                            workingDirectory,
                            sessionId: input.sessionID,
                            messages,
                        })
                    } catch (error) {
                        logger.error("Better Compact command job failed", {
                            error: error instanceof Error ? error.message : String(error),
                        })
                    }
                })
                if (!started) {
                    const params = getCurrentParams(state, messages, logger)
                    await sendIgnoredMessage(
                        client,
                        input.sessionID,
                        "Better Compact is already running for this session.",
                        params,
                        logger,
                    )
                }
                output.parts.length = 0
                return
            }

            await handleHelpCommand(commandCtx)
            output.parts.length = 0
            return
        }
    }
}

export function createChatMessageHandler(
    client: any,
    runtime: RuntimeState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
    loadConfig: () => PluginConfig = () => config,
) {
    return async (
        input: { sessionID: string; agent?: string; model?: { providerID?: string; modelID?: string }; variant?: string },
        output: { message: any; parts: any[] },
    ) => {
        const sentinel = output.parts.find(
            (part) =>
                part?.type === "text" &&
                part?.ignored === true &&
                part?.metadata?.betterCompact === "run",
        )
        if (!sentinel) return
        const currentConfig = loadConfig()
        if (!currentConfig.enabled) return

        const messagesResponse = await client.session.messages({
            path: { id: input.sessionID },
        })
        const messages = filterMessages(messagesResponse.data || messagesResponse)
        const state = await runtime.prepare(input.sessionID, messages, currentConfig.manualMode.enabled)
        const jobId = validBoundaryJobId(sentinel.metadata?.jobId)
        const jobStartedAt = validBoundaryJobStartedAt(sentinel.metadata?.jobStartedAt)
        const contextLimit = validBoundaryCounter(sentinel.metadata?.contextLimit)
        const currentTokens = validBoundaryCounter(sentinel.metadata?.currentTokens)
        const targetTokens = validBoundaryCounter(sentinel.metadata?.targetTokens)
        const requestedSummaryVariant = validSummaryVariant(sentinel.metadata?.summaryVariant)
        const messageModel = output.message?.model
        const providerID = input.model?.providerID ?? messageModel?.providerID
        const modelID = input.model?.modelID ?? messageModel?.modelID
        const summaryVariant =
            requestedSummaryVariant &&
            providerID === sentinel.metadata?.summaryProviderID &&
            modelID === sentinel.metadata?.summaryModelID
                ? requestedSummaryVariant
                : undefined
        syncCompressPermissionState(state, currentConfig, hostPermissions, messages)
        if (compressPermission(state, currentConfig) === "deny") {
            startBoundaryJob(state, {
                id: jobId,
                sessionId: input.sessionID,
                startedAt: jobStartedAt,
                counters: {
                    beforeTokens: currentTokens,
                    currentTokens,
                    targetTokens,
                    contextLimit,
                },
            })
            failBoundaryJob(state, "Compression is denied by OpenCode permissions.")
            await saveSessionState(state, logger)
            return
        }

        const started = runtime.startCompaction(input.sessionID, async () => {
            try {
                await runBetterCompact({
                    client,
                    runtime,
                    state,
                    logger,
                    config: currentConfig,
                    workingDirectory,
                    sessionId: input.sessionID,
                    messages,
                    params: {
                        providerId: providerID,
                        modelId: modelID,
                        agent: input.agent ?? output.message?.agent,
                        variant: input.variant ?? output.message?.variant,
                    },
                    compaction: sentinel.metadata?.compaction as Partial<CompactionConfig> | undefined,
                    contextLimit,
                    currentTokens,
                    jobId,
                    jobStartedAt,
                    summaryVariant,
                })
            } catch (error) {
                logger.error("Better Compact TUI job failed", {
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        })
        if (!started) {
            try {
                await client.tui.showToast({
                    body: {
                        title: "Better Compact already running",
                        message: "Wait for the active compaction to finish.",
                        variant: "warning",
                        duration: 5000,
                    },
                })
            } catch {}
        }
    }
}

async function runBetterCompact(input: {
    client: any
    runtime: RuntimeState
    state: SessionState
    logger: Logger
    config: PluginConfig
    workingDirectory: string
    sessionId: string
    messages: WithParts[]
    params?: {
        providerId: string | undefined
        modelId: string | undefined
        agent: string | undefined
        variant: string | undefined
    }
    compaction?: Partial<CompactionConfig>
    contextLimit?: number
    currentTokens?: number
    jobId?: string
    jobStartedAt?: number
    summaryVariant?: string
}): Promise<void> {
    const params = input.params ?? getCurrentParams(input.state, input.messages, input.logger)
    const profile = resolveCompactionProfile(input.config, input.compaction)
    const contextLimit = input.contextLimit && input.contextLimit > 0 ? input.contextLimit : (input.state.modelContextLimit ?? 200_000)
    const reportedCurrentTokens = input.currentTokens && input.currentTokens > 0 ? input.currentTokens : getCurrentTokenUsage(input.state, input.messages)
    startBoundaryJob(input.state, {
        id: input.jobId,
        sessionId: input.sessionId,
        startedAt: input.jobStartedAt,
        counters: {
            beforeTokens: reportedCurrentTokens,
            currentTokens: reportedCurrentTokens,
            targetTokens: Math.round((contextLimit * profile.targetPercent) / 100),
            contextLimit,
            stageClearedTokens: 0,
            clearedTokens: 0,
        },
    })
    updateBoundaryCounters(input.state, {
        messages: input.messages.length,
        beforeTokens: reportedCurrentTokens,
        currentTokens: reportedCurrentTokens,
        contextLimit,
        stageClearedTokens: 0,
        clearedTokens: 0,
    })
    const saveProgress = async () => {
        updateBoundaryPercent(input.state)
        await saveSessionState(input.state, input.logger)
    }

    const previousActivePlan = input.state.boundary.activePlan
    try {
        setBoundaryStage(input.state, "load", "running", "Reading current OpenCode session history")
        updateBoundaryCounters(input.state, { messages: input.messages.length })
        appendBoundaryLog(input.state, `Loaded ${input.messages.length} messages from current session.`)
        setBoundaryStage(input.state, "load", "completed", `${input.messages.length} messages loaded`)
        await saveProgress()

        setBoundaryStage(input.state, "scan", "running", "Estimating context and selecting pruning stages")
        await saveProgress()
        const plan = buildBoundaryContextPlan(input.messages, {
            contextLimit,
            force: true,
            triggerRatio: profile.triggerPercent / 100,
            targetRatio: profile.targetPercent / 100,
            recentToolResultBudgetTokens: profile.recentToolTokens,
            providerReportedTokens: reportedCurrentTokens,
            priorPlan: input.state.boundary.activePlan ?? undefined,
        })
        if (!plan) {
            setBoundaryStage(input.state, "scan", "skipped", "No eligible historical context found")
            appendBoundaryLog(input.state, "Better Compact did not find enough context to prune.")
            completeBoundaryJob(input.state, "No pruning needed")
            await saveSessionState(input.state, input.logger)
            await sendIgnoredMessage(
                input.client,
                input.sessionId,
                "Better Compact did not find enough context to prune.",
                params,
                input.logger,
            )
            return
        }

        updateBoundaryCounters(input.state, {
            beforeTokens: plan.beforeTokens,
            afterTokens: plan.afterPruneTokens,
            currentTokens: plan.beforeTokens,
            targetTokens: plan.targetTokens,
            contextLimit: plan.contextLimit,
            stageClearedTokens: 0,
            clearedTokens: Math.max(0, visibleBeforeTokens(plan) - plan.afterPruneTokens),
        })
        setBoundaryStage(input.state, "scan", "completed", `Estimated active history ${formatCompactTokens(visibleBeforeTokens(plan))} -> ${formatCompactTokens(plan.afterPruneTokens)}`)
        appendBoundaryLog(input.state, `Estimated active-history reduction: ${formatCompactTokens(visibleBeforeTokens(plan))} -> ${formatCompactTokens(plan.afterPruneTokens)}.`)
        await saveProgress()

        setBoundaryStage(input.state, "transcript", "running", "Writing raw transcript reference")
        await saveProgress()
        await writeBoundaryTranscript(input.workingDirectory, plan, input.logger)
        updateBoundaryCounters(input.state, { archivedMessages: plan.transcript.messageIds.length })
        setBoundaryStage(input.state, "transcript", "completed", `${plan.transcript.messageIds.length} messages archived`)
        appendBoundaryLog(input.state, `Transcript written: ${plan.transcript.relativePath}`)
        await saveProgress()

        const appliedStageIds = new Set<string>(plan.stages.map((stage) => stage.name))
        for (const stage of plan.stages) {
            if (
                plan.summaryJobs.length > 0 &&
                (stage.name === "assistant-runs" || stage.name === "prefix-summary")
            ) {
                continue
            }
            const status = stage.status === "skipped" ? "skipped" : "completed"
            setBoundaryStage(
                input.state,
                stage.name,
                status,
                stage.clearedTokens > 0
                    ? `Cleared ${formatCompactTokens(stage.clearedTokens)}`
                    : stage.status === "skipped"
                      ? "No matching context"
                      : "Applied",
                {
                    beforeTokens: stage.beforeTokens,
                    afterTokens: stage.afterTokens,
                    clearedTokens: stage.clearedTokens,
                    changedMessages: stage.changedMessages,
                    changedParts: stage.changedParts,
                },
            )
            updateBoundaryCounters(input.state, {
                currentTokens: stage.afterTokens,
                stageClearedTokens: stage.clearedTokens,
                clearedTokens: Math.max(0, visibleBeforeTokens(plan) - stage.afterTokens),
            })
            appendBoundaryLog(input.state, `${stage.label}: ${formatCompactTokens(stage.clearedTokens)} cleared.`)
            await saveProgress()
        }

        for (const skippedStage of ["skills", "tools-old", "reasoning", "tools-remaining", "assistant-runs", "prefix-summary"]) {
            if (appliedStageIds.has(skippedStage)) continue
            setBoundaryStage(input.state, skippedStage, "skipped", "Not needed")
        }
        await saveProgress()

        let finalPlan = plan
        if (plan.summaryJobs.length > 0) {
            setBoundaryStage(input.state, "assistant-runs", "running", `${plan.summaryJobs.length} assistant turn summaries queued`)
            updateBoundaryCounters(input.state, {
                summaryJobsTotal: plan.summaryJobs.length,
                summaryJobsDone: 0,
                summaryJobsSucceeded: 0,
                summaryJobsFailed: 0,
                stageClearedTokens: 0,
            })
            appendBoundaryLog(input.state, `Running ${plan.summaryJobs.length} assistant-turn summarizers in parallel.`)
            await saveProgress()
            const assistantSummaries = await summarizeBoundaryJobs({
                client: input.client,
                runtime: input.runtime,
                logger: input.logger,
                parentSessionId: input.sessionId,
                jobs: plan.summaryJobs,
                params: {
                    ...params,
                    variant: input.summaryVariant ?? params.variant,
                },
                concurrency: profile.summarizerConcurrency,
                onProgress: async (event) => {
                    updateBoundaryCounters(input.state, {
                        summaryJobsTotal: event.total,
                        summaryJobsDone: event.done,
                        summaryJobsSucceeded: event.succeeded,
                        summaryJobsFailed: event.failed,
                    })
                    appendBoundaryLog(
                        input.state,
                        event.ok
                            ? `Summarized assistant turn ${event.done}/${event.total}: ${event.rangeStartMessageId} -> ${event.rangeEndMessageId}.`
                            : `Assistant turn summary failed ${event.done}/${event.total}: ${event.rangeStartMessageId} -> ${event.rangeEndMessageId}.`,
                    )
                    await saveProgress()
                },
            })
            if (Object.keys(assistantSummaries).length > 0) {
                finalPlan =
                    buildBoundaryContextPlan(input.messages, {
                        contextLimit,
                        force: true,
                        assistantSummaries,
                        triggerRatio: profile.triggerPercent / 100,
                        targetRatio: profile.targetPercent / 100,
                        recentToolResultBudgetTokens: profile.recentToolTokens,
                        providerReportedTokens: reportedCurrentTokens,
                        priorPlan: input.state.boundary.activePlan ?? undefined,
                    }) ?? plan
            }
            setBoundaryStage(
                input.state,
                "assistant-runs",
                "completed",
                `${Object.keys(assistantSummaries).length}/${plan.summaryJobs.length} summaries accepted`,
            )
            updateBoundaryCounters(input.state, {
                currentTokens: finalPlan.afterPruneTokens,
                stageClearedTokens: Math.max(0, visibleBeforeTokens(plan) - finalPlan.afterPruneTokens),
                clearedTokens: Math.max(0, visibleBeforeTokens(finalPlan) - finalPlan.afterPruneTokens),
            })
            const finalPrefixStage = finalPlan.stages.find((stage) => stage.name === "prefix-summary")
            if (finalPrefixStage) {
                setBoundaryStage(
                    input.state,
                    "prefix-summary",
                    finalPrefixStage.status === "failed" ? "failed" : "completed",
                    finalPrefixStage.clearedTokens > 0
                        ? `Cleared ${formatCompactTokens(finalPrefixStage.clearedTokens)}`
                        : "Applied",
                    {
                        beforeTokens: finalPrefixStage.beforeTokens,
                        afterTokens: finalPrefixStage.afterTokens,
                        clearedTokens: finalPrefixStage.clearedTokens,
                        changedMessages: finalPrefixStage.changedMessages,
                        changedParts: finalPrefixStage.changedParts,
                    },
                )
            } else {
                setBoundaryStage(input.state, "prefix-summary", "skipped", "Not needed")
            }
            await saveProgress()
        }

        setBoundaryStage(input.state, "store", "running", "Persisting virtual context plan")
        await saveProgress()
        storeBoundaryPlan(input.state, finalPlan, input.messages)
        updateBoundaryCounters(input.state, {
            afterTokens: finalPlan.afterPruneTokens,
            currentTokens: finalPlan.afterPruneTokens,
            targetTokens: finalPlan.targetTokens,
            clearedTokens: Math.max(0, visibleBeforeTokens(finalPlan) - finalPlan.afterPruneTokens),
        })
        setBoundaryStage(input.state, "store", "completed", "Virtual context plan stored")
        appendBoundaryLog(input.state, "Stored Better Compact plan for future model requests.")
        await saveProgress()

        setBoundaryStage(input.state, "report", "running", "Publishing final report")
        await saveProgress()
        await sendIgnoredMessage(
            input.client,
            input.sessionId,
            formatBoundaryReport(finalPlan, getCurrentTokenUsage(input.state, input.messages)),
            params,
            input.logger,
        )
        setBoundaryStage(input.state, "report", "completed", "Final report published")
        completeBoundaryJob(input.state, "Complete")
        await saveSessionState(input.state, input.logger)
        input.logger.info("Better Compact virtual compaction plan stored", {
            sessionId: input.sessionId,
            rangeHash: finalPlan.rangeHash,
            requiresCustomCompaction: finalPlan.requiresCustomCompaction,
        })
    } catch (error) {
        input.state.boundary.activePlan = previousActivePlan
        const message = error instanceof Error ? error.message : String(error)
        appendBoundaryLog(input.state, `Failed: ${message}`)
        failBoundaryJob(input.state, message)
        await saveSessionState(input.state, input.logger).catch(() => {})
        await sendIgnoredMessage(input.client, input.sessionId, `Better Compact failed: ${message}`, params, input.logger)
        throw error
    }
}

// Provider totals include invisible overhead (system prompt, tool schemas,
// cache accounting); the plan's overhead delta backs it out so user-facing
// numbers describe the visible active history on the estimate scale.
function visibleBeforeTokens(plan: BoundaryContextPlan): number {
    return Math.max(0, plan.beforeTokens - plan.overheadTokens)
}

function validBoundaryJobId(value: unknown): string | undefined {
    return typeof value === "string" && /^bc_[a-zA-Z0-9]{1,64}$/.test(value) ? value : undefined
}

function validBoundaryJobStartedAt(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function validBoundaryCounter(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
        ? value
        : undefined
}

function validSummaryVariant(value: unknown): string | undefined {
    return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
        ? value
        : undefined
}

function formatCompactTokens(tokens: number): string {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K`
    return String(tokens)
}

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        output.text = stripHallucinationsFromString(output.text)
    }
}

export function createEventHandler(runtime: RuntimeState, logger: Logger) {
    return async (input: { event: any }) => {
        if (input.event.type === "session.compacted") {
            const sessionId = input.event.properties?.sessionID
            const state = typeof sessionId === "string" ? runtime.peek(sessionId) : undefined
            if (!state) return
            // Native compaction rewrote this session's history; the stored
            // plan and job describe context that no longer exists.
            state.boundary.activePlan = null
            state.boundary.job = null
            await saveSessionState(state, logger).catch((error) => {
                logger.warn("Failed to persist state reset after native compaction", {
                    error: error instanceof Error ? error.message : String(error),
                })
            })
            return
        }

        if (input.event.type === "session.deleted") {
            const sessionId = input.event.properties?.info?.id
            if (typeof sessionId === "string") runtime.evict(sessionId)
        }
    }
}
