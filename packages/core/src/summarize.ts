import type { CodecOps, Turn } from "./ir"
import type { BoundarySummaryJob } from "./plan"
import type { Logger, Summarizer } from "./ports"
import { formatTranscript } from "./transcript"

const DEFAULT_CONCURRENCY = 4
const MIN_SUMMARY_CHARS = 80
const MAX_SUMMARY_CHARS = 4_000

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
    jobs: BoundarySummaryJob[]
    summarizer: Summarizer
    logger: Logger
    concurrency?: number
    onProgress?: (event: SummarizeProgressEvent) => Promise<void> | void
}

export async function summarizeJobs(input: SummarizeJobsInput): Promise<Record<string, string>> {
    if (input.jobs.length === 0) return {}

    const summaries: Record<string, string> = {}
    const pending = [...dedupeJobs(input.jobs)]
    const concurrency = Math.max(1, Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, pending.length))
    let cursor = 0
    let done = 0
    let succeeded = 0
    let failed = 0

    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (cursor < pending.length) {
                const job = pending[cursor++]
                const raw = await input.summarizer.complete(job)
                const summary = raw === null ? null : validateSummary(raw, job, input.logger)
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
        }),
    )

    return summaries
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
        "Return only the fixed Markdown schema below, with itemized entries under every heading.",
        "Use '- (none)' when the transcript contains no evidence for a section.",
        "Preserve exact paths, symbols, error strings, and IDs verbatim, including tool/call, message, session, and request IDs.",
        "Preserve concrete conclusions, decisions, failures, constraints, and next-step state without inventing facts.",
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

export function formatSummarySections(sections: readonly (readonly string[])[]): string {
    return SUMMARY_SECTION_HEADERS.flatMap((header, index) => {
        const items = sections[index] ?? []
        return [header, ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- (none)"]), ""]
    })
        .slice(0, -1)
        .join("\n")
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
