import type { PlanSnapshot } from "@better-compact/core"
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
    scratchSessionIds: Set<string>
    // In-memory only (never persisted): sessions with a Better Compact run in flight.
    runningSessionIds: Set<string>
    job: BoundaryJobProgress | null
    activePlan: PlanSnapshot | null
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
