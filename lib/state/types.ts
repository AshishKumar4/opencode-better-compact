import type { CompressionTimingState } from "../compress/timing"
import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    turn: number
    tokenCount?: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface PrunedMessageEntry {
    tokenCount: number
    allBlockIds: number[]
    activeBlockIds: number[]
}

export type CompressionMode = "range" | "message"

export interface CompressionBlock {
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    compressedTokens: number
    summaryTokens: number
    durationMs: number
    mode?: CompressionMode
    topic: string
    batchTopic?: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressCallId?: string
    includedBlockIds: number[]
    consumedBlockIds: number[]
    parentBlockIds: number[]
    directMessageIds: string[]
    directToolIds: string[]
    effectiveMessageIds: string[]
    effectiveToolIds: string[]
    createdAt: number
    deactivatedAt?: number
    deactivatedByBlockId?: number
    summary: string
}

export interface PruneMessagesState {
    byMessageId: Map<string, PrunedMessageEntry>
    blocksById: Map<number, CompressionBlock>
    activeBlockIds: Set<number>
    activeByAnchorMessageId: Map<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface Prune {
    tools: Map<string, number>
    messages: PruneMessagesState
}

export interface PendingManualTrigger {
    sessionId: string
    prompt: string
}

export interface MessageIdState {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRef: number
}

export interface Nudges {
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    iterationNudgeAnchors: Set<string>
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
        rawTailStartMessageId: string
        transcriptRelativePath: string
        beforeTokens: number
        afterPruneTokens: number
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
    pendingManualTrigger: PendingManualTrigger | null
    prune: Prune
    nudges: Nudges
    boundary: BoundaryState
    stats: SessionStats
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    subAgentResultCache: Map<string, string>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
    systemPromptTokens: number | undefined
}
