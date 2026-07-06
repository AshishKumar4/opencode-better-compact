import type { Logger } from "../logger"
import type { RuntimeState } from "../state"
import type { BoundarySummaryJob } from "./context"

const DEFAULT_CONCURRENCY = 4
const MIN_SUMMARY_CHARS = 80
const MAX_SUMMARY_CHARS = 4_000

interface SummarizeBoundaryJobsInput {
    client: any
    runtime: RuntimeState
    logger: Logger
    parentSessionId: string
    jobs: BoundarySummaryJob[]
    params: {
        providerId: string | undefined
        modelId: string | undefined
        agent: string | undefined
        variant: string | undefined
    }
    concurrency?: number
    onProgress?: (event: {
        total: number
        done: number
        succeeded: number
        failed: number
        ok: boolean
        rangeStartMessageId: string
        rangeEndMessageId: string
    }) => Promise<void> | void
}

export async function summarizeBoundaryJobs(input: SummarizeBoundaryJobsInput): Promise<Record<string, string>> {
    if (input.jobs.length === 0 || !canRunScratchSession(input.client)) return {}

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
                const summary = await summarizeOne(input, job)
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

function canRunScratchSession(client: any): boolean {
    return (
        typeof client?.session?.create === "function" &&
        typeof client?.session?.prompt === "function" &&
        typeof client?.session?.delete === "function"
    )
}

function dedupeJobs(jobs: BoundarySummaryJob[]): BoundarySummaryJob[] {
    const seen = new Set<string>()
    return jobs.filter((job) => {
        if (seen.has(job.key)) return false
        seen.add(job.key)
        return true
    })
}

async function summarizeOne(input: SummarizeBoundaryJobsInput, job: BoundarySummaryJob): Promise<string | null> {
    let scratchSessionId: string | undefined
    let untrackScratch: (() => void) | undefined
    try {
        const created = await input.client.session.create({
            body: {
                parentID: input.parentSessionId,
                title: `Better Compact summary ${job.rangeStartMessageId}`,
                agent: input.params.agent,
                model:
                    input.params.providerId && input.params.modelId
                        ? { providerID: input.params.providerId, modelID: input.params.modelId }
                        : undefined,
                metadata: {
                    betterCompactScratch: true,
                    parentSessionId: input.parentSessionId,
                    rangeStartMessageId: job.rangeStartMessageId,
                    rangeEndMessageId: job.rangeEndMessageId,
                },
            },
        })
        scratchSessionId = created?.data?.id ?? created?.id
        if (!scratchSessionId) return null
        untrackScratch = input.runtime.trackScratch(scratchSessionId)

        const response = await input.client.session.prompt({
            path: { id: scratchSessionId },
            body: {
                agent: input.params.agent,
                model:
                    input.params.providerId && input.params.modelId
                        ? { providerID: input.params.providerId, modelID: input.params.modelId }
                        : undefined,
                variant: input.params.variant,
                parts: [{ type: "text", text: job.prompt }],
            },
        })
        const summary = extractAssistantText(response?.data ?? response)
        const validated = validateSummary(summary)
        if (!validated) {
            input.logger.warn("Discarded invalid Better Compact scratch summary", {
                rangeStartMessageId: job.rangeStartMessageId,
                rangeEndMessageId: job.rangeEndMessageId,
                length: summary.length,
            })
        }
        return validated
    } catch (error) {
        input.logger.warn("Better Compact scratch summarization failed", {
            rangeStartMessageId: job.rangeStartMessageId,
            rangeEndMessageId: job.rangeEndMessageId,
            error: error instanceof Error ? error.message : String(error),
        })
        return null
    } finally {
        if (scratchSessionId) {
            try {
                await input.client.session.delete({ path: { id: scratchSessionId } })
            } catch (error) {
                input.logger.warn("Failed to delete Better Compact scratch session", {
                    scratchSessionId,
                    error: error instanceof Error ? error.message : String(error),
                })
            } finally {
                untrackScratch?.()
            }
        }
    }
}

function extractAssistantText(message: any): string {
    const parts = Array.isArray(message?.parts) ? message.parts : []
    return parts
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n\n")
        .trim()
}

function validateSummary(text: string): string | null {
    const summary = text.trim()
    if (summary.length < MIN_SUMMARY_CHARS) return null
    if (summary.length > MAX_SUMMARY_CHARS) return summary.slice(0, MAX_SUMMARY_CHARS).trimEnd()
    return summary
}
