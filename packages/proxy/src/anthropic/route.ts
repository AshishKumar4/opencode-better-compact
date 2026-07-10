import { mkdir, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join } from "node:path"
import {
    buildPlan,
    contentHashKey,
    createEngine,
    summarizeJobs,
    toPlanSnapshot,
    type BoundaryContextPlan,
    type BuildPlanInputs,
    type CompactionProfile,
    type EnginePorts,
    type Logger,
    type PlanStore,
    type TranscriptStore,
    type Turn,
} from "@better-compact/core"
import { createSummarizer } from "../summarizer"
import type { SessionTracker } from "../sessions"
import { forwardableHeaders, requestUpstream } from "../upstream"
import { createUsageReader } from "../usage"
import { sanitizeKey } from "../stores"
import { anthropicCodec, anthropicSpec, type WireMessage } from "./codec"

const DEFAULT_CONTEXT_LIMIT = 200_000
const CONTEXT_1M_LIMIT = 1_000_000

export interface AnthropicRouteOptions {
    upstream: URL
    profile: CompactionProfile
    plans: PlanStore
    transcripts: TranscriptStore
    sessions: SessionTracker
    logger: Logger
    capture: boolean
    capturesDir: string
    debugDir: string
}

interface MessagesBody {
    model: string
    messages: WireMessage[]
    [key: string]: unknown
}

interface Rewrite {
    body: Buffer
    pruned: boolean
    sessionKey: string | null
}

export function createAnthropicRoute(options: AnthropicRouteOptions) {
    const ports: EnginePorts = {
        transcripts: options.transcripts,
        plans: options.plans,
        logger: options.logger,
    }

    return async function handle(
        req: IncomingMessage,
        res: ServerResponse,
        path: string,
    ): Promise<void> {
        if (req.method !== "POST" || path.split("?")[0] !== "/v1/messages") {
            await passthrough(req, res, path, options)
            return
        }

        const raw = await bufferBody(req)
        const rewrite = await rewriteMessages(raw, req, options, ports)
        if (options.capture) {
            void captureBody(raw, rewrite.sessionKey, options).catch(() => {})
        }

        let upstream: IncomingMessage
        try {
            upstream = await requestUpstream(options.upstream, {
                method: "POST",
                path,
                headers: forwardableHeaders(req.rawHeaders),
                body: rewrite.body,
            })
        } catch (error) {
            respondGatewayError(res, error, options.logger)
            return
        }

        const status = upstream.statusCode ?? 502
        options.logger.info("anthropic /v1/messages", {
            sessionKey: rewrite.sessionKey,
            pruned: rewrite.pruned,
            status,
            originalBytes: raw.length,
            sentBytes: rewrite.body.length,
        })
        if (rewrite.pruned && status >= 400 && status < 500) {
            void dumpRewrittenBody(rewrite, status, options).catch(() => {})
        }

        const usage = createUsageReader(upstream.headers)
        relay(upstream, res, {
            onChunk: (chunk) => usage.feed(chunk),
            onEnd: async () => {
                const tokens = await usage.finish()
                if (tokens !== null && rewrite.sessionKey && status < 300) {
                    options.sessions.recordUsage(rewrite.sessionKey, tokens, rewrite.pruned)
                }
            },
        })
    }
}

// Failure posture: ANY internal error in the rewrite pipeline logs and
// forwards the original bytes unmodified — the session must never break
// because of us. There is no retry-with-original; a rewrite either applies
// cleanly or does not happen.
async function rewriteMessages(
    raw: Buffer,
    req: IncomingMessage,
    options: AnthropicRouteOptions,
    ports: EnginePorts,
): Promise<Rewrite> {
    let sessionKey: string | null = null
    try {
        const body = JSON.parse(raw.toString("utf-8")) as MessagesBody
        if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
            throw new Error("Body has no messages array")
        }
        sessionKey = sessionKeyOf(req, body.messages)
        const runtime = options.sessions.runtime(sessionKey)
        const contextLimit = contextLimitFor(req.headers["anthropic-beta"])
        const turns = anthropicCodec.encode(body.messages)
        const planInputs: BuildPlanInputs = {
            contextLimit,
            triggerRatio: options.profile.triggerPercent / 100,
            targetRatio: options.profile.targetPercent / 100,
            recentToolResultBudgetTokens: options.profile.recentToolTokens,
            sessionKey,
            citablePath: options.transcripts.citablePath,
        }
        const result = await createEngine(anthropicSpec, ports).process({
            sessionKey,
            turns,
            contextLimit,
            triggerRatio: planInputs.triggerRatio,
            targetRatio: planInputs.targetRatio,
            recentToolResultBudgetTokens: planInputs.recentToolResultBudgetTokens,
            providerReportedTokens: runtime.reportedTokens,
        })
        if (result.outcome === "unchanged") return { body: raw, pruned: false, sessionKey }

        const decoded = anthropicCodec.decode(result.turns, body.messages)
        const rewritten = Buffer.from(JSON.stringify({ ...body, messages: decoded }))
        if (
            result.outcome === "planned" &&
            result.plan.summaryJobs.length > 0 &&
            !runtime.summarizing
        ) {
            runtime.summarizing = true
            void upgradePlanWithSummaries(result.plan, turns, planInputs, body.model, req, options)
                .catch((error) =>
                    options.logger.warn("Plan summary upgrade failed", { error: String(error) }),
                )
                .finally(() => {
                    runtime.summarizing = false
                })
        }
        return { body: rewritten, pruned: true, sessionKey }
    } catch (error) {
        options.logger.error("Rewrite failed; forwarding original request", {
            sessionKey,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        })
        return { body: raw, pruned: false, sessionKey }
    }
}

// Assistant-run summaries never block a request: they run in the background
// against the session's own model and credentials, and the upgraded plan
// applies from the next request.
async function upgradePlanWithSummaries(
    plan: BoundaryContextPlan,
    turns: Turn[],
    planInputs: BuildPlanInputs,
    model: string,
    req: IncomingMessage,
    options: AnthropicRouteOptions,
): Promise<void> {
    const summarizer = createSummarizer(
        options.upstream,
        model,
        forwardableHeaders(req.rawHeaders),
        options.logger,
    )
    const summaries = await summarizeJobs({
        jobs: plan.summaryJobs,
        summarizer,
        logger: options.logger,
        concurrency: options.profile.summarizerConcurrency,
    })
    if (Object.keys(summaries).length === 0) return
    const upgraded = buildPlan(
        turns,
        {
            ...planInputs,
            force: true,
            assistantSummaries: { ...plan.assistantSummaries, ...summaries },
        },
        anthropicSpec,
    )
    if (upgraded) await options.plans.save(plan.sessionId, toPlanSnapshot(upgraded))
}

async function passthrough(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    options: AnthropicRouteOptions,
): Promise<void> {
    try {
        const upstream = await requestUpstream(options.upstream, {
            method: req.method ?? "GET",
            path,
            headers: forwardableHeaders(req.rawHeaders),
            body: req.method === "GET" || req.method === "HEAD" ? null : req,
        })
        options.logger.info("anthropic passthrough", {
            method: req.method,
            path,
            status: upstream.statusCode,
        })
        relay(upstream, res, {})
    } catch (error) {
        respondGatewayError(res, error, options.logger)
    }
}

// The response is relayed byte-for-byte and unbuffered: we prune requests,
// never responses. Headers pass through verbatim minus connection framing,
// which node re-derives.
function relay(
    upstream: IncomingMessage,
    res: ServerResponse,
    hooks: { onChunk?: (chunk: Buffer) => void; onEnd?: () => Promise<void> | void },
): void {
    res.writeHead(upstream.statusCode ?? 502, filterResponseHeaders(upstream.rawHeaders))
    if (hooks.onChunk) upstream.on("data", hooks.onChunk)
    upstream.pipe(res)
    upstream.on("end", () => {
        void hooks.onEnd?.()
    })
    upstream.on("error", () => {
        res.destroy()
    })
    res.on("close", () => {
        upstream.destroy()
    })
}

function filterResponseHeaders(rawHeaders: string[]): string[] {
    const filtered: string[] = []
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index].toLowerCase()
        if (name === "transfer-encoding" || name === "connection") continue
        filtered.push(rawHeaders[index], rawHeaders[index + 1])
    }
    return filtered
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

function bufferBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => resolve(Buffer.concat(chunks)))
        req.on("error", reject)
    })
}

// Captures hold the request body only — headers, and with them credentials,
// are never written to disk.
async function captureBody(
    raw: Buffer,
    sessionKey: string | null,
    options: AnthropicRouteOptions,
): Promise<void> {
    await mkdir(options.capturesDir, { recursive: true })
    const name = `${Date.now()}-${sanitizeKey(sessionKey ?? "unknown")}.json`
    await writeFile(join(options.capturesDir, name), raw)
}

async function dumpRewrittenBody(
    rewrite: Rewrite,
    status: number,
    options: AnthropicRouteOptions,
): Promise<void> {
    await mkdir(options.debugDir, { recursive: true })
    const name = `${Date.now()}-${status}-${sanitizeKey(rewrite.sessionKey ?? "unknown")}.json`
    await writeFile(join(options.debugDir, name), rewrite.body)
    options.logger.warn("Upstream rejected a rewritten request; body dumped for fixturing", {
        status,
        dump: join(options.debugDir, name),
    })
}

function respondGatewayError(res: ServerResponse, error: unknown, logger: Logger): void {
    logger.error("Upstream request failed", {
        error: error instanceof Error ? error.message : String(error),
    })
    if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" })
    }
    res.end(
        JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "better-compact-proxy: upstream unreachable" },
        }),
    )
}
