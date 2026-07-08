import {
    summarizeJobs,
    type BoundarySummaryJob,
    type SummarizeProgressEvent,
    type Summarizer,
} from "@better-compact/core"
import type { Logger } from "../logger"
import type { SessionState } from "../state"

interface SummarizeBoundaryJobsInput {
    client: any
    state: SessionState
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
    onProgress?: (event: SummarizeProgressEvent) => Promise<void> | void
}

export async function summarizeBoundaryJobs(input: SummarizeBoundaryJobsInput): Promise<Record<string, string>> {
    if (input.jobs.length === 0 || !canRunScratchSession(input.client)) return {}
    return summarizeJobs({
        jobs: input.jobs,
        summarizer: createScratchSummarizer(input),
        logger: input.logger,
        concurrency: input.concurrency,
        onProgress: input.onProgress,
    })
}

function canRunScratchSession(client: any): boolean {
    return (
        typeof client?.session?.create === "function" &&
        typeof client?.session?.prompt === "function" &&
        typeof client?.session?.delete === "function"
    )
}

// Side-model transport: one throwaway OpenCode scratch session per job.
function createScratchSummarizer(input: SummarizeBoundaryJobsInput): Summarizer {
    return {
        async complete(job) {
            let scratchSessionId: string | undefined
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
                input.state.boundary.scratchSessionIds.add(scratchSessionId)

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
                return extractAssistantText(response?.data ?? response)
            } catch (error) {
                input.logger.warn("Better Compact scratch summarization failed", {
                    rangeStartMessageId: job.rangeStartMessageId,
                    rangeEndMessageId: job.rangeEndMessageId,
                    error: error instanceof Error ? error.message : String(error),
                })
                return null
            } finally {
                if (scratchSessionId) {
                    input.state.boundary.scratchSessionIds.delete(scratchSessionId)
                    try {
                        await input.client.session.delete({ path: { id: scratchSessionId } })
                    } catch (error) {
                        input.logger.warn("Failed to delete Better Compact scratch session", {
                            scratchSessionId,
                            error: error instanceof Error ? error.message : String(error),
                        })
                    }
                }
            }
        },
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
