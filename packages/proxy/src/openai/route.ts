import type { IncomingMessage } from "node:http"
import { contentHashKey } from "@better-compact/core"
import { createResponsesSummarizer } from "../summarizer"
import { createResponsesUsageReader } from "../usage"
import {
    createDialectRoute,
    errorEnvelope,
    type Dialect,
    type SharedRouteOptions,
} from "../route"
import { openaiCodec, openaiSpec, type ResponseItemWire } from "./codec"

// Codex's gpt-5-codex family reports a 272k window; other models can be larger,
// but there is no per-request signal for it, so we default conservatively —
// under-estimating the window only prunes sooner, never breaks a request.
const DEFAULT_CONTEXT_LIMIT = 272_000

interface ResponsesBody {
    model: string
    input: ResponseItemWire[]
    prompt_cache_key?: string
    [key: string]: unknown
}

const openaiDialect: Dialect<ResponsesBody> = {
    name: "openai",
    rewritePath: "/responses",
    spec: openaiSpec,
    readBody(raw) {
        const body = JSON.parse(raw.toString("utf-8")) as ResponsesBody
        if (!body || typeof body !== "object" || !Array.isArray(body.input)) {
            throw new Error("Body has no input array")
        }
        return { body, model: body.model }
    },
    sessionKeyOf,
    contextLimit() {
        return DEFAULT_CONTEXT_LIMIT
    },
    encode(body) {
        return openaiCodec.encode(body.input)
    },
    rewrite(body, turns) {
        const decoded = openaiCodec.decode(turns, body.input)
        return Buffer.from(JSON.stringify({ ...body, input: decoded }))
    },
    createUsageReader: createResponsesUsageReader,
    createSummarizer: createResponsesSummarizer,
    errorBody(type, message) {
        return errorEnvelope("openai", type, message)
    },
}

export function createOpenAIRoute(options: SharedRouteOptions) {
    return createDialectRoute(options, openaiDialect)
}

// Correlation precedence (verified against codex-api headers + request build):
// the `thread-id` request header, else the body's `prompt_cache_key` (which
// Codex sets to the thread id), else a content hash of the first user item.
function sessionKeyOf(req: IncomingMessage, body: ResponsesBody): string {
    const header = req.headers["thread-id"] ?? req.headers["session-id"]
    const explicit = Array.isArray(header) ? header[0] : header
    if (explicit) return explicit
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) {
        return body.prompt_cache_key
    }
    const firstUser = body.input.find(
        (item) => item.type === "message" && (item as { role?: string }).role === "user",
    )
    return contentHashKey(firstUser ?? body.input[0] ?? "empty")
}
