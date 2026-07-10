import type { OutgoingHttpHeaders } from "node:http"
import type { Logger, Summarizer } from "@better-compact/core"
import { requestUpstream } from "./upstream"

const SUMMARY_MAX_TOKENS = 4_096

// Side-model transport: one non-streaming /v1/messages call per job on the
// session's own model, reusing the exact credentials and headers of the
// request being served — no separate credential path to configure or leak.
export function createSummarizer(
    upstream: URL,
    model: string,
    headers: OutgoingHttpHeaders,
    logger: Logger,
): Summarizer {
    return {
        async complete(job) {
            const body = Buffer.from(
                JSON.stringify({
                    model,
                    max_tokens: SUMMARY_MAX_TOKENS,
                    messages: [{ role: "user", content: [{ type: "text", text: job.prompt }] }],
                }),
            )
            try {
                const response = await requestUpstream(upstream, {
                    method: "POST",
                    path: "/v1/messages",
                    headers: {
                        ...headers,
                        accept: "application/json",
                        "content-type": "application/json",
                    },
                    body,
                })
                const chunks: Buffer[] = []
                for await (const chunk of response) chunks.push(chunk as Buffer)
                const text = Buffer.concat(chunks).toString("utf-8")
                if (!response.statusCode || response.statusCode >= 300) {
                    logger.warn("Better Compact summary completion failed", {
                        status: response.statusCode,
                        body: text.slice(0, 400),
                    })
                    return null
                }
                const parsed = JSON.parse(text) as {
                    content?: Array<{ type?: string; text?: string }>
                }
                return (parsed.content ?? [])
                    .filter((block) => block.type === "text" && typeof block.text === "string")
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
