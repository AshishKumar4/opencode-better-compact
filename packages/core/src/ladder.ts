import { estimateTurns, type Estimator } from "./estimate"
import { rangeHash } from "./identity"
import type { CodecOps, Conventions, Turn } from "./ir"
import {
    toPlanSnapshot,
    type BoundaryContextOptions,
    type BoundaryContextPlan,
    type BoundaryStageReport,
    type BoundarySummaryJob,
    type PlanSnapshot,
    type RawTailItemBoundary,
} from "./plan"
import type { EnginePorts } from "./ports"
import { formatPrefixSummaryPrompt } from "./summarize"
import {
    assistantGroups,
    findLatestTodoCallId,
    findRawTailStartIndex,
    findRecentToolCallTail,
    formatPrefixSummary,
    primaryToolTarget,
    transformCompactedPrefix,
    type Stage,
    type StageContext,
    type StageMutationResult,
} from "./stages"
import { writeTranscript } from "./transcript"

const TRIGGER_RATIO = 0.85
const TARGET_RATIO = 0.3
const MIN_TAIL_MESSAGES = 3
const MIN_TAIL_USER_TURNS = 2
const RECENT_TOOL_RESULT_BUDGET_TOKENS = 40_000

interface TailBoundary {
    turnIndex: number
    itemIndex: number
}

interface PartitionedTurns {
    turns: Turn[]
    compactedRange: Turn[]
    rawTailStartIndex: number
    rawTailKey?: string
    finalize(turns: Turn[]): Turn[]
}

// A platform adapter: its codec, its conventions, and its declared ladder
// stage order. Composition is data; absence from the array is the only
// conditionality.
export interface LadderSpec {
    codec: CodecOps
    conventions: Conventions
    stages: Stage[]
}

export interface BuildPlanInputs extends BoundaryContextOptions {
    sessionKey: string
    citablePath(sessionKey: string, rangeHash: string): string
}

export function buildPlan(turns: Turn[], inputs: BuildPlanInputs, spec: LadderSpec): BoundaryContextPlan | null {
    const contextLimit = inputs.contextLimit
    if (!contextLimit || contextLimit <= 0 || turns.length === 0) return null

    const triggerRatio = inputs.triggerRatio ?? TRIGGER_RATIO
    const targetRatio = inputs.targetRatio ?? TARGET_RATIO
    const rawEstimateTokens = spec.codec.estimateTurns(turns)
    const providerReportedTokens =
        inputs.providerReportedTokens && inputs.providerReportedTokens > 0 ? inputs.providerReportedTokens : 0
    // Provider totals include system prompt, tool schemas, and cache accounting
    // that the char-based estimate cannot see. Carrying the delta keeps every
    // gate and stage number on the provider-equivalent scale.
    const overheadTokens = providerReportedTokens > 0 ? Math.max(0, providerReportedTokens - rawEstimateTokens) : 0
    const estimator: Estimator = { overheadTokens }
    const beforeTokens = providerReportedTokens > 0 ? providerReportedTokens : rawEstimateTokens
    const triggerTokens = Math.floor(contextLimit * triggerRatio)
    // Either scale crossing the trigger means the request is in danger: the
    // provider total sees overhead the estimate cannot, and the estimate sees
    // fresh turns the provider has not priced yet.
    if (!inputs.force && Math.max(beforeTokens, rawEstimateTokens) < triggerTokens) return null

    const wholeTurnTailStartIndex = findRawTailStartIndex(
        turns,
        Math.max(1, inputs.minTailMessages ?? MIN_TAIL_MESSAGES),
        Math.max(1, inputs.minTailUserTurns ?? MIN_TAIL_USER_TURNS),
    )
    const targetTokens = Math.floor(contextLimit * targetRatio)
    const selectedBoundary = selectTailBoundary(
        turns,
        wholeTurnTailStartIndex,
        triggerTokens,
        targetTokens,
        spec.codec,
    )
    const prior = inputs.priorPlan
    const priorBoundary = prior ? resolveTailBoundary(turns, prior) : null
    const boundary =
        priorBoundary && compareBoundaries(selectedBoundary, priorBoundary) < 0
            ? priorBoundary
            : selectedBoundary
    const partition = partitionTurns(turns, boundary)
    const rawTailStartIndex = boundary.turnIndex
    const compactedRange = partition.compactedRange
    if (compactedRange.length === 0) return null

    const compactedRangeHash = rangeHash(compactedRange)
    const transcriptRelativePath = inputs.citablePath(inputs.sessionKey, compactedRangeHash)
    const working = partition.turns
    const stages: BoundaryStageReport[] = []
    const summaryJobs: BoundarySummaryJob[] = []
    const expandedPrefix = priorBoundary !== null && compareBoundaries(boundary, priorBoundary) > 0
    const priorPrefixSummary = prior?.prefixSummary
        ? stripTranscriptReference(prior.prefixSummary, prior.transcriptRelativePath)
        : undefined
    const prefixSummaryResultKey = `prefix-summary:${compactedRangeHash}`
    const prefixSummaryJobKey = expandedPrefix && priorPrefixSummary
        ? prefixSummaryResultKey
        : undefined
    const assistantSummaries = {
        ...(prior?.assistantSummaries ?? {}),
        ...(inputs.assistantSummaries ?? {}),
    }
    const rolledPrefixSummary = assistantSummaries[prefixSummaryResultKey]
    delete assistantSummaries[prefixSummaryResultKey]
    const preservedToolCallIds = findRecentToolCallTail(
        compactedRange,
        inputs.recentToolResultBudgetTokens ?? RECENT_TOOL_RESULT_BUDGET_TOKENS,
        spec.codec,
        spec.conventions,
    )
    applyPreservationFloor(
        preservedToolCallIds,
        priorBoundary ? partitionTurns(turns, priorBoundary).compactedRange : [],
        prior,
    )
    const priorStages = new Set(
        (prior?.stages ?? [])
            .filter((stage) => stage.status !== "skipped" && stage.status !== "failed")
            .map((stage) => stage.name),
    )
    const ctx: StageContext = {
        codec: spec.codec,
        conventions: spec.conventions,
        estimator,
        rawTailStartIndex: partition.rawTailStartIndex,
        transcriptRelativePath,
        preservedToolCallIds,
        latestTodoCallId: findLatestTodoCallId(compactedRange, spec.conventions),
        assistantSummaries,
        assistantSummaryKeys: new Set<string>(prior?.assistantSummaryKeys ?? []),
        summaryJobs,
        selectRuns: true,
        targetTokens,
        referenceTokens: 0,
    }
    // The applied output always carries a reference message; gates must account
    // for it so a "trigger met" claim holds for the real transformed context.
    const reference = synthesizeReferenceTurn(turns, compactedRange, ctx, compactedRangeHash)
    ctx.referenceTokens = reference ? spec.codec.estimateTurns([reference]) : 0
    const projectedTokens = () => estimateTurns(working, spec.codec, estimator) + ctx.referenceTokens

    for (const stage of spec.stages) {
        if (!stage.always && projectedTokens() < triggerTokens && !priorStages.has(stage.name)) {
            markTargetMet(stages)
            continue
        }
        runStage(stages, working, estimator, spec.codec, stage, ctx)
    }

    let requiresCustomCompaction = false
    let prefixSummary = inputs.prefixSummary
        ?? rolledPrefixSummary
        ?? (expandedPrefix ? undefined : priorPrefixSummary)
    if (projectedTokens() >= triggerTokens || prior?.requiresCustomCompaction) {
        const newlyCompactedTurns = expandedPrefix && priorBoundary
            ? turnsBetweenBoundaries(turns, priorBoundary, boundary)
            : []
        if (
            prefixSummaryJobKey &&
            priorPrefixSummary &&
            inputs.prefixSummary === undefined &&
            rolledPrefixSummary === undefined &&
            newlyCompactedTurns.length > 0
        ) {
            summaryJobs.push({
                key: prefixSummaryJobKey,
                rangeStartMessageId: newlyCompactedTurns[0].key,
                rangeEndMessageId: newlyCompactedTurns.at(-1)?.key ?? newlyCompactedTurns[0].key,
                transcriptRelativePath,
                prompt: formatPrefixSummaryPrompt(
                    priorPrefixSummary,
                    newlyCompactedTurns,
                    transcriptRelativePath,
                    spec.codec,
                ),
            })
        }
        const currentTailStartIndex = partition.rawTailKey
            ? working.findIndex((turn) => turn.key === partition.rawTailKey)
            : working.length
        const beforePrefix = projectedTokens()
        const result = applyPrefixSummary(
            working,
            currentTailStartIndex > 0 ? currentTailStartIndex : partition.rawTailStartIndex,
            transcriptRelativePath,
            prefixSummary,
            compactedRangeHash,
        )
        const afterPrefix = estimateTurns(working, spec.codec, estimator)
        prefixSummary = result.prefixSummary
        requiresCustomCompaction = result.changedTurns.size > 0
        stages.push({
            name: "prefix-summary",
            label: "Last-resort prefix summary",
            beforeTokens: beforePrefix,
            afterTokens: afterPrefix,
            clearedTokens: Math.max(0, beforePrefix - afterPrefix),
            changedMessages: result.changedTurns.size,
            changedParts: result.changedItems,
            status: afterPrefix <= targetTokens ? "applied" : "failed",
        })
    }

    const plan: BoundaryContextPlan = {
        sessionId: inputs.sessionKey,
        rangeHash: compactedRangeHash,
        contextLimit,
        beforeTokens,
        afterPruneTokens: estimateTurns(working, spec.codec, estimator),
        overheadTokens,
        triggerTokens,
        targetTokens,
        rawTailStartIndex,
        rawTailStartMessageId: turns[boundary.turnIndex]?.key ?? turns.at(-1)?.key ?? "",
        rawTailItemBoundary: recordedItemBoundary(turns, boundary),
        requiresCustomCompaction,
        preservedToolCallIds: [...ctx.preservedToolCallIds],
        transcript: {
            relativePath: transcriptRelativePath,
            content: "",
            messageIds: compactedRange.map((turn) => turn.key),
            turns: compactedRange,
        },
        stages,
        summaryJobs,
        assistantSummaryKeys: [...ctx.assistantSummaryKeys],
        assistantSummaries: ctx.assistantSummaries,
        prefixSummary,
    }
    plan.afterPruneTokens = estimateTurns(transformTurns(turns, rawTailStartIndex, plan, spec), spec.codec, estimator)
    return plan
}

export function transformTurns(
    turns: Turn[],
    rawTailStartIndex: number,
    plan: BoundaryContextPlan,
    spec: LadderSpec,
): Turn[] {
    const resolvedBoundary = resolveTailBoundary(turns, plan)
    if (!resolvedBoundary && plan.rawTailItemBoundary !== undefined) return turns
    const boundary = resolvedBoundary ?? {
        turnIndex: rawTailStartIndex,
        itemIndex: 0,
    }
    const partition = partitionTurns(turns, boundary)
    const originalPrefix = partition.compactedRange
    if (plan.requiresCustomCompaction) {
        return partition.finalize([
            synthesizeSummaryTurn(
                originalPrefix,
                plan.prefixSummary || formatPrefixSummary(originalPrefix),
                plan.transcript.relativePath,
                plan.rangeHash,
            ),
            ...partition.turns.slice(partition.rawTailStartIndex),
        ])
    }
    // Replay the recorded strip stages exactly as the planner simulated them,
    // then summarize assistant runs over the stripped prefix. This keeps the
    // applied output identical to the simulation used for the plan's numbers.
    const stageNames = new Set<string>(plan.stages.map((stage) => stage.name))
    const working = partition.turns
    const ctx: StageContext = {
        codec: spec.codec,
        conventions: spec.conventions,
        estimator: { overheadTokens: plan.overheadTokens },
        rawTailStartIndex: partition.rawTailStartIndex,
        transcriptRelativePath: plan.transcript.relativePath,
        preservedToolCallIds: new Set(plan.preservedToolCallIds),
        latestTodoCallId: findLatestTodoCallId(originalPrefix, spec.conventions),
        assistantSummaries: plan.assistantSummaries,
        assistantSummaryKeys: new Set(plan.assistantSummaryKeys),
        summaryJobs: [],
        selectRuns: false,
        targetTokens: plan.targetTokens,
        referenceTokens: 0,
    }
    for (const stage of spec.stages) {
        if (stage.name === "assistant-runs") continue
        if (stageNames.has(stage.name)) stage.run(working, ctx)
    }
    let prefix = working.slice(0, partition.rawTailStartIndex)
    if (stageNames.has("assistant-runs")) {
        prefix = transformCompactedPrefix(prefix, ctx)
    }
    const result = [...prefix]
    const reference = synthesizeReferenceTurn(turns, originalPrefix, ctx, plan.rangeHash)
    if (reference) result.push(reference)
    result.push(...working.slice(partition.rawTailStartIndex))
    return partition.finalize(result)
}

export interface ReplayOptions {
    // Apply the plan even when the pruned context has regrown past the
    // trigger. Hosts that cannot rebuild (automatic compaction disabled or
    // denied) prefer a stale-but-valid plan over sending raw history.
    allowRegrown?: boolean
}

export function replayPlanSnapshot(
    turns: Turn[],
    snapshot: PlanSnapshot,
    spec: LadderSpec,
    options: ReplayOptions = {},
): Turn[] | null {
    const boundary = resolveTailBoundary(turns, snapshot)
    if (!boundary || !matchesPlanSnapshot(turns, snapshot)) return null
    const rawTailStartIndex = boundary.turnIndex
    const overheadTokens = snapshot.overheadTokens ?? 0
    const transformed = transformTurns(
        turns,
        rawTailStartIndex,
        {
            sessionId: snapshot.sessionId,
            rangeHash: snapshot.rangeHash,
            contextLimit: snapshot.contextLimit ?? Math.max(snapshot.beforeTokens, snapshot.targetTokens, 1),
            beforeTokens: snapshot.beforeTokens,
            afterPruneTokens: snapshot.afterPruneTokens,
            overheadTokens,
            triggerTokens: snapshot.triggerTokens,
            targetTokens: snapshot.targetTokens,
            rawTailStartIndex,
            rawTailStartMessageId: snapshot.rawTailStartMessageId,
            rawTailItemBoundary: snapshot.rawTailItemBoundary,
            requiresCustomCompaction: snapshot.requiresCustomCompaction,
            preservedToolCallIds: snapshot.preservedToolCallIds ?? [],
            assistantSummaryKeys: snapshot.assistantSummaryKeys ?? Object.keys(snapshot.assistantSummaries ?? {}),
            transcript: {
                relativePath: snapshot.transcriptRelativePath,
                content: "",
                messageIds: [],
            },
            stages: (snapshot.stages ?? []) as BoundaryStageReport[],
            summaryJobs: [],
            assistantSummaries: snapshot.assistantSummaries ?? {},
            prefixSummary: snapshot.prefixSummary,
        },
        spec,
    )
    // Once new turns regrow the context past the trigger, the frozen plan no
    // longer suffices; refuse so the caller rebuilds with a fresh boundary.
    if (!options.allowRegrown && spec.codec.estimateTurns(transformed) + overheadTokens >= snapshot.triggerTokens) {
        return null
    }
    return transformed
}

export function matchesPlanSnapshot(turns: Turn[], snapshot: PlanSnapshot): boolean {
    const boundary = resolveTailBoundary(turns, snapshot)
    if (!boundary) return false
    const compactedRange = partitionTurns(turns, boundary).compactedRange
    if (compactedRange.length === 0) return false
    return rangeHash(compactedRange) === snapshot.rangeHash
}

export type ProcessResult =
    | { outcome: "unchanged" }
    | { outcome: "replayed"; turns: Turn[] }
    | { outcome: "planned"; turns: Turn[]; plan: BoundaryContextPlan }

export interface Engine {
    process(request: {
        sessionKey: string
        turns: Turn[]
        contextLimit?: number
        triggerRatio?: number
        targetRatio?: number
        recentToolResultBudgetTokens?: number
        providerReportedTokens?: number
        force?: boolean
        // Side-model summary results for the automatic path. When a
        // fresh plan queues summary jobs, the engine runs them and rebuilds
        // the plan with the accepted summaries before persisting it.
        summarize?: (jobs: BoundarySummaryJob[]) => Promise<Record<string, string>>
    }): Promise<ProcessResult>
}

// The boundary-time transform: replay the cached plan when it still holds,
// otherwise discard it and build, persist, and apply a fresh one.
export function createEngine(spec: LadderSpec, ports: EnginePorts): Engine {
    return {
        async process({
            sessionKey,
            turns,
            contextLimit,
            triggerRatio,
            targetRatio,
            recentToolResultBudgetTokens,
            providerReportedTokens,
            force,
            summarize,
        }) {
            let staleSnapshotCleared = false
            let priorPlan: PlanSnapshot | undefined
            const cached = await ports.plans.load(sessionKey)
            if (cached && cached.sessionId === sessionKey) {
                const replayed = force ? null : replayPlanSnapshot(turns, cached, spec)
                if (replayed) return { outcome: "replayed", turns: replayed }
                staleSnapshotCleared = true
                priorPlan = cached
            }

            const inputs: BuildPlanInputs = {
                contextLimit,
                triggerRatio,
                targetRatio,
                recentToolResultBudgetTokens,
                providerReportedTokens,
                force,
                priorPlan,
                sessionKey,
                citablePath: ports.transcripts.citablePath,
            }
            let plan = buildPlan(turns, inputs, spec)
            if (!plan) {
                if (staleSnapshotCleared) await ports.plans.save(sessionKey, null)
                return { outcome: "unchanged" }
            }
            if (summarize && plan.summaryJobs.length > 0) {
                try {
                    const assistantSummaries = await summarize(plan.summaryJobs)
                    if (Object.keys(assistantSummaries).length > 0) {
                        plan = buildPlan(
                            turns,
                            {
                                ...inputs,
                                priorPlan: toPlanSnapshot(plan),
                                assistantSummaries,
                            },
                            spec,
                        ) ?? plan
                    }
                } catch (error) {
                    ports.logger.warn("Summary scheduling failed; using deterministic fallback", {
                        sessionId: sessionKey,
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
            }

            await writeTranscript(plan, { transcripts: ports.transcripts, logger: ports.logger, codec: spec.codec })
            const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
            await ports.plans.save(sessionKey, toPlanSnapshot(plan))
            ports.logger.info("Applied Better Compact staged pruning", {
                sessionId: plan.sessionId,
                beforeTokens: plan.beforeTokens,
                afterPruneTokens: plan.afterPruneTokens,
                transcript: plan.transcript.relativePath,
                stages: plan.stages.map((stage) => stage.name),
            })
            return { outcome: "planned", turns: transformed, plan }
        },
    }
}

function selectTailBoundary(
    turns: Turn[],
    wholeTurnStartIndex: number,
    triggerTokens: number,
    targetTokens: number,
    codec: CodecOps,
): TailBoundary {
    let selected: TailBoundary = { turnIndex: wholeTurnStartIndex, itemIndex: 0 }
    for (let turnIndex = wholeTurnStartIndex; turnIndex < turns.length; turnIndex++) {
        const turn = turns[turnIndex]
        if (turn.items.length === 0 || codec.estimateTurns([turn]) <= triggerTokens) continue
        const itemIndex = rawSuffixItemIndex(turn, targetTokens, codec)
        if (itemIndex > 0) selected = { turnIndex, itemIndex }
    }
    return selected
}

function rawSuffixItemIndex(turn: Turn, targetTokens: number, codec: CodecOps): number {
    let firstRawIndex = turn.items.length
    for (let index = turn.items.length - 1; index >= 0; index--) {
        const candidate = { ...turn, items: turn.items.slice(index) }
        if (codec.estimateTurns([candidate]) <= targetTokens) {
            firstRawIndex = index
            continue
        }
        if (firstRawIndex < turn.items.length) break
        if (turn.items[index].kind === "tool") return turn.items.length
        return index > 0 ? index : 0
    }
    return firstRawIndex > 0 ? firstRawIndex : 0
}

function resolveTailBoundary(
    turns: Turn[],
    recorded: Pick<PlanSnapshot, "rawTailStartMessageId" | "rawTailItemBoundary">,
): TailBoundary | null {
    const turnIndex = turns.findIndex((turn) => turn.key === recorded.rawTailStartMessageId)
    if (turnIndex < 0) return null
    const itemBoundary = recorded.rawTailItemBoundary
    if (itemBoundary === undefined) {
        return turnIndex > 0 ? { turnIndex, itemIndex: 0 } : null
    }
    const turn = turns[turnIndex]
    const itemIndex = turn.items.findIndex((item) => item.key === itemBoundary.itemKey)
    if (itemIndex < 0) return null
    const boundaryIndex = itemBoundary.side === "after" ? itemIndex + 1 : itemIndex
    return boundaryIndex > 0 ? { turnIndex, itemIndex: boundaryIndex } : null
}

function recordedItemBoundary(
    turns: Turn[],
    boundary: TailBoundary,
): RawTailItemBoundary | undefined {
    if (boundary.itemIndex === 0) return undefined
    const turn = turns[boundary.turnIndex]
    const firstRawItem = turn.items[boundary.itemIndex]
    if (firstRawItem) return { itemKey: firstRawItem.key, side: "before" }
    const lastCompactedItem = turn.items[boundary.itemIndex - 1]
    return lastCompactedItem
        ? { itemKey: lastCompactedItem.key, side: "after" }
        : undefined
}

function partitionTurns(turns: Turn[], boundary: TailBoundary): PartitionedTurns {
    const source = turns[boundary.turnIndex]
    if (!source || boundary.itemIndex === 0) {
        const cloned = cloneTurns(turns)
        return {
            turns: cloned,
            compactedRange: cloneTurns(turns.slice(0, boundary.turnIndex)),
            rawTailStartIndex: boundary.turnIndex,
            rawTailKey: cloned[boundary.turnIndex]?.key,
            finalize: (transformed) => transformed,
        }
    }

    const compactedItems = source.items.slice(0, boundary.itemIndex)
    const rawItems = source.items.slice(boundary.itemIndex)
    const fragmentKey = JSON.stringify(compactedItems.map((item) => item.key))
    const compactedFragment: Turn = {
        ...source,
        items: compactedItems,
        fragmentKey,
    }
    const before = cloneTurns(turns.slice(0, boundary.turnIndex))
    const after = cloneTurns(turns.slice(boundary.turnIndex + 1))

    if (rawItems.length === 0) {
        const partitioned = [...before, compactedFragment, ...after]
        const rawTailStartIndex = before.length + 1
        return {
            turns: partitioned,
            compactedRange: cloneTurns(partitioned.slice(0, rawTailStartIndex)),
            rawTailStartIndex,
            rawTailKey: after[0]?.key,
            finalize: (transformed) => transformed,
        }
    }

    const rawTailKey = `${source.key}:better-compact-raw:${rawItems[0].key}`
    const rawFragment: Turn = { ...source, key: rawTailKey, items: rawItems }
    const partitioned = [...before, compactedFragment, rawFragment, ...after]
    const rawTailStartIndex = before.length + 1
    return {
        turns: partitioned,
        compactedRange: cloneTurns(partitioned.slice(0, rawTailStartIndex)),
        rawTailStartIndex,
        rawTailKey,
        finalize(transformed) {
            const rawIndex = transformed.findIndex((turn) => turn.key === rawTailKey)
            if (rawIndex < 0) return cloneTurns(turns)
            const compactedIndex = transformed.findIndex(
                (turn, index) => index < rawIndex && turn.key === source.key,
            )
            const compactedItems = compactedIndex >= 0 ? transformed[compactedIndex].items : []
            const result = transformed.filter((_turn, index) => index !== compactedIndex)
            const adjustedRawIndex = compactedIndex >= 0 ? rawIndex - 1 : rawIndex
            result[adjustedRawIndex] = {
                ...source,
                items: [...compactedItems, ...transformed[rawIndex].items],
            }
            return result
        },
    }
}

function compareBoundaries(left: TailBoundary, right: TailBoundary): number {
    return left.turnIndex === right.turnIndex
        ? left.itemIndex - right.itemIndex
        : left.turnIndex - right.turnIndex
}

function turnsBetweenBoundaries(
    turns: Turn[],
    start: TailBoundary,
    end: TailBoundary,
): Turn[] {
    if (compareBoundaries(end, start) <= 0) return []
    const delta: Turn[] = []
    for (let turnIndex = start.turnIndex; turnIndex <= end.turnIndex; turnIndex++) {
        const turn = turns[turnIndex]
        const startItem = turnIndex === start.turnIndex ? start.itemIndex : 0
        const endItem = turnIndex === end.turnIndex ? end.itemIndex : turn.items.length
        if (endItem <= startItem) continue
        delta.push({
            ...turn,
            items: turn.items.slice(startItem, endItem),
            fragmentKey: JSON.stringify(
                turn.items.slice(startItem, endItem).map((item) => item.key),
            ),
        })
    }
    return delta
}

function runStage(
    stages: BoundaryStageReport[],
    working: Turn[],
    estimator: Estimator,
    codec: CodecOps,
    stage: Stage,
    ctx: StageContext,
): void {
    const beforeTokens = estimateTurns(working, codec, estimator)
    const result = stage.run(working, ctx)
    const afterTokens = estimateTurns(working, codec, estimator)
    stages.push({
        name: stage.name,
        label: stage.label,
        beforeTokens,
        afterTokens,
        clearedTokens: Math.max(0, beforeTokens - afterTokens),
        changedMessages: result.changedTurns.size,
        changedParts: result.changedItems,
        status: result.changedTurns.size > 0 || result.changedItems > 0 ? "applied" : "skipped",
    })
}

// Tool results the model already lost to the prior plan must not resurface
// in the replacement: drop newly-preserved call ids that live inside the
// prior plan's compacted prefix unless the prior plan preserved them too.
function applyPreservationFloor(
    preservedToolCallIds: Set<string>,
    priorCompactedRange: Turn[],
    prior: PlanSnapshot | undefined,
): void {
    if (!prior || priorCompactedRange.length === 0) return
    const previouslyPreserved = new Set(prior.preservedToolCallIds ?? [])
    for (const turn of priorCompactedRange) {
        for (const item of turn.items) {
            if (
                item.kind === "tool" &&
                item.callId &&
                preservedToolCallIds.has(item.callId) &&
                !previouslyPreserved.has(item.callId)
            ) {
                preservedToolCallIds.delete(item.callId)
            }
        }
    }
}

function markTargetMet(stages: BoundaryStageReport[]): void {
    const last = stages.at(-1)
    if (!last || last.status === "target-met") return
    last.status = "target-met"
}

function applyPrefixSummary(
    working: Turn[],
    rawTailStartIndex: number,
    transcriptRelativePath: string,
    prefixSummary?: string,
    compactedRangeHash?: string,
): StageMutationResult & { prefixSummary: string } {
    if (rawTailStartIndex <= 0) {
        return { changedTurns: new Set<string>(), changedItems: 0, prefixSummary: prefixSummary ?? "" }
    }
    const compacted = working.slice(0, rawTailStartIndex)
    const summary = stripTranscriptReference(
        prefixSummary?.trim() || formatPrefixSummary(compacted),
        transcriptRelativePath,
    )
    const summaryTurn = synthesizeSummaryTurn(
        compacted,
        summary,
        transcriptRelativePath,
        compactedRangeHash,
    )
    const changedTurns = new Set(compacted.map((turn) => turn.key))
    const changedItems = compacted.reduce((sum, turn) => sum + turn.items.length, 0)
    const tail = working.slice(rawTailStartIndex)
    working.length = 0
    working.push(summaryTurn, ...tail)
    return { changedTurns, changedItems, prefixSummary: summary }
}

function synthesizeReferenceTurn(
    turns: Turn[],
    compacted: Turn[],
    ctx: StageContext,
    compactedRangeHash = rangeHash(compacted),
): Turn | null {
    if (!turns.some((turn) => turn.role === "user")) return null

    const hash = compactedRangeHash
    const first = compacted[0]?.key ?? "unknown"
    const last = compacted.at(-1)?.key ?? "unknown"
    const key = `better_compact_context_${hash}`
    const runIndex = assistantGroups(compacted).map((group) => formatReferenceRun(group.turns, ctx))
    const latestTodoState = formatLatestTodoState(compacted, ctx)
    return {
        key,
        stamp: 0,
        role: "user",
        items: [
            {
                kind: "synthetic",
                key,
                text: [
                    "[Better Compact context pruning applied]",
                    `Older assistant/tool-heavy context was compactified for this request. Raw messages ${first} through ${last} are preserved in the reference transcript below.`,
                    "",
                    "## Compacted Assistant Runs",
                    ...(runIndex.length > 0 ? runIndex : ["- (none)"]),
                    "",
                    "## Reference Files",
                    `- "${ctx.transcriptRelativePath}"`,
                    "",
                    "If exact prior wording, raw tool output, or omitted implementation detail is needed, inspect the reference file instead of guessing.",
                    ...(latestTodoState ? ["", latestTodoState] : []),
                ].join("\n"),
            },
        ],
    }
}

function formatReferenceRun(group: Turn[], ctx: StageContext): string {
    const first = group[0]?.key ?? "unknown"
    const last = group.at(-1)?.key ?? first
    const idRange = first === last ? first : `${first} through ${last}`
    const touched = new Set<string>()
    for (const item of group.flatMap((turn) => turn.items)) {
        if (item.kind === "tool") {
            const details = ctx.conventions.tool?.(item)
            const name = referencePhrase(details?.name || "tool", 80)
            const target = primaryToolTarget(details?.input)?.normalized
            touched.add(target ? `${name} ${referencePhrase(target, 160)}` : name)
        }
        const note = ctx.conventions.itemNote?.(item)
        if (note) touched.add(referencePhrase(note, 240))
    }
    const topicItem = group
        .flatMap((turn) => turn.items)
        .find((item) => (item.kind === "text" || item.kind === "synthetic") && item.text.trim())
    const topic = topicItem && (topicItem.kind === "text" || topicItem.kind === "synthetic")
        ? referenceTopic(topicItem.text)
        : "(no assistant text)"
    const touchedText = formatTouchedReferences([...touched])
    return `- ${idRange} — ${touchedText} — ${topic}`
}

function formatLatestTodoState(compacted: Turn[], ctx: StageContext): string | null {
    if (!ctx.latestTodoCallId || !ctx.conventions.todo) return null
    for (const item of compacted.flatMap((turn) => turn.items)) {
        if (
            item.kind === "tool" &&
            item.callId === ctx.latestTodoCallId &&
            ctx.conventions.todo.isTodoItem(item)
        ) {
            return `Latest todo state preserved: ${oneLineReference(ctx.conventions.todo.format(item))}`
        }
    }
    return null
}

function referenceTopic(value: string): string {
    const firstLine = value
        .split(/\r\n|\n|\r/)
        .map((line) => line.trim())
        .find(Boolean)
    if (!firstLine) return "(no assistant text)"
    const firstSentence = firstLine.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? firstLine
    return referencePhrase(firstSentence, 160)
}

function formatTouchedReferences(values: string[]): string {
    if (values.length === 0) return "(no files/tools)"
    const selected: string[] = []
    let length = 0
    for (const value of values) {
        const separatorLength = selected.length > 0 ? 2 : 0
        if (selected.length > 0 && length + separatorLength + value.length > 240) {
            selected.push("…")
            break
        }
        const entry = referencePhrase(value, 240)
        selected.push(entry)
        length += separatorLength + entry.length
    }
    return selected.join(", ")
}

function referencePhrase(value: string, maxChars: number): string {
    const normalized = oneLineReference(value)
    if (normalized.length <= maxChars) return normalized
    const prefix = normalized.slice(0, Math.max(0, maxChars - 1))
    const wordBoundary = prefix.lastIndexOf(" ")
    return `${(wordBoundary > maxChars / 2 ? prefix.slice(0, wordBoundary) : prefix).trimEnd()}…`
}

function oneLineReference(value: string): string {
    return value.replace(/\s+/g, " ").trim()
}

function synthesizeSummaryTurn(
    compacted: Turn[],
    summary: string,
    transcriptRelativePath: string,
    compactedRangeHash = rangeHash(compacted),
): Turn {
    const key = `better_compact_summary_${compactedRangeHash}`
    const referenceBlock = `## Reference Files\n- "${transcriptRelativePath}"`
    const normalizedSummary = stripTranscriptReference(summary, transcriptRelativePath)
    return {
        key,
        stamp: 0,
        role: "user",
        items: [
            {
                kind: "synthetic",
                key,
                text: [
                    "[Context Summary]",
                    normalizedSummary,
                    "",
                    referenceBlock,
                ].join("\n"),
            },
        ],
    }
}

function stripTranscriptReference(summary: string, transcriptRelativePath: string): string {
    const trimmed = summary.trim()
    const referenceBlock = `## Reference Files\n- "${transcriptRelativePath}"`
    return trimmed.endsWith(referenceBlock) ? trimmed.slice(0, -referenceBlock.length).trimEnd() : trimmed
}

function cloneTurns(turns: Turn[]): Turn[] {
    return turns.map((turn) => ({ ...turn, items: [...turn.items] }))
}
