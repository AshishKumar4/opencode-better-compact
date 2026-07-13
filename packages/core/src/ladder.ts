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
} from "./plan"
import type { EnginePorts } from "./ports"
import {
    findLatestTodoCallId,
    findRawTailStartIndex,
    findRecentToolCallTail,
    formatPrefixSummary,
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

    const rawTailStartIndex = findRawTailStartIndex(
        turns,
        Math.max(1, inputs.minTailMessages ?? MIN_TAIL_MESSAGES),
        Math.max(1, inputs.minTailUserTurns ?? MIN_TAIL_USER_TURNS),
    )
    const compactedRange = turns.slice(0, rawTailStartIndex)
    if (compactedRange.length === 0) return null

    const compactedRangeHash = rangeHash(compactedRange)
    const transcriptRelativePath = inputs.citablePath(inputs.sessionKey, compactedRangeHash)
    const working = cloneTurns(turns)
    const stages: BoundaryStageReport[] = []
    const summaryJobs: BoundarySummaryJob[] = []
    const targetTokens = Math.floor(contextLimit * targetRatio)
    const prior = inputs.priorPlan
    const priorTailIndex = prior ? turns.findIndex((item) => item.key === prior.rawTailStartMessageId) : -1
    const preservedToolCallIds = findRecentToolCallTail(
        compactedRange,
        inputs.recentToolResultBudgetTokens ?? RECENT_TOOL_RESULT_BUDGET_TOKENS,
        spec.codec,
        spec.conventions,
    )
    applyPreservationFloor(turns, preservedToolCallIds, prior, priorTailIndex)
    const priorStages = new Set(
        (prior?.stages ?? [])
            .filter((stage) => stage.status !== "skipped" && stage.status !== "failed")
            .map((stage) => stage.name),
    )
    const ctx: StageContext = {
        codec: spec.codec,
        conventions: spec.conventions,
        estimator,
        rawTailStartIndex,
        transcriptRelativePath,
        preservedToolCallIds,
        latestTodoCallId: findLatestTodoCallId(compactedRange, spec.conventions),
        assistantSummaries: {
            ...(prior?.assistantSummaries ?? {}),
            ...(inputs.assistantSummaries ?? {}),
        },
        assistantSummaryKeys: new Set<string>(prior?.assistantSummaryKeys ?? []),
        summaryJobs,
        selectRuns: true,
        targetTokens,
        referenceTokens: 0,
    }
    // The applied output always carries a reference message; gates must account
    // for it so a "trigger met" claim holds for the real transformed context.
    const reference = synthesizeReferenceTurn(turns, compactedRange, transcriptRelativePath)
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
    const expandedPrefix = priorTailIndex >= 0 && rawTailStartIndex > priorTailIndex
    const priorPrefixSummary = prior?.prefixSummary
        ? stripTranscriptReference(prior.prefixSummary, prior.transcriptRelativePath)
        : undefined
    let prefixSummary = inputs.prefixSummary ?? (expandedPrefix ? undefined : priorPrefixSummary)
    if (projectedTokens() >= triggerTokens || prior?.requiresCustomCompaction) {
        const tailKey = turns[rawTailStartIndex]?.key
        const currentTailStartIndex = working.findIndex((turn) => turn.key === tailKey)
        const beforePrefix = projectedTokens()
        const result = applyPrefixSummary(
            working,
            currentTailStartIndex > 0 ? currentTailStartIndex : rawTailStartIndex,
            transcriptRelativePath,
            prefixSummary,
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
        rawTailStartMessageId: turns[rawTailStartIndex]?.key ?? turns.at(-1)?.key ?? "",
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
    const originalPrefix = turns.slice(0, rawTailStartIndex)
    if (plan.requiresCustomCompaction) {
        return [
            synthesizeSummaryTurn(
                originalPrefix,
                plan.prefixSummary || formatPrefixSummary(originalPrefix),
                plan.transcript.relativePath,
            ),
            ...turns.slice(rawTailStartIndex),
        ]
    }
    // Replay the recorded strip stages exactly as the planner simulated them,
    // then summarize assistant runs over the stripped prefix. This keeps the
    // applied output identical to the simulation used for the plan's numbers.
    const stageNames = new Set<string>(plan.stages.map((stage) => stage.name))
    const working = cloneTurns(turns)
    const ctx: StageContext = {
        codec: spec.codec,
        conventions: spec.conventions,
        estimator: { overheadTokens: plan.overheadTokens },
        rawTailStartIndex,
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
    let prefix = working.slice(0, rawTailStartIndex)
    if (stageNames.has("assistant-runs")) {
        prefix = transformCompactedPrefix(prefix, ctx)
    }
    const result = [...prefix]
    const reference = synthesizeReferenceTurn(turns, originalPrefix, plan.transcript.relativePath)
    if (reference) result.push(reference)
    result.push(...working.slice(rawTailStartIndex))
    return result
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
    const rawTailStartIndex = turns.findIndex((turn) => turn.key === snapshot.rawTailStartMessageId)
    if (rawTailStartIndex <= 0) return null
    // A stale plan must never apply to an edited prefix.
    if (rangeHash(turns.slice(0, rawTailStartIndex)) !== snapshot.rangeHash) return null
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
        // Side-model assistant-run summaries for the automatic path. When a
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
            summarize,
        }) {
            let staleSnapshotCleared = false
            let priorPlan: PlanSnapshot | undefined
            const cached = await ports.plans.load(sessionKey)
            if (cached && cached.sessionId === sessionKey) {
                const replayed = replayPlanSnapshot(turns, cached, spec)
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
                const assistantSummaries = await summarize(plan.summaryJobs)
                if (Object.keys(assistantSummaries).length > 0) {
                    plan = buildPlan(turns, { ...inputs, assistantSummaries }, spec) ?? plan
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
    turns: Turn[],
    preservedToolCallIds: Set<string>,
    prior: PlanSnapshot | undefined,
    priorTailIndex: number,
): void {
    if (!prior || priorTailIndex <= 0) return
    const previouslyPreserved = new Set(prior.preservedToolCallIds ?? [])
    for (let index = 0; index < priorTailIndex; index++) {
        for (const item of turns[index].items) {
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
): StageMutationResult & { prefixSummary: string } {
    if (rawTailStartIndex <= 0) {
        return { changedTurns: new Set<string>(), changedItems: 0, prefixSummary: prefixSummary ?? "" }
    }
    const compacted = working.slice(0, rawTailStartIndex)
    const summary = stripTranscriptReference(
        prefixSummary?.trim() || formatPrefixSummary(compacted),
        transcriptRelativePath,
    )
    const summaryTurn = synthesizeSummaryTurn(compacted, summary, transcriptRelativePath)
    const changedTurns = new Set(compacted.map((turn) => turn.key))
    const changedItems = compacted.reduce((sum, turn) => sum + turn.items.length, 0)
    const tail = working.slice(rawTailStartIndex)
    working.length = 0
    working.push(summaryTurn, ...tail)
    return { changedTurns, changedItems, prefixSummary: summary }
}

function synthesizeReferenceTurn(turns: Turn[], compacted: Turn[], transcriptRelativePath: string): Turn | null {
    if (!turns.some((turn) => turn.role === "user")) return null

    const hash = rangeHash(compacted)
    const first = compacted[0]?.key ?? "unknown"
    const last = compacted.at(-1)?.key ?? "unknown"
    const key = `better_compact_context_${hash}`
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
                    "## Reference Files",
                    `- "${transcriptRelativePath}"`,
                    "",
                    "If exact prior wording, raw tool output, or omitted implementation detail is needed, inspect the reference file instead of guessing.",
                ].join("\n"),
            },
        ],
    }
}

function synthesizeSummaryTurn(compacted: Turn[], summary: string, transcriptRelativePath: string): Turn {
    const key = `better_compact_summary_${rangeHash(compacted)}`
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
