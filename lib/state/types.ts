import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type BoundaryJobStatus = "running" | "completed" | "failed"
export type BoundaryStageStatus = "pending" | "running" | "completed" | "skipped" | "failed"

export interface BoundaryJobStage {
    id: string
    label: string
    status: BoundaryStageStatus
    detail?: string
    beforeTokens?: number
    afterTokens?: number
    clearedTokens?: number
    changedMessages?: number
    changedParts?: number
}

export interface BoundaryJobProgress {
    id: string
    sessionId: string
    status: BoundaryJobStatus
    currentStage: string
    percent: number
    stages: BoundaryJobStage[]
    logs: string[]
    counters: {
        messages?: number
        archivedMessages?: number
        summaryJobsTotal?: number
        summaryJobsDone?: number
        summaryJobsSucceeded?: number
        summaryJobsFailed?: number
        beforeTokens?: number
        afterTokens?: number
        currentTokens?: number
        targetTokens?: number
        contextLimit?: number
        stageClearedTokens?: number
        clearedTokens?: number
    }
    startedAt: number
    updatedAt: number
    completedAt?: number
    error?: string
}

export interface BoundaryState {
    compactingSessionId: string | null
    scratchSessionIds: Set<string>
    job: BoundaryJobProgress | null
    activePlan: {
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
    } | null
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    manualMode: false | "active" | "compress-pending"
    compressPermission: "ask" | "allow" | "deny" | undefined
    boundary: BoundaryState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
}
