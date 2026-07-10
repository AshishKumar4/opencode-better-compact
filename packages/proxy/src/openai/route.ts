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
import { createResponsesSummarizer } from "../summarizer"
import type { SessionTracker } from "../sessions"
import { forwardableHeaders, requestUpstream } from "../upstream"
import { createResponsesUsageReader } from "../usage"
import { sanitizeKey } from "../stores"
import { openaiCodec, openaiSpec, type ResponseItemWire } from "./codec"

// Codex's gpt-5-codex family reports a 272k window; other models can be larger,
// but there is no per-request signal for it, so we default conservatively —
// under-estimating the window only prunes sooner, never breaks a request.
const DEFAULT_CONTEXT_LIMIT = 272_000

export interface OpenAIRouteOptions {
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

interface ResponsesBody {
    model: string
    input: ResponseItemWire[]
    prompt_cache_key?: string
    [key: string]: unknown
}

interface Rewrite {
    body: Buffer
    pruned: boolean
    sessionKey: string | null
}

export function createOpenAIRoute(options: OpenAIRouteOptions) {
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
        if (req.method !== "POST" || path.split("?")[0] !== "/responses") {
            await passthrough(req, res, path, options)
            return
        }

        const raw = await bufferBody(req)
        const rewrite = await rewriteInput(raw, req, options, ports)
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
        options.logger.info("openai /responses", {
            sessionKey: rewrite.sessionKey,
            pruned: rewrite.pruned,
            status,
            originalBytes: raw.length,
            sentBytes: rewrite.body.length,
        })
        if (rewrite.pruned && status >= 400 && status < 500) {
            void dumpRewrittenBody(rewrite, status, options).catch(() => {})
        }

        const usage = createResponsesUsageReader(upstream.headers)
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

// Failure posture: ANY internal error logs and forwards the original bytes
// unmodified — the session must never break because of us.
async function rewriteInput(
    raw: Buffer,
    req: IncomingMessage,
    options: OpenAIRouteOptions,
    ports: EnginePorts,
): Promise<Rewrite> {
    let sessionKey: string | null = null
    try {
        const body = JSON.parse(raw.toString("utf-8")) as ResponsesBody
        if (!body || typeof body !== "object" || !Array.isArray(body.input)) {
            throw new Error("Body has no input array")
        }
        sessionKey = sessionKeyOf(req, body)
        const runtime = options.sessions.runtime(sessionKey)
        const contextLimit = DEFAULT_CONTEXT_LIMIT
        const turns = openaiCodec.encode(body.input)
        const planInputs: BuildPlanInputs = {
            contextLimit,
            triggerRatio: options.profile.triggerPercent / 100,
            targetRatio: options.profile.targetPercent / 100,
            recentToolResultBudgetTokens: options.profile.recentToolTokens,
            sessionKey,
            citablePath: options.transcripts.citablePath,
        }
        const result = await createEngine(openaiSpec, ports).process({
            sessionKey,
            turns,
            contextLimit,
            triggerRatio: planInputs.triggerRatio,
            targetRatio: planInputs.targetRatio,
            recentToolResultBudgetTokens: planInputs.recentToolResultBudgetTokens,
            providerReportedTokens: runtime.reportedTokens,
        })
        if (result.outcome === "unchanged") return { body: raw, pruned: false, sessionKey }

        const decoded = openaiCodec.decode(result.turns, body.input)
        const rewritten = Buffer.from(JSON.stringify({ ...body, input: decoded }))
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

async function upgradePlanWithSummaries(
    plan: BoundaryContextPlan,
    turns: Turn[],
    planInputs: BuildPlanInputs,
    model: string,
    req: IncomingMessage,
    options: OpenAIRouteOptions,
): Promise<void> {
    const summarizer = createResponsesSummarizer(
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
        openaiSpec,
    )
    if (upgraded) await options.plans.save(plan.sessionId, toPlanSnapshot(upgraded))
}

async function passthrough(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    options: OpenAIRouteOptions,
): Promise<void> {
    try {
        const upstream = await requestUpstream(options.upstream, {
            method: req.method ?? "GET",
            path,
            headers: forwardableHeaders(req.rawHeaders),
            body: req.method === "GET" || req.method === "HEAD" ? null : req,
        })
        options.logger.info("openai passthrough", {
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
// never responses.
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

function bufferBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => resolve(Buffer.concat(chunks)))
        req.on("error", reject)
    })
}

async function captureBody(
    raw: Buffer,
    sessionKey: string | null,
    options: OpenAIRouteOptions,
): Promise<void> {
    await mkdir(options.capturesDir, { recursive: true })
    const name = `${Date.now()}-${sanitizeKey(sessionKey ?? "unknown")}.json`
    await writeFile(join(options.capturesDir, name), raw)
}

async function dumpRewrittenBody(
    rewrite: Rewrite,
    status: number,
    options: OpenAIRouteOptions,
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
            error: { type: "api_error", message: "better-compact-proxy: upstream unreachable" },
        }),
    )
}
