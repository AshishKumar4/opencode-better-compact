import type { Turn } from "./ir"

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
    status: "applied" | "skipped" | "target-met" | "failed"
}

export interface BoundarySummaryJob {
    key: string
    rangeStartMessageId: string
    rangeEndMessageId: string
    transcriptRelativePath: string
    prompt: string
}

export interface BoundaryTranscriptArtifact {
    relativePath: string
    absolutePath?: string
    content: string
    messageIds: string[]
    turns?: Turn[]
}

export interface BoundaryContextOptions {
    contextLimit?: number
    triggerRatio?: number
    targetRatio?: number
    minTailMessages?: number
    minTailUserTurns?: number
    recentToolResultBudgetTokens?: number
    force?: boolean
    assistantSummaries?: Record<string, string>
    prefixSummary?: string
    providerReportedTokens?: number
}

export interface BoundaryContextPlan {
    sessionId: string
    rangeHash: string
    contextLimit: number
    beforeTokens: number
    afterPruneTokens: number
    overheadTokens: number
    triggerTokens: number
    targetTokens: number
    rawTailStartIndex: number
    rawTailStartMessageId: string
    requiresCustomCompaction: boolean
    preservedToolCallIds: string[]
    transcript: BoundaryTranscriptArtifact
    stages: BoundaryStageReport[]
    summaryJobs: BoundarySummaryJob[]
    assistantSummaryKeys: string[]
    assistantSummaries: Record<string, string>
    prefixSummary?: string
}

// The durable, replayable subset of a plan. Field shapes are a persistence
// surface: snapshots written by earlier releases must keep loading.
export interface PlanSnapshot {
    sessionId: string
    rangeHash: string
    contextLimit: number
    rawTailStartMessageId: string
    transcriptRelativePath: string
    beforeTokens: number
    afterPruneTokens: number
    // Optional: absent in plans persisted before overhead tracking existed.
    overheadTokens?: number
    triggerTokens: number
    targetTokens: number
    requiresCustomCompaction: boolean
    preservedToolCallIds?: string[]
    assistantSummaryKeys?: string[]
    assistantSummaries?: Record<string, string>
    prefixSummary?: string
    stages?: Array<{
        name: string
        label: string
        beforeTokens: number
        afterTokens: number
        clearedTokens: number
        changedMessages: number
        changedParts: number
        status: string
    }>
    createdAt: number
}

export function toPlanSnapshot(plan: BoundaryContextPlan): PlanSnapshot {
    return {
        sessionId: plan.sessionId,
        rangeHash: plan.rangeHash,
        contextLimit: plan.contextLimit,
        rawTailStartMessageId: plan.rawTailStartMessageId,
        transcriptRelativePath: plan.transcript.relativePath,
        beforeTokens: plan.beforeTokens,
        afterPruneTokens: plan.afterPruneTokens,
        overheadTokens: plan.overheadTokens,
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
