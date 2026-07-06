import { createHash } from "node:crypto"
import { join } from "node:path"
import type { Logger } from "../logger"
import type { CompactionProfile } from "../compaction-settings"
import type { SessionState, WithParts } from "../state"
import { estimateOpenCodeMessages, estimateOpenCodeToolPart } from "../context-estimate"
import { estimateOpenCodeTokens } from "../token-utils"
import { writePrivateFile } from "../private-storage"
import { boundaryRangeHash, boundarySourceHash } from "./fingerprint"

const TRIGGER_RATIO = 0.85
const TARGET_RATIO = 0.3
const MIN_TAIL_MESSAGES = 3
const MIN_TAIL_USER_TURNS = 2
const ASSISTANT_TEXT_PREVIEW_CHARS = 1_200
const RECENT_TOOL_RESULT_BUDGET_TOKENS = 40_000
const TRANSCRIPT_ROOT = ".opencode/better-compact/sessions"

type MessagePart = WithParts["parts"][number]
type BoundaryStageStatus = "applied" | "skipped" | "target-met" | "failed"

export type BoundaryStageName =
    | "reasoning"
    | "skills"
    | "tools-old"
    | "tools-remaining"
    | "assistant-runs"
    | "prefix-summary"

export interface BoundaryStageReport {
    name: BoundaryStageName
    label: string
    beforeTokens: number
    afterTokens: number
    clearedTokens: number
    changedMessages: number
    changedParts: number
    status: BoundaryStageStatus
}

export interface BoundarySummaryJob {
    key: string
    rangeStartMessageId: string
    rangeEndMessageId: string
    transcriptRelativePath: string
    prompt: string
}

interface TransformContext {
    transcriptRelativePath: string
    latestTodoCallId: string | null
    assistantSummaries: Record<string, string>
    assistantSummaryKeys: Set<string>
}

interface StageMutationResult {
    changedMessages: Set<string>
    changedParts: number
}

interface MessageEstimator {
    reservedTokens: number
}

export interface BoundaryContextOptions {
    contextLimit?: number
    reservedTokens?: number
    triggerRatio?: number
    targetRatio?: number
    minTailMessages?: number
    minTailUserTurns?: number
    recentToolResultBudgetTokens?: number
    force?: boolean
    assistantSummaries?: Record<string, string>
    prefixSummary?: string
    providerReportedTokens?: number
    triggerUsageTokens?: number
    priorPlan?: NonNullable<SessionState["boundary"]["activePlan"]>
}

export interface BoundaryTranscriptArtifact {
    relativePath: string
    absolutePath?: string
    content: string
    messageIds: string[]
    messages?: WithParts[]
}

export interface BoundaryContextPlan {
    sessionId: string
    rangeHash: string
    contextLimit: number
    beforeTokens: number
    reportedBeforeTokens?: number
    visibleBeforeTokens: number
    afterPruneTokens: number
    triggerTokens: number
    targetTokens: number
    rawTailStartIndex: number
    rawTailStartMessageId: string
    sourceLastMessageId: string
    sourceFingerprint: string
    requiresCustomCompaction: boolean
    preservedToolCallIds: string[]
    transcript: BoundaryTranscriptArtifact
    stages: BoundaryStageReport[]
    summaryJobs: BoundarySummaryJob[]
    assistantSummaryKeys: string[]
    assistantSummaries: Record<string, string>
    prefixSummary?: string
}

export function buildBoundaryContextPlan(
    messages: WithParts[],
    options: BoundaryContextOptions = {},
): BoundaryContextPlan | null {
    const contextLimit = options.contextLimit
    if (!contextLimit || contextLimit <= 0 || messages.length === 0) return null

    const reservedTokens = Math.max(0, options.reservedTokens ?? 0)
    const triggerRatio = options.triggerRatio ?? TRIGGER_RATIO
    const targetRatio = options.targetRatio ?? TARGET_RATIO
    const estimator = createMessageEstimator(reservedTokens)
    const estimatedBeforeTokens = estimateMessages(messages, estimator)
    const beforeTokens = options.providerReportedTokens && options.providerReportedTokens > 0
        ? options.providerReportedTokens
        : estimatedBeforeTokens
    const triggerUsageTokens =
        options.triggerUsageTokens ?? Math.max(beforeTokens, estimatedBeforeTokens)
    const triggerTokens = Math.floor(contextLimit * triggerRatio)
    if (!options.force && triggerUsageTokens < triggerTokens) return null

    const rawTailStartIndex = findRawTailStartIndex(
        messages,
        Math.max(1, options.minTailMessages ?? MIN_TAIL_MESSAGES),
        Math.max(1, options.minTailUserTurns ?? MIN_TAIL_USER_TURNS),
    )
    const compactedRange = messages.slice(0, rawTailStartIndex)
    if (compactedRange.length === 0) return null

    const transcriptRelativePath = transcriptPath(messages, compactedRange)
    const assistantSummaries = {
        ...(options.priorPlan?.assistantSummaries ?? {}),
        ...(options.assistantSummaries ?? {}),
    }
    const working = cloneMessages(messages)
    const preservedToolCallIds = findRecentToolCallTail(
        compactedRange,
        estimator,
        options.recentToolResultBudgetTokens ?? RECENT_TOOL_RESULT_BUDGET_TOKENS,
    )
    applyPreservationFloor(
        messages,
        preservedToolCallIds,
        options.priorPlan,
    )
    const stages: BoundaryStageReport[] = []
    const summaryJobs: BoundarySummaryJob[] = []
    const assistantSummaryKeys = new Set<string>(options.priorPlan?.assistantSummaryKeys ?? [])
    const priorStages = new Set(
        (options.priorPlan?.stages ?? [])
            .filter((stage) => stage.status !== "skipped" && stage.status !== "failed")
            .map((stage) => stage.name),
    )
    const range = {
        rawTailStartIndex,
        transcriptRelativePath,
        reservedTokens,
        estimator,
        triggerTokens,
        targetTokens: Math.floor(contextLimit * targetRatio),
    }

    runStage(stages, working, range, "skills", "Pruned loaded skills", () =>
        stripSkillToolParts(working, rawTailStartIndex),
    )
    runStage(stages, working, range, "tools-old", "Pruned old tool calls/results", () =>
        stripToolParts(working, rawTailStartIndex, transcriptRelativePath, preservedToolCallIds),
    )
    if (isBelowTrigger(working, estimator, triggerTokens) && !priorStages.has("reasoning")) {
        markTargetMet(stages)
    } else {
        runStage(stages, working, range, "reasoning", "Pruned thinking tokens", () =>
            stripReasoningParts(working, rawTailStartIndex),
        )
    }
    if (
        isBelowTrigger(working, estimator, triggerTokens) &&
        !priorStages.has("tools-remaining")
    ) {
        markTargetMet(stages)
    } else {
        runStage(stages, working, range, "tools-remaining", "Pruned remaining tool calls/results", () =>
            stripToolParts(working, rawTailStartIndex, transcriptRelativePath, new Set()),
        )
    }
    if (
        isBelowTrigger(working, estimator, triggerTokens) &&
        !priorStages.has("assistant-runs")
    ) {
        markTargetMet(stages)
    } else {
        runStage(stages, working, range, "assistant-runs", "Summarized assistant turns", () =>
            compactAssistantRuns(working, rawTailStartIndex, {
                transcriptRelativePath,
                latestTodoCallId: findLatestTodoCallId(compactedRange),
                assistantSummaries,
                assistantSummaryKeys,
            }, summaryJobs, estimator, range.targetTokens),
        )
    }

    let requiresCustomCompaction = false
    const priorTailIndex = options.priorPlan
        ? messages.findIndex(
              (message) => message.info.id === options.priorPlan?.rawTailStartMessageId,
          )
        : -1
    const expandedPrefix = priorTailIndex >= 0 && rawTailStartIndex > priorTailIndex
    let prefixSummary =
        options.prefixSummary ??
        (expandedPrefix ? undefined : options.priorPlan?.prefixSummary)
    if (
        !isBelowTrigger(working, estimator, triggerTokens) ||
        options.priorPlan?.requiresCustomCompaction
    ) {
        const currentTailStartIndex = working.findIndex(
            (message) => message.info.id === messages[rawTailStartIndex]?.info.id,
        )
        const beforePrefix = estimateMessages(working, estimator)
        const result = applyPrefixSummary(
            working,
            currentTailStartIndex > 0 ? currentTailStartIndex : rawTailStartIndex,
            transcriptRelativePath,
            prefixSummary,
        )
        const afterPrefix = estimateMessages(working, estimator)
        prefixSummary = result.prefixSummary
        requiresCustomCompaction = result.changedMessages.size > 0
        stages.push({
            name: "prefix-summary",
            label: "Last-resort prefix summary",
            beforeTokens: beforePrefix,
            afterTokens: afterPrefix,
            clearedTokens: Math.max(0, beforePrefix - afterPrefix),
            changedMessages: result.changedMessages.size,
            changedParts: result.changedParts,
            status: afterPrefix <= range.targetTokens ? "applied" : "failed",
        })
    }

    const plan: BoundaryContextPlan = {
        sessionId: messages[0]?.info.sessionID ?? "unknown-session",
        rangeHash: boundaryRangeHash(compactedRange),
        contextLimit,
        beforeTokens,
        reportedBeforeTokens:
            options.providerReportedTokens && options.providerReportedTokens > 0
                ? options.providerReportedTokens
                : undefined,
        visibleBeforeTokens: estimatedBeforeTokens,
        afterPruneTokens: estimateMessages(working, estimator),
        triggerTokens,
        targetTokens: range.targetTokens,
        rawTailStartIndex,
        rawTailStartMessageId: messages[rawTailStartIndex]?.info.id ?? messages.at(-1)?.info.id ?? "",
        sourceLastMessageId: lastContextBearingMessageId(messages),
        sourceFingerprint: boundarySourceHash(messages),
        requiresCustomCompaction,
        preservedToolCallIds: [...preservedToolCallIds],
        transcript: {
            relativePath: transcriptRelativePath,
            content: "",
            messageIds: compactedRange.map((message) => message.info.id),
            messages: compactedRange,
        },
        stages,
        summaryJobs,
        assistantSummaryKeys: [...assistantSummaryKeys],
        assistantSummaries,
        prefixSummary,
    }
    plan.afterPruneTokens = estimateMessages(transformMessages(messages, rawTailStartIndex, plan), estimator)
    return plan
}

function lastContextBearingMessageId(messages: WithParts[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (
            message.info.role === "user" &&
            message.parts.length > 0 &&
            message.parts.every(isIgnoredPart)
        ) {
            continue
        }
        return message.info.id
    }
    return ""
}

export function applyBoundaryContextPlan(messages: WithParts[], plan: BoundaryContextPlan): void {
    const transformed = transformMessages(messages, plan.rawTailStartIndex, plan)
    messages.length = 0
    messages.push(...transformed)
}

export function applyBoundaryPlanSnapshot(
    messages: WithParts[],
    plan: NonNullable<SessionState["boundary"]["activePlan"]>,
): boolean {
    const rawTailStartIndex = messages.findIndex((message) => message.info.id === plan.rawTailStartMessageId)
    if (rawTailStartIndex <= 0) return false
    if (
        plan.sourceLastMessageId &&
        boundaryRangeHash(messages.slice(0, rawTailStartIndex)) !== plan.rangeHash
    ) {
        return false
    }
    const transformed = transformMessages(messages, rawTailStartIndex, {
        sessionId: plan.sessionId,
        rangeHash: plan.rangeHash,
        contextLimit: plan.contextLimit ?? Math.max(plan.beforeTokens, plan.targetTokens, 1),
        beforeTokens: plan.beforeTokens,
        reportedBeforeTokens: plan.reportedBeforeTokens,
        visibleBeforeTokens: plan.visibleBeforeTokens ?? plan.beforeTokens,
        afterPruneTokens: plan.afterPruneTokens,
        triggerTokens: plan.triggerTokens,
        targetTokens: plan.targetTokens,
        rawTailStartIndex,
        rawTailStartMessageId: plan.rawTailStartMessageId,
        sourceLastMessageId: plan.sourceLastMessageId ?? plan.rawTailStartMessageId,
        sourceFingerprint: plan.sourceFingerprint ?? "",
        requiresCustomCompaction: plan.requiresCustomCompaction,
        preservedToolCallIds: plan.preservedToolCallIds ?? [],
        assistantSummaryKeys: plan.assistantSummaryKeys ?? Object.keys(plan.assistantSummaries ?? {}),
        transcript: {
            relativePath: plan.transcriptRelativePath,
            content: "",
            messageIds: [],
        },
        stages: (plan.stages ?? []) as BoundaryStageReport[],
        summaryJobs: [],
        assistantSummaries: plan.assistantSummaries ?? {},
        prefixSummary: plan.prefixSummary,
    })
    messages.length = 0
    messages.push(...transformed)
    return true
}

export function storeBoundaryPlan(state: SessionState, plan: BoundaryContextPlan): void {
    state.boundary.activePlan = {
        sessionId: plan.sessionId,
        rangeHash: plan.rangeHash,
        contextLimit: plan.contextLimit,
        rawTailStartMessageId: plan.rawTailStartMessageId,
        sourceLastMessageId: plan.sourceLastMessageId,
        sourceFingerprint: plan.sourceFingerprint,
        compactedMessageCount: plan.transcript.messageIds.length,
        transcriptRelativePath: plan.transcript.relativePath,
        beforeTokens: plan.beforeTokens,
        reportedBeforeTokens: plan.reportedBeforeTokens,
        visibleBeforeTokens: plan.visibleBeforeTokens,
        afterPruneTokens: plan.afterPruneTokens,
        triggerTokens: plan.triggerTokens,
        targetTokens: plan.targetTokens,
        requiresCustomCompaction: plan.requiresCustomCompaction,
        preservedToolCallIds: plan.preservedToolCallIds,
        assistantSummaryKeys: plan.assistantSummaryKeys,
        assistantSummaries: plan.assistantSummaries,
        prefixSummary: plan.prefixSummary,
        stages: plan.stages,
        createdAt: Date.now(),
    }
}

export function formatBoundaryStartedReport(): string {
    return [
        "╭─────────────────────────────────────────────────────────────────────────╮",
        "│                       Better Compact Started                           │",
        "╰─────────────────────────────────────────────────────────────────────────╯",
        "",
        "  Stage 1/7  Pruning loaded skills",
        "  Stage 2/7  Pruning old tool calls/results while preserving recent tool tail",
        "  Stage 3/7  Pruning thinking tokens if needed",
        "  Stage 4/7  Pruning remaining tool calls/results if needed",
        "  Stage 5/7  Summarizing assistant turns if needed",
        "  Stage 6/7  Last-resort prefix summary if needed",
        "  Stage 7/7  Storing and reporting the Better Compact plan",
    ].join("\n")
}

export function formatBoundaryProgressReport(stage: string, detail: string): string {
    return [`▣ Better Compact`, `→ ${stage}`, `→ ${detail}`].join("\n")
}

export function formatBoundaryReport(plan: BoundaryContextPlan, actualCurrentTokens?: number): string {
    const before = actualCurrentTokens && actualCurrentTokens > 0 ? actualCurrentTokens : plan.beforeTokens
    const now = plan.afterPruneTokens
    const visibleBefore = plan.visibleBeforeTokens
    const reduced = Math.max(0, visibleBefore - now)
    const reductionPercent = visibleBefore > 0 ? Math.round((reduced / visibleBefore) * 100) : 0
    const stageRows = plan.stages
        .filter((stage) => stage.status !== "skipped" || stage.clearedTokens > 0)
        .map((stage) => {
            const icon = stage.clearedTokens > 0 ? "✓" : stage.status === "target-met" ? "✓" : "-"
            const detail = stage.clearedTokens > 0 ? `-${formatTokenCount(stage.clearedTokens)}` : "not needed"
            return `  ${icon} ${stage.label.padEnd(38)} ${detail}`
        })
    return [
        "╭─────────────────────────────────────────────────────────────────────────╮",
        "│                       Better Compact Complete                          │",
        "╰─────────────────────────────────────────────────────────────────────────╯",
        "",
        "  Context window",
        formatContextWindowLine("Before", before, plan.contextLimit),
        formatContextWindowLine("Now", now, plan.contextLimit, "projected"),
        "",
        `  Estimated active-history reduction ${formatTokenCount(reduced)} (${reductionPercent}%)`,
        "",
        "  Actions",
        ...(stageRows.length > 0 ? stageRows : ["  (no stages applied)"]),
        "",
        "  Reference",
        `  ${plan.transcript.relativePath}`,
        `  ${plan.transcript.messageIds.length} archived messages; raw tail starts at ${plan.rawTailStartMessageId}`,
        Object.keys(plan.assistantSummaries).length > 0
            ? `  ${Object.keys(plan.assistantSummaries).length} assistant summaries accepted`
            : undefined,
        "",
        "  Note: Now is Better Compact's projected active-history size. OpenCode's footer",
        "  updates after the next provider response and also includes system/tool schemas,",
        "  cache accounting, output, reasoning, and provider overhead.",
    ]
        .filter((line): line is string => line !== undefined)
        .join("\n")
}

function formatContextWindowLine(label: string, tokens: number, limit: number, suffix?: string): string {
    const width = 18
    const boundedLimit = Math.max(1, limit)
    const ratio = tokens / boundedLimit
    const filled = Math.max(0, Math.min(width, Math.round(Math.min(1, ratio) * width)))
    const percent = Math.round(ratio * 100)
    const suffixText = suffix ? ` ${suffix}` : ""
    return `  ${label.padEnd(6)} ${formatTokenCount(tokens).padStart(7)} / ${formatTokenCount(boundedLimit).padEnd(7)} [${"█".repeat(filled)}${"░".repeat(width - filled)}] ${String(percent).padStart(3)}%${suffixText}`
}

export async function applyBoundaryContextManagement(input: {
    state: SessionState
    logger: Logger
    directory: string
    messages: WithParts[]
    force?: boolean
    profile?: CompactionProfile
    providerReportedTokens?: number
    triggerUsageTokens?: number
    priorPlan?: NonNullable<SessionState["boundary"]["activePlan"]>
    summarize?: (jobs: BoundarySummaryJob[]) => Promise<Record<string, string>>
}): Promise<BoundaryContextPlan | null> {
    const options: BoundaryContextOptions = {
        contextLimit: input.state.modelContextLimit ?? (input.force ? 200_000 : undefined),
        force: input.force,
        triggerRatio: input.profile ? input.profile.triggerPercent / 100 : undefined,
        targetRatio: input.profile ? input.profile.targetPercent / 100 : undefined,
        recentToolResultBudgetTokens: input.profile?.recentToolTokens,
        providerReportedTokens: input.providerReportedTokens,
        triggerUsageTokens: input.triggerUsageTokens,
        priorPlan: input.priorPlan,
    }
    let plan = buildBoundaryContextPlan(input.messages, options)
    if (!plan) return null
    if (input.summarize && plan.summaryJobs.length > 0) {
        const assistantSummaries = await input.summarize(plan.summaryJobs)
        if (Object.keys(assistantSummaries).length > 0) {
            plan =
                buildBoundaryContextPlan(input.messages, {
                    ...options,
                    assistantSummaries,
                }) ?? plan
        }
    }

    await writeBoundaryTranscript(input.directory, plan, input.logger)
    input.logger.info("Applied Better Compact staged pruning", {
        sessionId: plan.sessionId,
        beforeTokens: plan.beforeTokens,
        afterPruneTokens: plan.afterPruneTokens,
        transcript: plan.transcript.relativePath,
        stages: plan.stages.map((stage) => stage.name),
    })
    return plan
}

function runStage(
    stages: BoundaryStageReport[],
    messages: WithParts[],
    range: {
        reservedTokens: number
        estimator: MessageEstimator
        triggerTokens: number
    },
    name: BoundaryStageName,
    label: string,
    mutate: () => StageMutationResult,
): void {
    const beforeTokens = estimateMessages(messages, range.estimator)
    const result = mutate()
    const afterTokens = estimateMessages(messages, range.estimator)
    stages.push({
        name,
        label,
        beforeTokens,
        afterTokens,
        clearedTokens: Math.max(0, beforeTokens - afterTokens),
        changedMessages: result.changedMessages.size,
        changedParts: result.changedParts,
        status: result.changedMessages.size > 0 || result.changedParts > 0 ? "applied" : "skipped",
    })
}

function markTargetMet(stages: BoundaryStageReport[]): void {
    const last = stages.at(-1)
    if (!last || last.status === "target-met") return
    last.status = "target-met"
}

function isBelowTrigger(messages: WithParts[], estimator: MessageEstimator, triggerTokens: number): boolean {
    return estimateMessages(messages, estimator) < triggerTokens
}

function findRecentToolCallTail(
    messages: WithParts[],
    estimator: MessageEstimator,
    budgetTokens: number,
): Set<string> {
    const preserved = new Set<string>()
    if (budgetTokens <= 0) return preserved

    let used = 0
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
        const message = messages[messageIndex]
        if (message.info.role !== "assistant") continue
        for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
            const part = message.parts[partIndex]
            if (part.type !== "tool") continue
            if (part.tool === "skill") continue
            if (!part.callID || preserved.has(part.callID)) continue

            const cost = Math.max(1, Math.round(estimateOpenCodeToolPart(part)))
            if (used >= budgetTokens) return preserved
            if (preserved.size > 0 && used + cost > budgetTokens) return preserved
            preserved.add(part.callID)
            used += cost
        }
    }
    return preserved
}

function applyPreservationFloor(
    messages: WithParts[],
    preservedToolCallIds: Set<string>,
    priorPlan: BoundaryContextOptions["priorPlan"],
): void {
    if (!priorPlan) return
    const priorTailIndex = messages.findIndex(
        (message) => message.info.id === priorPlan.rawTailStartMessageId,
    )
    if (priorTailIndex <= 0) return
    const previouslyPreserved = new Set(priorPlan.preservedToolCallIds ?? [])
    for (let index = 0; index < priorTailIndex; index++) {
        for (const part of messages[index].parts) {
            if (
                part.type === "tool" &&
                preservedToolCallIds.has(part.callID) &&
                !previouslyPreserved.has(part.callID)
            ) {
                preservedToolCallIds.delete(part.callID)
            }
        }
    }
}

function stripReasoningParts(messages: WithParts[], rawTailStartIndex: number): StageMutationResult {
    const changedMessages = new Set<string>()
    let changedParts = 0
    for (let index = 0; index < rawTailStartIndex; index++) {
        const message = messages[index]
        if (!message || message.info.role !== "assistant") continue
        const before = message.parts.length
        message.parts = message.parts.filter((part) => part.type !== "reasoning")
        const removed = before - message.parts.length
        if (removed > 0) {
            changedMessages.add(message.info.id)
            changedParts += removed
        }
    }
    return { changedMessages, changedParts }
}

function stripSkillToolParts(messages: WithParts[], rawTailStartIndex: number): StageMutationResult {
    const changedMessages = new Set<string>()
    let changedParts = 0
    for (let index = 0; index < rawTailStartIndex; index++) {
        const message = messages[index]
        if (!message || message.info.role !== "assistant") continue
        const before = message.parts.length
        message.parts = message.parts.filter((part) => !(part.type === "tool" && part.tool === "skill"))
        const removed = before - message.parts.length
        if (removed > 0) {
            changedMessages.add(message.info.id)
            changedParts += removed
        }
    }
    return { changedMessages, changedParts }
}

function stripToolParts(
    messages: WithParts[],
    rawTailStartIndex: number,
    transcriptRelativePath: string,
    preservedToolCallIds: Set<string>,
): StageMutationResult {
    const latestTodoCallId = findLatestTodoCallId(messages.slice(0, rawTailStartIndex))
    const changedMessages = new Set<string>()
    let changedParts = 0

    for (let index = 0; index < rawTailStartIndex; index++) {
        const message = messages[index]
        if (!message || message.info.role !== "assistant") continue
        const nextParts: MessagePart[] = []
        let removedTools = 0
        let latestTodoState: string | null = null

        for (const part of message.parts) {
            if (part.type !== "tool") {
                nextParts.push(part)
                continue
            }
            if (preservedToolCallIds.has(part.callID)) {
                nextParts.push(part)
                continue
            }
            if (part.tool === "todowrite" && part.callID === latestTodoCallId) {
                latestTodoState = `Latest todo state preserved: ${formatTodoInput(part.state?.input)}`
            }
            removedTools++
        }

        if (latestTodoState) nextParts.push(createTextPart(message, latestTodoState))
        if (removedTools > 0 && nextParts.length === 0) {
            nextParts.push(createTextPart(message, `[tool calls/results cleared]\nRaw transcript: ${transcriptRelativePath}`))
        }
        if (removedTools > 0) {
            message.parts = nextParts
            changedMessages.add(message.info.id)
            changedParts += removedTools
        }
    }

    return { changedMessages, changedParts }
}

function compactAssistantRuns(
    messages: WithParts[],
    rawTailStartIndex: number,
    context: TransformContext,
    summaryJobs: BoundarySummaryJob[],
    estimator: MessageEstimator,
    targetTokens: number,
): StageMutationResult {
    const compacted = messages.slice(0, rawTailStartIndex)
    const selectedKeys = selectAssistantRunsToSummarize(compacted, messages, estimator, targetTokens)
    for (const key of selectedKeys) context.assistantSummaryKeys.add(key)
    const transformed = transformCompactedPrefix(compacted, context, summaryJobs)
    const tail = messages.slice(rawTailStartIndex)
    const changedMessages = new Set<string>()
    for (const group of assistantGroups(compacted)) {
        if (!selectedKeys.has(group.key)) continue
        for (const message of group.messages) changedMessages.add(message.info.id)
    }
    messages.length = 0
    messages.push(...transformed, ...tail)
    return {
        changedMessages,
        changedParts: Math.max(0, compacted.reduce((sum, message) => sum + message.parts.length, 0) - transformed.length),
    }
}

function selectAssistantRunsToSummarize(
    compacted: WithParts[],
    allMessages: WithParts[],
    estimator: MessageEstimator,
    targetTokens: number,
): Set<string> {
    const needed = estimateMessages(allMessages, estimator) - targetTokens
    if (needed <= 0) return new Set()

    let selectedSavings = 0
    const groups = assistantGroups(compacted)
        .map((group) => {
            const before = estimateMessages(group.messages, { ...estimator, reservedTokens: 0 })
            const summaryText = group.messages.map(textParts).filter(Boolean).join("\n\n")
            const after = Math.max(1, estimateOpenCodeTokens(truncate(summaryText, ASSISTANT_TEXT_PREVIEW_CHARS)))
            const savings = Math.max(0, Math.round(before - after))
            const age = compacted.length <= 1 ? 1 : 1 - group.endIndex / (compacted.length - 1)
            return {
                ...group,
                savings,
                score: savings * (1 + age),
            }
        })
        .filter((group) => group.savings > 0)
        .sort((a, b) => b.score - a.score)

    const selected = new Set<string>()
    for (const group of groups) {
        selected.add(group.key)
        selectedSavings += group.savings
        if (selectedSavings >= needed) break
    }
    return selected
}

function assistantGroups(messages: WithParts[]): Array<{ key: string; messages: WithParts[]; endIndex: number }> {
    const groups: Array<{ key: string; messages: WithParts[]; endIndex: number }> = []
    let current: WithParts[] = []
    const flush = (endIndex: number) => {
        if (current.length === 0) return
        groups.push({ key: assistantRunKey(current), messages: current, endIndex })
        current = []
    }
    messages.forEach((message, index) => {
        if (message.info.role === "user") {
            flush(index - 1)
            return
        }
        current.push(message)
    })
    flush(messages.length - 1)
    return groups
}

function applyPrefixSummary(
    messages: WithParts[],
    rawTailStartIndex: number,
    transcriptRelativePath: string,
    prefixSummary?: string,
): StageMutationResult & { prefixSummary: string } {
    if (rawTailStartIndex <= 0) {
        return { changedMessages: new Set<string>(), changedParts: 0, prefixSummary: prefixSummary ?? "" }
    }
    const compacted = messages.slice(0, rawTailStartIndex)
    const summary = prefixSummary?.trim() || formatPrefixSummary(compacted, transcriptRelativePath)
    const summaryMessage = createSyntheticSummaryMessage(messages, compacted, summary, transcriptRelativePath)
    const changedMessages = new Set(compacted.map((message) => message.info.id))
    const changedParts = compacted.reduce((sum, message) => sum + message.parts.length, 0)
    const tail = messages.slice(rawTailStartIndex)
    messages.length = 0
    messages.push(summaryMessage, ...tail)
    return { changedMessages, changedParts, prefixSummary: summary }
}

function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K`
    return `${tokens}`
}

export function buildBoundaryCompactionPrompt(): string {
    return [
        "Generate a continuation checkpoint from the pruned conversation context above.",
        "The checkpoint must let the agent continue as if no compaction happened.",
        "",
        "Rules:",
        "- Preserve user intent, constraints, acceptance criteria, and preferences exactly.",
        "- Preserve exact file paths, symbols, commands, error strings, decisions, and current next steps.",
        "- Treat Better Compact reference files as recall handles for raw history; include them in the checkpoint under Reference Files.",
        "- Do not include raw tool-call JSON or transcript formatting noise.",
        "- Focus on current state and what should happen next, not on narrating the compaction process.",
    ].join("\n")
}

export async function writeBoundaryTranscript(
    directory: string,
    plan: BoundaryContextPlan,
    logger: Logger,
): Promise<void> {
    const absolutePath = join(directory, plan.transcript.relativePath)
    const content = plan.transcript.content || formatTranscript(plan.transcript.messages ?? [])
    await writePrivateFile(
        join(directory, ".opencode", "better-compact", ".gitignore"),
        "*\n!.gitignore\n",
        directory,
    )
    await writePrivateFile(absolutePath, content, directory)
    plan.transcript.content = content
    plan.transcript.messages = undefined
    plan.transcript.absolutePath = absolutePath
    logger.info("Wrote Better Compact transcript reference", {
        path: absolutePath,
        messages: plan.transcript.messageIds.length,
    })
}

function transformMessages(messages: WithParts[], rawTailStartIndex: number, plan: BoundaryContextPlan): WithParts[] {
    if (plan.requiresCustomCompaction) {
        return [
            createSyntheticSummaryMessage(
                messages,
                messages.slice(0, rawTailStartIndex),
                plan.prefixSummary || formatPrefixSummary(messages.slice(0, rawTailStartIndex), plan.transcript.relativePath),
                plan.transcript.relativePath,
            ),
            ...messages.slice(rawTailStartIndex),
        ]
    }
    const stageNames = new Set<string>(plan.stages.map((stage) => stage.name))
    const working = cloneMessages(messages)
    if (stageNames.has("skills")) stripSkillToolParts(working, rawTailStartIndex)
    if (stageNames.has("tools-old")) {
        stripToolParts(working, rawTailStartIndex, plan.transcript.relativePath, new Set(plan.preservedToolCallIds))
    }
    if (stageNames.has("reasoning")) stripReasoningParts(working, rawTailStartIndex)
    if (stageNames.has("tools-remaining") || stageNames.has("tools")) {
        stripToolParts(working, rawTailStartIndex, plan.transcript.relativePath, new Set())
    }
    if (!stageNames.has("assistant-runs")) {
        const result = working.slice(0, rawTailStartIndex)
        const reference = createReferenceMessage(working, working.slice(0, rawTailStartIndex), plan.transcript.relativePath)
        if (reference) result.push(reference)
        result.push(...working.slice(rawTailStartIndex))
        return result
    }
    const summaryJobs: BoundarySummaryJob[] = []
    const result = transformCompactedPrefix(
        working.slice(0, rawTailStartIndex),
        {
            transcriptRelativePath: plan.transcript.relativePath,
            latestTodoCallId: findLatestTodoCallId(messages.slice(0, rawTailStartIndex)),
            assistantSummaries: plan.assistantSummaries,
            assistantSummaryKeys: new Set(plan.assistantSummaryKeys),
        },
        summaryJobs,
    )
    const reference = createReferenceMessage(working, working.slice(0, rawTailStartIndex), plan.transcript.relativePath)
    if (reference) result.push(reference)
    result.push(...working.slice(rawTailStartIndex))
    return result
}

function transformCompactedPrefix(
    messages: WithParts[],
    context: TransformContext,
    summaryJobs: BoundarySummaryJob[],
): WithParts[] {
    const result: WithParts[] = []
    let assistantGroup: WithParts[] = []

    const flushAssistantGroup = () => {
        if (assistantGroup.length === 0) return
        if (!context.assistantSummaryKeys.has(assistantRunKey(assistantGroup))) {
            result.push(...assistantGroup)
        } else {
            result.push(transformAssistantTurn(assistantGroup, context, summaryJobs))
        }
        assistantGroup = []
    }

    for (const message of messages) {
        if (message.info.role === "user") {
            flushAssistantGroup()
            result.push(message)
            continue
        }
        assistantGroup.push(message)
    }
    flushAssistantGroup()
    return result
}

function transformAssistantTurn(
    messages: WithParts[],
    context: TransformContext,
    summaryJobs: BoundarySummaryJob[],
): WithParts {
    const first = messages[0]
    if (!first) throw new Error("Cannot compact empty assistant turn")
    const key = assistantRunKey(messages)
    const assistantText = messages.map(textParts).filter(Boolean).join("\n\n")
    const existingSummary = context.assistantSummaries[key]
    if (!existingSummary) {
        summaryJobs.push({
            key,
            rangeStartMessageId: first.info.id,
            rangeEndMessageId: messages.at(-1)?.info.id ?? first.info.id,
            transcriptRelativePath: context.transcriptRelativePath,
            prompt: formatAssistantSummaryPrompt(messages, context.transcriptRelativePath),
        })
    }

    const lines = ["[Assistant turn summary]"]
    lines.push(existingSummary?.trim() || truncate(assistantText.trim(), ASSISTANT_TEXT_PREVIEW_CHARS) || "Historical assistant/tool activity compactified.")

    let latestTodoState: string | null = null
    for (const part of messages.flatMap((message) => message.parts)) {
        if (part.type === "tool" && part.tool === "todowrite" && part.callID === context.latestTodoCallId) {
            latestTodoState = `Latest todo state preserved: ${formatTodoInput(part.state?.input)}`
        }
        if (part.type === "patch") {
            const files = Array.isArray((part as any).files) ? (part as any).files.join(", ") : "unknown files"
            lines.push(`Patch recorded: ${files}`)
        }
    }
    if (latestTodoState) lines.push(latestTodoState)
    lines.push(`Raw transcript: ${context.transcriptRelativePath}`)
    return replaceWithText(first, lines.join("\n"))
}

function formatAssistantSummaryPrompt(messages: WithParts[], transcriptRelativePath: string): string {
    const first = messages[0]?.info.id ?? "unknown"
    const last = messages.at(-1)?.info.id ?? first
    return [
        "Summarize this historical assistant turn for future context replay.",
        "Preserve concrete conclusions, files, symbols, decisions, errors, fixes, and next-step state.",
        "Do not include raw tool JSON, command output dumps, or filler narration.",
        "Do not rewrite or invent user intent. User messages stay raw elsewhere.",
        `Raw transcript reference: ${transcriptRelativePath}`,
        `Range: ${first} through ${last}`,
        "",
        formatTranscript(messages),
    ].join("\n")
}

function createReferenceMessage(
    messages: WithParts[],
    compacted: WithParts[],
    transcriptRelativePath: string,
): WithParts | null {
    const base = messages.find((message) => message.info.role === "user")
    if (!base) return null

    const hash = boundaryRangeHash(compacted)
    const first = compacted[0]?.info.id ?? "unknown"
    const last = compacted.at(-1)?.info.id ?? "unknown"
    return {
        info: {
            ...base.info,
            id: `msg_better_compact_context_${hash}`,
            role: "user" as const,
        },
        parts: [
            {
                id: `prt_better_compact_context_${hash}`,
                messageID: `msg_better_compact_context_${hash}`,
                sessionID: base.info.sessionID,
                type: "text" as const,
                synthetic: true,
                text: [
                    "[Better Compact context pruning applied]",
                    `Older assistant/tool-heavy context was compactified for this request. Raw messages ${first} through ${last} are preserved in the reference transcript below.`,
                    "",
                    "## Reference Files",
                    `- "${transcriptRelativePath}"`,
                    "",
                    "If exact prior wording, raw tool output, or omitted implementation detail is needed, inspect the reference file instead of guessing.",
                ].join("\n"),
            },
        ],
    } as WithParts
}

function createSyntheticSummaryMessage(
    messages: WithParts[],
    compacted: WithParts[],
    summary: string,
    transcriptRelativePath: string,
): WithParts {
    const base = messages.find((message) => message.info.role === "user") ?? messages[0]
    const hash = boundaryRangeHash(compacted)
    return {
        info: {
            ...base.info,
            id: `msg_better_compact_summary_${hash}`,
            role: "user" as const,
        },
        parts: [
            {
                id: `prt_better_compact_summary_${hash}`,
                messageID: `msg_better_compact_summary_${hash}`,
                sessionID: base.info.sessionID,
                type: "text" as const,
                synthetic: true,
                text: [
                    "[Context Summary]",
                    summary.trim(),
                    "",
                    "## Reference Files",
                    `- "${transcriptRelativePath}"`,
                ].join("\n"),
            },
        ],
    } as WithParts
}

function replaceWithText(message: WithParts, text: string): WithParts {
    const partId = `${message.info.id}_better_compact_compactified`
    return {
        info: message.info,
        parts: [
            {
                id: partId,
                messageID: message.info.id,
                sessionID: message.info.sessionID,
                type: "text" as const,
                text,
            },
        ],
    }
}

function createTextPart(message: WithParts, text: string): MessagePart {
    return {
        id: `${message.info.id}_better_compact_text_${createHash("sha1").update(text).digest("hex").slice(0, 8)}`,
        messageID: message.info.id,
        sessionID: message.info.sessionID,
        type: "text" as const,
        text,
    } as MessagePart
}

function formatTranscript(messages: WithParts[]): string {
    return [
        "# Better Compact Raw Transcript",
        "",
        "```json",
        JSON.stringify(messages, null, 2),
        "```",
        "",
    ].join("\n")
}

function formatPrefixSummary(messages: WithParts[], transcriptRelativePath: string): string {
    const userMessages = messages
        .filter(
            (message) =>
                message.info.role === "user" &&
                !message.parts.every(isIgnoredPart),
        )
        .map((message) => textParts(message).trim())
        .filter(Boolean)
    const assistantFacts = messages
        .filter((message) => message.info.role === "assistant")
        .map((message) => textParts(message).trim())
        .filter(Boolean)

    return [
        "Older context was compacted as a last resort. Exact raw history is available in the reference transcript.",
        "",
        "## Preserved User Messages From Prefix",
        ...(userMessages.length > 0 ? userMessages.map((text) => `- ${truncate(text, 600)}`) : ["- (none)"]),
        "",
        "## Assistant Progress From Prefix",
        ...(assistantFacts.length > 0 ? assistantFacts.map((text) => `- ${truncate(text, 600)}`) : ["- (none)"]),
        "",
        "## Reference Files",
        `- "${transcriptRelativePath}"`,
    ].join("\n")
}

function textParts(message: WithParts): string {
    return message.parts
        .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n\n")
}

function isIgnoredPart(part: MessagePart): boolean {
    return "ignored" in part && part.ignored === true
}

function createMessageEstimator(reservedTokens: number): MessageEstimator {
    return { reservedTokens }
}

function estimateMessages(messages: WithParts[], estimator: MessageEstimator): number {
    const messageWeightTotal = estimateOpenCodeMessages(messages)
    return Math.max(0, Math.round(messageWeightTotal + estimator.reservedTokens))
}

function findRawTailStartIndex(messages: WithParts[], minMessages: number, minUserTurns: number): number {
    let userTurns = 0
    for (let index = messages.length - 1; index >= 0; index--) {
        if (
            messages[index].info.role !== "user" ||
            messages[index].parts.every(isIgnoredPart)
        ) {
            continue
        }
        userTurns++
        if (userTurns >= minUserTurns) return index
    }
    return Math.max(0, messages.length - Math.min(minMessages, messages.length))
}

function findLatestTodoCallId(messages: WithParts[]): string | null {
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
        const message = messages[messageIndex]
        for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
            const part = message.parts[partIndex]
            if (part.type === "tool" && part.tool === "todowrite") return part.callID
        }
    }
    return null
}

function formatTodoInput(input: unknown): string {
    if (!input || typeof input !== "object" || !Array.isArray((input as { todos?: unknown }).todos)) {
        return previewJson(input, 480) || "todo state unavailable"
    }
    const todos = (input as { todos: unknown[] }).todos
    if (todos.length === 0) return "no todos"
    return todos
        .map((todo, index) => {
            if (!todo || typeof todo !== "object") return `${index + 1}. ${String(todo)}`
            const item = todo as { content?: unknown; status?: unknown; priority?: unknown }
            const content = typeof item.content === "string" ? item.content : JSON.stringify(todo)
            const status = typeof item.status === "string" ? item.status : "unknown"
            const priority = typeof item.priority === "string" ? item.priority : "unknown"
            return `${index + 1}. [${status}/${priority}] ${content}`
        })
        .join("; ")
}

function transcriptPath(messages: WithParts[], compacted: WithParts[]): string {
    const sessionId = messages[0]?.info.sessionID ?? "unknown-session"
    return `${TRANSCRIPT_ROOT}/${safePathPart(sessionId)}/${boundaryRangeHash(compacted)}.md`
}

function assistantRunKey(messages: WithParts[]): string {
    const seed = messages
        .map(
            (message) =>
                `${message.info.role}:${message.info.time.created}:${"providerID" in message.info ? message.info.providerID ?? "" : ""}:${"modelID" in message.info ? message.info.modelID ?? "" : ""}`,
        )
        .join("|")
    return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}

function safePathPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown"
}

function previewJson(value: unknown, maxChars: number): string {
    if (value === undefined) return ""
    try {
        return truncate(typeof value === "string" ? value : JSON.stringify(value), maxChars)
    } catch {
        return truncate(String(value), maxChars)
    }
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text
    return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[...omitted]`
}

function cloneMessages(messages: WithParts[]): WithParts[] {
    return messages.map((message) => ({
        info: message.info,
        parts: [...message.parts],
    }))
}
