import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { resolveCompactionProfile, type CompactionConfig } from "./compaction-settings"
import { assignMessageRefs } from "./message-ids"
import {
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
} from "./messages"
import type { PromptStore } from "./prompts"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import {
    handleContextCommand,
    handleHelpCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "./commands"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { checkSession, ensureSessionInitialized, saveSessionState } from "./state"
import {
    buildBoundaryContextPlan,
    applyBoundaryContextManagement,
    formatBoundaryReport,
    appendBoundaryLog,
    completeBoundaryJob,
    failBoundaryJob,
    setBoundaryStage,
    startBoundaryJob,
    storeBoundaryPlan,
    summarizeBoundaryJobs,
    updateBoundaryCounters,
    updateBoundaryPercent,
    writeBoundaryTranscript,
    applyBoundaryPlanSnapshot,
} from "./boundary"
import { getCurrentParams, getCurrentTokenUsage } from "./token-utils"
import { sendIgnoredMessage } from "./ui/notification"

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        if (input.model?.limit?.context) {
            state.modelContextLimit = input.model.limit.context
            logger.debug("Cached model context limit", { limit: state.modelContextLimit })
        }
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
    workingDirectory = process.cwd(),
    loadConfig: () => PluginConfig = () => config,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        const currentConfig = loadConfig()
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        const sessionId = messages.find((message) => typeof message.info?.sessionID === "string")?.info.sessionID
        if (sessionId && state.boundary.scratchSessionIds.has(sessionId)) {
            return
        }

        await checkSession(client, state, logger, output.messages, currentConfig.manualMode.enabled)

        syncCompressPermissionState(state, currentConfig, hostPermissions, output.messages)

        if (state.isSubAgent && !currentConfig.experimental.allowSubAgents) {
            return
        }

        stripHallucinations(output.messages)
        assignMessageRefs(state, output.messages)
        if (state.boundary.activePlan && state.boundary.activePlan.sessionId === state.sessionId) {
            const applied = applyBoundaryPlanSnapshot(output.messages, state.boundary.activePlan)
            if (applied) {
                stripStaleMetadata(output.messages)
                if (state.sessionId) {
                    await logger.saveContext(state.sessionId, output.messages)
                }
                return
            }
        }
        const forced = state.sessionId !== null && state.boundary.compactingSessionId === state.sessionId
        const boundaryPlan =
            currentConfig.compaction.automatic || forced
                ? await applyBoundaryContextManagement({
                      state,
                      logger,
                      directory: workingDirectory,
                      messages: output.messages,
                      force: forced,
                      profile: resolveCompactionProfile(currentConfig),
                  })
                : null
        if (boundaryPlan) {
            await saveSessionState(state, logger)
        }
        stripStaleMetadata(output.messages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "better-compact" || input.command === "better-compact-settings") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = filterMessages(messagesResponse.data || messagesResponse)

            await ensureSessionInitialized(
                client,
                state,
                input.sessionID,
                logger,
                messages,
                config.manualMode.enabled,
            )

            syncCompressPermissionState(state, config, hostPermissions, messages)

            const effectivePermission = compressPermission(state, config)
            if (effectivePermission === "deny") {
                output.parts.length = 0
                return
            }

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const subcommand = input.command === "better-compact-settings" ? "settings" : args[0]?.toLowerCase() || "compress"
            const subArgs = input.command === "better-compact-settings" ? args : args.slice(1)

            const commandCtx = {
                client,
                state,
                config,
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

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    ...commandCtx,
                    args: subArgs,
                    workingDirectory,
                })
                output.parts.length = 0
                return
            }

            if (subcommand === "compress") {
                void runBetterCompact({
                    client,
                    state,
                    logger,
                    config,
                    workingDirectory,
                    sessionId: input.sessionID,
                    messages,
                }).catch((error) => {
                    logger.error("Better Compact command job failed", {
                        error: error instanceof Error ? error.message : String(error),
                    })
                })
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
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
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

        const messagesResponse = await client.session.messages({
            path: { id: input.sessionID },
        })
        const messages = filterMessages(messagesResponse.data || messagesResponse)
        await ensureSessionInitialized(client, state, input.sessionID, logger, messages, config.manualMode.enabled)
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
        syncCompressPermissionState(state, config, hostPermissions, messages)
        if (compressPermission(state, config) === "deny") {
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

        void runBetterCompact({
            client,
            state,
            logger,
            config,
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
        }).catch((error) => {
            failBoundaryJob(state, error instanceof Error ? error.message : String(error))
            void saveSessionState(state, logger)
            logger.error("Better Compact TUI job failed", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }
}

async function runBetterCompact(input: {
    client: any
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
            clearedTokens: Math.max(0, plan.beforeTokens - plan.afterPruneTokens),
        })
        setBoundaryStage(input.state, "scan", "completed", `Projected ${formatCompactTokens(plan.beforeTokens)} -> ${formatCompactTokens(plan.afterPruneTokens)}`)
        appendBoundaryLog(input.state, `Projected context reduction: ${formatCompactTokens(plan.beforeTokens)} -> ${formatCompactTokens(plan.afterPruneTokens)}.`)
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
            if (stage.name === "assistant-runs" && plan.summaryJobs.length > 0) {
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
                clearedTokens: Math.max(0, plan.beforeTokens - stage.afterTokens),
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
                state: input.state,
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
                stageClearedTokens: Math.max(0, plan.beforeTokens - finalPlan.afterPruneTokens),
                clearedTokens: Math.max(0, finalPlan.beforeTokens - finalPlan.afterPruneTokens),
            })
            await saveProgress()
        }

        setBoundaryStage(input.state, "store", "running", "Persisting virtual context plan")
        await saveProgress()
        storeBoundaryPlan(input.state, finalPlan)
        updateBoundaryCounters(input.state, {
            afterTokens: finalPlan.afterPruneTokens,
            currentTokens: finalPlan.afterPruneTokens,
            targetTokens: finalPlan.targetTokens,
            clearedTokens: Math.max(0, finalPlan.beforeTokens - finalPlan.afterPruneTokens),
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
        const message = error instanceof Error ? error.message : String(error)
        appendBoundaryLog(input.state, `Failed: ${message}`)
        failBoundaryJob(input.state, message)
        await saveSessionState(input.state, input.logger)
        await sendIgnoredMessage(input.client, input.sessionId, `Better Compact failed: ${message}`, params, input.logger)
        throw error
    }
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

export function createEventHandler(state: SessionState, logger: Logger, client?: any) {
    return async (input: { event: any }) => {
        if (input.event.type === "session.compacted") {
            state.boundary.compactingSessionId = null
            return
        }

        const eventTime =
            typeof input.event?.time === "number" && Number.isFinite(input.event.time)
                ? input.event.time
                : typeof input.event?.properties?.time === "number" &&
                    Number.isFinite(input.event.properties.time)
                  ? input.event.properties.time
                  : undefined

        if (input.event.type !== "message.part.updated") {
            return
        }

        const part = input.event.properties?.part
        if (part?.type !== "tool" || part.tool !== "compress") {
            return
        }

        if (part.state.status === "pending") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const startedAt = eventTime ?? Date.now()
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            if (state.compressionTiming.startsByCallId.has(key)) {
                return
            }
            state.compressionTiming.startsByCallId.set(key, startedAt)
            logger.debug("Recorded compression start", {
                messageID: part.messageID,
                callID: part.callID,
                startedAt,
            })
            return
        }

        if (part.state.status === "completed") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const key = buildCompressionTimingKey(part.messageID, part.callID)
            const start = consumeCompressionStart(state, part.messageID, part.callID)
            const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
            if (typeof durationMs !== "number") {
                return
            }

            state.compressionTiming.pendingByCallId.set(key, {
                messageId: part.messageID,
                callId: part.callID,
                durationMs,
            })

            const updates = applyPendingCompressionDurations(state)
            if (updates === 0) {
                return
            }

            await saveSessionState(state, logger)

            logger.info("Attached compression time to blocks", {
                messageID: part.messageID,
                callID: part.callID,
                blocks: updates,
                durationMs,
            })
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            state.compressionTiming.startsByCallId.delete(
                buildCompressionTimingKey(part.messageID, part.callID),
            )
        }
    }
}
