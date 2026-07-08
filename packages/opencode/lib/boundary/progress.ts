import type { BoundaryJobProgress, BoundaryJobStage, BoundaryStageStatus, SessionState } from "../state"

export const BOUNDARY_PROGRESS_STAGES: Array<Pick<BoundaryJobStage, "id" | "label">> = [
    { id: "load", label: "Loaded session history" },
    { id: "scan", label: "Scanned context and token budget" },
    { id: "transcript", label: "Wrote raw transcript reference" },
    { id: "skills", label: "Pruned loaded skills" },
    { id: "tools-old", label: "Pruned old tool calls/results" },
    { id: "reasoning", label: "Pruned thinking tokens" },
    { id: "tools-remaining", label: "Pruned remaining tool calls/results" },
    { id: "assistant-runs", label: "Summarized assistant turns" },
    { id: "prefix-summary", label: "Applied last-resort prefix summary" },
    { id: "store", label: "Stored Better Compact context plan" },
    { id: "report", label: "Published final report" },
]

export function startBoundaryJob(state: SessionState, sessionId: string): BoundaryJobProgress {
    const now = Date.now()
    const job: BoundaryJobProgress = {
        id: `bc_${now.toString(36)}`,
        sessionId,
        status: "running",
        currentStage: "Starting",
        percent: 0,
        stages: BOUNDARY_PROGRESS_STAGES.map((stage) => ({ ...stage, status: "pending" })),
        logs: ["Starting Better Compact."],
        counters: {},
        startedAt: now,
        updatedAt: now,
    }
    state.boundary.job = job
    return job
}

export function setBoundaryStage(
    state: SessionState,
    id: string,
    status: BoundaryStageStatus,
    detail?: string,
    metrics?: Partial<BoundaryJobStage>,
): void {
    const job = state.boundary.job
    if (!job) return
    const stage = job.stages.find((item) => item.id === id)
    if (!stage) return
    stage.status = status
    stage.detail = detail ?? stage.detail
    if (metrics) Object.assign(stage, metrics)
    job.currentStage = status === "running" ? stage.label : job.currentStage
    if (status === "completed" || status === "skipped" || status === "failed") {
        job.currentStage = stage.label
    }
    touchBoundaryJob(job)
}

export function appendBoundaryLog(state: SessionState, message: string): void {
    const job = state.boundary.job
    if (!job) return
    job.logs.push(message)
    if (job.logs.length > 80) job.logs = job.logs.slice(-80)
    touchBoundaryJob(job)
}

export function updateBoundaryCounters(
    state: SessionState,
    counters: Partial<BoundaryJobProgress["counters"]>,
): void {
    const job = state.boundary.job
    if (!job) return
    job.counters = { ...job.counters, ...counters }
    touchBoundaryJob(job)
}

export function updateBoundaryPercent(state: SessionState): void {
    const job = state.boundary.job
    if (!job) return
    const completed = job.stages.filter((stage) => stage.status === "completed" || stage.status === "skipped").length
    const runningBonus = job.stages.some((stage) => stage.status === "running") ? 0.5 : 0
    job.percent = Math.max(0, Math.min(99, Math.round(((completed + runningBonus) / job.stages.length) * 100)))
    touchBoundaryJob(job)
}

export function completeBoundaryJob(state: SessionState, detail?: string): void {
    const job = state.boundary.job
    if (!job) return
    job.status = "completed"
    job.currentStage = detail ?? "Complete"
    job.percent = 100
    job.completedAt = Date.now()
    touchBoundaryJob(job)
}

export function failBoundaryJob(state: SessionState, error: string): void {
    const job = state.boundary.job
    if (!job) return
    job.status = "failed"
    job.currentStage = "Failed"
    job.error = error
    job.completedAt = Date.now()
    touchBoundaryJob(job)
}

function touchBoundaryJob(job: BoundaryJobProgress): void {
    job.updatedAt = Date.now()
}
