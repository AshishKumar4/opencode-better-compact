import type { IncomingMessage } from "node:http"
import { contentHashKey } from "@better-compact/core"
import { createSummarizer } from "../summarizer"
import { createUsageReader } from "../usage"
import {
    createDialectRoute,
    errorEnvelope,
    type Dialect,
    type SharedRouteOptions,
} from "../route"
import { anthropicCodec, anthropicSpec, type WireMessage } from "./codec"

const DEFAULT_CONTEXT_LIMIT = 200_000
const CONTEXT_1M_LIMIT = 1_000_000

interface MessagesBody {
    model: string
    messages: WireMessage[]
    [key: string]: unknown
}

const anthropicDialect: Dialect<MessagesBody> = {
    name: "anthropic",
    rewritePath: "/v1/messages",
    spec: anthropicSpec,
    readBody(raw) {
        const body = JSON.parse(raw.toString("utf-8")) as MessagesBody
        if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
            throw new Error("Body has no messages array")
        }
        return { body, model: body.model }
    },
    sessionKeyOf(req, body) {
        return sessionKeyOf(req, body.messages)
    },
    contextLimit(req) {
        return contextLimitFor(req.headers["anthropic-beta"])
    },
    encode(body) {
        return anthropicCodec.encode(body.messages)
    },
    rewrite(body, turns) {
        const decoded = anthropicCodec.decode(turns, body.messages)
        return Buffer.from(JSON.stringify({ ...body, messages: decoded }))
    },
    createUsageReader,
    createSummarizer,
    errorBody(type, message) {
        return errorEnvelope("anthropic", type, message)
    },
}

export function createAnthropicRoute(options: SharedRouteOptions) {
    return createDialectRoute(options, anthropicDialect)
}

// Correlation: the x-session header when a client sends one; Claude Code
// sends none (verified against real transcripts and the reference clone), so
// the stable fallback is a content hash of the session's first user message.
function sessionKeyOf(req: IncomingMessage, messages: WireMessage[]): string {
    const header = req.headers["x-session"]
    const explicit = Array.isArray(header) ? header[0] : header
    if (explicit) return explicit
    const firstUser = messages.find((message) => message.role === "user")
    return contentHashKey(firstUser?.content ?? messages[0] ?? "empty")
}

function contextLimitFor(betaHeader: string | string[] | undefined): number {
    const betas = Array.isArray(betaHeader) ? betaHeader.join(",") : (betaHeader ?? "")
    return betas.includes("context-1m") ? CONTEXT_1M_LIMIT : DEFAULT_CONTEXT_LIMIT
}
