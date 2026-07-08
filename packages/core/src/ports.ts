import type { BoundarySummaryJob, PlanSnapshot } from "./plan"

export interface Logger {
    info(message: string, data?: unknown): unknown
    debug(message: string, data?: unknown): unknown
    warn(message: string, data?: unknown): unknown
    error(message: string, data?: unknown): unknown
}

// Side-model transport. Returns the raw completion text, or null when the
// transport failed (the implementation logs its own failure detail); the
// scheduler validates and may still discard a non-null result.
export interface Summarizer {
    complete(job: BoundarySummaryJob): Promise<string | null>
}

export interface TranscriptStore {
    // The path the reference message cites, known before anything is
    // written because stage output embeds it. The store hides the
    // platform's path scheme.
    citablePath(sessionKey: string, rangeHash: string): string
    write(relativePath: string, content: string): Promise<{ absolutePath?: string }>
}

export interface PlanStore {
    load(sessionKey: string): Promise<PlanSnapshot | null> | PlanSnapshot | null
    // Saving null clears a stale plan.
    save(sessionKey: string, snapshot: PlanSnapshot | null): Promise<void> | void
}

export interface EnginePorts {
    transcripts: TranscriptStore
    plans: PlanStore
    logger: Logger
}
