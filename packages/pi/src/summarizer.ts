import type { Logger, Summarizer } from "@better-compact/core"
import type { TextContent } from "@earendil-works/pi-ai"
import { complete } from "@earendil-works/pi-ai/compat"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

const SUMMARY_MAX_TOKENS = 8_192

// Side-model transport: one non-streaming completion per job on the session's
// current model, authenticated through pi's own credential resolution.
export function createSummarizer(
    ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
    logger: Logger,
): Summarizer {
    return {
        async complete(job) {
            const model = ctx.model
            if (!model) {
                logger.warn("Better Compact summary skipped: no active model")
                return null
            }
            try {
                const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
                if (!auth.ok) {
                    logger.warn("Better Compact summary auth failed", { error: auth.error })
                    return null
                }
                const response = await complete(
                    model,
                    { messages: [{ role: "user", content: [{ type: "text", text: job.prompt }], timestamp: Date.now() }] },
                    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: SUMMARY_MAX_TOKENS },
                )
                if (response.stopReason === "error" || response.stopReason === "aborted") {
                    logger.warn("Better Compact summary completion failed", { error: response.errorMessage })
                    return null
                }
                return response.content
                    .filter((block): block is TextContent => block.type === "text")
                    .map((block) => block.text)
                    .join("\n\n")
            } catch (error) {
                logger.warn("Better Compact summary transport failed", {
                    rangeStartMessageId: job.rangeStartMessageId,
                    rangeEndMessageId: job.rangeEndMessageId,
                    error: error instanceof Error ? error.message : String(error),
                })
                return null
            }
        },
    }
}
