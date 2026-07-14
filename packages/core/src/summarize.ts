import type { CodecOps, Turn } from "./ir"
import type { BoundarySummaryJob } from "./plan"
import type { Logger, Summarizer } from "./ports"
import { formatTranscript } from "./transcript"

const DEFAULT_CONCURRENCY = 4
const MIN_SUMMARY_CHARS = 80
const MAX_SUMMARY_CHARS = 4_000
const FAILURE_THRESHOLD = 3
const BREAKER_WINDOW_MS = 5 * 60_000

export const SUMMARY_SECTION_HEADERS = [
    "## Decisions",
    "## Files & Symbols",
    "## Errors (verbatim)",
    "## What failed and why",
    "## Constraints",
    "## Next step",
] as const

export interface SummarizeProgressEvent {
    total: number
    done: number
    succeeded: number
    failed: number
    ok: boolean
    rangeStartMessageId: string
    rangeEndMessageId: string
}

export interface SummarizeJobsInput {
    sessionKey: string
    jobs: BoundarySummaryJob[]
    summarizer: Summarizer
    concurrency?: number
    onProgress?: (event: SummarizeProgressEvent) => Promise<void> | void
}

export interface SummaryScheduler {
    summarize(input: SummarizeJobsInput): Promise<Record<string, string>>
    reset(sessionKey: string): void
}

export interface SummarySchedulerOptions {
    now?: () => number
}

interface FailureState {
    consecutiveFailures: number
    lastFailureAt: number
    openUntil?: number
}

export function createSummaryScheduler(
    logger: Logger,
    options: SummarySchedulerOptions = {},
): SummaryScheduler {
    const now = options.now ?? Date.now
    const failures = new Map<string, FailureState>()

    return {
        async summarize(input) {
            if (input.jobs.length === 0) return {}

            const startedAt = now()
            expireFailures(failures, startedAt)
            const state = failures.get(input.sessionKey)
            if (state?.openUntil && state.openUntil > startedAt) {
                logger.debug("Summary circuit breaker is open; using deterministic fallback", {
                    sessionKey: input.sessionKey,
                    retryAfterMs: state.openUntil - startedAt,
                })
                return {}
            }

            const summaries: Record<string, string> = {}
            const pending = dedupeJobs(input.jobs)
            const concurrency = Math.max(
                1,
                Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, pending.length),
            )
            let done = 0
            let succeeded = 0
            let failed = 0

            for (let offset = 0; offset < pending.length; offset += concurrency) {
                const jobs = pending.slice(offset, offset + concurrency)
                const outcomes = await Promise.all(
                    jobs.map((job) => runJob(input.sessionKey, job, input.summarizer, logger)),
                )

                for (let index = 0; index < jobs.length; index++) {
                    const job = jobs[index]
                    const summary = outcomes[index]
                    if (summary) {
                        summaries[job.key] = summary
                        succeeded++
                    } else {
                        failed++
                    }
                    done++
                    await input.onProgress?.({
                        total: pending.length,
                        done,
                        succeeded,
                        failed,
                        ok: !!summary,
                        rangeStartMessageId: job.rangeStartMessageId,
                        rangeEndMessageId: job.rangeEndMessageId,
                    })
                }

                updateFailureState(
                    failures,
                    input.sessionKey,
                    outcomes.map(Boolean),
                    now(),
                    logger,
                )
                if (failures.get(input.sessionKey)?.openUntil) break
            }

            return summaries
        },
        reset(sessionKey) {
            failures.delete(sessionKey)
        },
    }
}

async function runJob(
    sessionKey: string,
    job: BoundarySummaryJob,
    summarizer: Summarizer,
    logger: Logger,
): Promise<string | null> {
    try {
        const raw = await summarizer.complete(job)
        return raw === null ? null : validateSummary(raw, job, logger)
    } catch (error) {
        logger.warn("Summary job failed", {
            sessionKey,
            rangeStartMessageId: job.rangeStartMessageId,
            rangeEndMessageId: job.rangeEndMessageId,
            error: error instanceof Error ? error.message : String(error),
        })
        return null
    }
}

function expireFailures(failures: Map<string, FailureState>, now: number): void {
    for (const [sessionKey, state] of failures) {
        const expiresAt = state.openUntil ?? state.lastFailureAt + BREAKER_WINDOW_MS
        if (expiresAt <= now) failures.delete(sessionKey)
    }
}

function updateFailureState(
    failures: Map<string, FailureState>,
    sessionKey: string,
    outcomes: boolean[],
    now: number,
    logger: Logger,
): void {
    let state = failures.get(sessionKey)
    // Stable input order keeps concurrency timing from changing breaker state.
    for (const succeeded of outcomes) {
        if (succeeded) {
            failures.delete(sessionKey)
            state = undefined
            continue
        }
        state = state ?? { consecutiveFailures: 0, lastFailureAt: now }
        state.consecutiveFailures++
        state.lastFailureAt = now
        if (state.consecutiveFailures === FAILURE_THRESHOLD) {
            state.openUntil = now + BREAKER_WINDOW_MS
            logger.warn("Summary circuit breaker opened", {
                sessionKey,
                consecutiveFailures: state.consecutiveFailures,
                retryAfterMs: BREAKER_WINDOW_MS,
            })
        }
        failures.set(sessionKey, state)
    }
}

export function formatAssistantSummaryPrompt(
    turns: Turn[],
    transcriptRelativePath: string,
    codec: CodecOps,
): string {
    const first = turns[0]?.key ?? "unknown"
    const last = turns.at(-1)?.key ?? first
    return [
        "Summarize this historical assistant turn for future context replay.",
        ...summarySchemaInstructions(),
        "Do not include raw tool JSON, command output dumps, or filler narration.",
        "Do not rewrite or invent user intent. User messages stay raw elsewhere.",
        `Keep the completed summary within ${MAX_SUMMARY_CHARS} characters.`,
        `Raw transcript reference: ${transcriptRelativePath}`,
        `Range: ${first} through ${last}`,
        "",
        formatSummarySections(
            SUMMARY_SECTION_HEADERS.map(() => ["(fill from transcript or use (none))"]),
        ),
        "",
        "Source transcript:",
        "",
        formatTranscript(turns, codec),
    ].join("\n")
}

export function formatPrefixSummaryPrompt(
    previousSummary: string,
    deltaTurns: Turn[],
    transcriptRelativePath: string,
    codec: CodecOps,
): string {
    const first = deltaTurns[0]?.key ?? "unknown"
    const last = deltaTurns.at(-1)?.key ?? first
    return [
        "Roll this prior prefix summary forward for future context replay.",
        ...summarySchemaInstructions(),
        "Keep every still-valid fact from the prior checkpoint and incorporate only the newly compacted delta.",
        "Do not include raw tool JSON, command output dumps, or filler narration.",
        `Keep the completed summary within ${MAX_SUMMARY_CHARS} characters.`,
        `Raw transcript reference: ${transcriptRelativePath}`,
        `New delta range: ${first} through ${last}`,
        "",
        formatSummarySections(
            SUMMARY_SECTION_HEADERS.map(() => ["(merge prior checkpoint with delta, or use (none))"]),
        ),
        "",
        "Prior prefix summary:",
        "",
        previousSummary,
        "",
        "Newly compacted delta transcript:",
        "",
        formatTranscript(deltaTurns, codec),
    ].join("\n")
}

export function formatSummarySections(sections: readonly (readonly string[])[]): string {
    return SUMMARY_SECTION_HEADERS.flatMap((header, index) => {
        const items = sections[index] ?? []
        return [header, ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- (none)"]), ""]
    })
        .slice(0, -1)
        .join("\n")
}

function summarySchemaInstructions(): string[] {
    return [
        "Return only the fixed Markdown schema below, with itemized entries under every heading.",
        "Use '- (none)' when the transcript contains no evidence for a section.",
        "Preserve exact paths, symbols, error strings, and IDs verbatim, including tool/call, message, session, and request IDs.",
        "Preserve concrete conclusions, decisions, failures, constraints, and next-step state without inventing facts.",
    ]
}

function dedupeJobs(jobs: BoundarySummaryJob[]): BoundarySummaryJob[] {
    const seen = new Set<string>()
    return jobs.filter((job) => {
        if (seen.has(job.key)) return false
        seen.add(job.key)
        return true
    })
}

function validateSummary(text: string, job: BoundarySummaryJob, logger: Logger): string | null {
    const summary = text.trim().slice(0, MAX_SUMMARY_CHARS).trimEnd()
    const lines = summary.split(/\r\n|\n|\r/).map((line) => line.trim())
    let headerIndex = -1
    const hasRequiredSections = SUMMARY_SECTION_HEADERS.every((header) => {
        headerIndex = lines.indexOf(header, headerIndex + 1)
        return headerIndex >= 0
    })
    if (summary.length < MIN_SUMMARY_CHARS || !hasRequiredSections) {
        logger.warn("Discarded invalid Better Compact scratch summary", {
            rangeStartMessageId: job.rangeStartMessageId,
            rangeEndMessageId: job.rangeEndMessageId,
            length: summary.length,
            hasRequiredSections,
        })
        return null
    }
    return summary
}
