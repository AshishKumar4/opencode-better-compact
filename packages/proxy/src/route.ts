import { mkdir, writeFile } from "node:fs/promises"
import type {
    IncomingHttpHeaders,
    IncomingMessage,
    OutgoingHttpHeaders,
    ServerResponse,
} from "node:http"
import { join } from "node:path"
import { brotliDecompress, gunzip, inflate, zstdDecompress } from "node:zlib"
import {
    buildPlan,
    createEngine,
    summarizeJobs,
    toPlanSnapshot,
    type BoundaryContextPlan,
    type BuildPlanInputs,
    type CompactionProfile,
    type EnginePorts,
    type LadderSpec,
    type Logger,
    type PlanStore,
    type Summarizer,
    type TranscriptStore,
    type Turn,
} from "@better-compact/core"
import type { SessionTracker } from "./sessions"
import { sanitizeKey } from "./stores"
import { forwardableHeaders, requestUpstream } from "./upstream"
import type { UsageReader } from "./usage"

export interface SharedRouteOptions {
    upstream: URL
    profile: CompactionProfile
    plans: PlanStore
    transcripts: TranscriptStore
    sessions: SessionTracker
    logger: Logger
    capture: boolean
    capturesDir: string
    debugDir: string
    openaiContextLimit?: number
}

// The only things that differ between wire dialects: which POST path is the
// prunable endpoint, how its body is parsed/validated and re-serialized, how a
// session key and context limit are derived, and the dialect-shaped usage
// reader, summarizer, and error envelope. Everything else — buffering, the
// engine call, the fail-open posture, SSE relay, capture/debug dumps,
// passthrough — is shared below.
export interface Dialect<Body> {
    name: string
    rewritePath: string
    spec: LadderSpec
    // Parses and validates the request body; throws on anything the codec
    // cannot handle so the caller forwards the original bytes untouched.
    readBody(raw: Buffer): { body: Body; model: string }
    stripManualTrigger(body: Body, marker: string): boolean
    sessionKeyOf(req: IncomingMessage, body: Body): string
    contextLimit(req: IncomingMessage, body: Body): number
    calibrateContextLimit?: boolean
    encode(body: Body): Turn[]
    rewrite(body: Body, turns: Turn[]): Buffer
    createUsageReader(headers: IncomingHttpHeaders): UsageReader
    createSummarizer(
        upstream: URL,
        model: string,
        headers: OutgoingHttpHeaders,
        logger: Logger,
    ): Summarizer
    errorBody(type: string, message: string): unknown
}

interface Rewrite {
    body: Buffer
    rewritten: boolean
    pruned: boolean
    sessionKey: string | null
    model: string | null
    contextLimit: number | null
}

const MANUAL_TRIGGER = "[[better-compact:run]]"

// The Anthropic error envelope wraps the error object under a `type: "error"`
// discriminator; the OpenAI envelope is just the bare `{ error }` object.
export function errorEnvelope(
    dialect: "anthropic" | "openai",
    type: string,
    message: string,
): unknown {
    return dialect === "openai"
        ? { error: { type, message } }
        : { type: "error", error: { type, message } }
}

export function createDialectRoute<Body>(options: SharedRouteOptions, dialect: Dialect<Body>) {
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
        if (
            req.method === "GET" &&
            path.split("?")[0] === dialect.rewritePath &&
            headerContains(req.headers.upgrade, "websocket")
        ) {
            res.writeHead(426)
            res.end()
            return
        }
        if (req.method !== "POST" || path.split("?")[0] !== dialect.rewritePath) {
            await passthrough(req, res, path, options, dialect)
            return
        }

        const raw = await bufferBody(req)
        const rewrite = await rewriteBody(raw, req, options, dialect, ports)
        if (options.capture) {
            void captureBody(raw, rewrite.sessionKey, options).catch(() => {})
        }

        let upstream: IncomingMessage
        try {
            upstream = await requestUpstream(options.upstream, {
                method: "POST",
                path,
                // When we rewrote the body it is fresh plaintext, so any
                // client content-encoding no longer applies; content-length is
                // re-derived from the Buffer. Bodies we neither compact nor
                // strip a manual trigger from forward verbatim.
                headers: forwardableHeaders(
                    req.rawHeaders,
                    rewrite.rewritten ? ["content-encoding"] : undefined,
                ),
                body: rewrite.body,
            })
        } catch (error) {
            respondGatewayError(res, error, options.logger, dialect)
            return
        }

        const status = upstream.statusCode ?? 502
        options.logger.info(`${dialect.name} ${dialect.rewritePath}`, {
            sessionKey: rewrite.sessionKey,
            pruned: rewrite.pruned,
            status,
            originalBytes: raw.length,
            sentBytes: rewrite.body.length,
        })
        if (rewrite.pruned && status >= 400 && status < 500) {
            void dumpRewrittenBody(rewrite, status, options).catch(() => {})
        }

        const usage = dialect.createUsageReader(upstream.headers)
        relay(upstream, res, {
            onChunk: (chunk) => usage.feed(chunk),
            onEnd: async () => {
                const tokens = await usage.finish()
                if (tokens !== null && rewrite.sessionKey && status < 300) {
                    options.sessions.recordUsage(
                        rewrite.sessionKey,
                        tokens,
                        rewrite.pruned,
                        dialect.calibrateContextLimit && rewrite.model && rewrite.contextLimit
                            ? { model: rewrite.model, assumedLimit: rewrite.contextLimit }
                            : undefined,
                    )
                }
            },
        })
    }
}

function headerContains(header: string | string[] | undefined, value: string): boolean {
    return (Array.isArray(header) ? header : [header]).some((entry) =>
        entry?.split(",").some((part) => part.trim().toLowerCase() === value),
    )
}

// Failure posture: ANY internal error in the rewrite pipeline logs and
// forwards the original bytes unmodified, except that an already-recognized
// manual trigger remains stripped. The session must never break because of us.
async function rewriteBody<Body>(
    raw: Buffer,
    req: IncomingMessage,
    options: SharedRouteOptions,
    dialect: Dialect<Body>,
    ports: EnginePorts,
): Promise<Rewrite> {
    let sessionKey: string | null = null
    let fallbackBody = raw
    let manualTrigger = false
    try {
        const decoded = await decodeRequestBody(raw, req.headers["content-encoding"])
        const { body, model } = dialect.readBody(decoded)
        manualTrigger = dialect.stripManualTrigger(body, MANUAL_TRIGGER)
        if (manualTrigger) fallbackBody = Buffer.from(JSON.stringify(body))
        sessionKey = dialect.sessionKeyOf(req, body)
        const runtime = options.sessions.runtime(sessionKey)
        const configuredContextLimit = dialect.contextLimit(req, body)
        const contextLimit = Math.max(
            configuredContextLimit,
            runtime.calibratedContextLimits.get(model) ?? 0,
        )
        const turns = dialect.encode(body)
        const planInputs: BuildPlanInputs = {
            contextLimit,
            triggerRatio: options.profile.triggerPercent / 100,
            targetRatio: options.profile.targetPercent / 100,
            recentToolResultBudgetTokens: options.profile.recentToolTokens,
            sessionKey,
            citablePath: options.transcripts.citablePath,
        }
        const result = await createEngine(dialect.spec, ports).process({
            sessionKey,
            turns,
            contextLimit,
            triggerRatio: planInputs.triggerRatio,
            targetRatio: planInputs.targetRatio,
            recentToolResultBudgetTokens: planInputs.recentToolResultBudgetTokens,
            providerReportedTokens: runtime.reportedTokens,
            force: manualTrigger,
        })
        if (result.outcome === "unchanged") {
            return {
                body: fallbackBody,
                rewritten: manualTrigger,
                pruned: false,
                sessionKey,
                model,
                contextLimit,
            }
        }

        const rewritten = dialect.rewrite(body, result.turns)
        if (
            result.outcome === "planned" &&
            result.plan.summaryJobs.length > 0 &&
            !runtime.summarizing
        ) {
            runtime.summarizing = true
            void upgradePlanWithSummaries(result.plan, turns, planInputs, model, req, options, dialect)
                .catch((error) =>
                    options.logger.warn("Plan summary upgrade failed", { error: String(error) }),
                )
                .finally(() => {
                    runtime.summarizing = false
                })
        }
        return {
            body: rewritten,
            rewritten: true,
            pruned: true,
            sessionKey,
            model,
            contextLimit,
        }
    } catch (error) {
        options.logger.error("Rewrite failed; forwarding original request", {
            sessionKey,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        })
        return {
            body: fallbackBody,
            rewritten: manualTrigger,
            pruned: false,
            sessionKey,
            model: null,
            contextLimit: null,
        }
    }
}

type Decoder = (input: Buffer, callback: (error: Error | null, result: Buffer) => void) => void

async function decodeRequestBody(
    raw: Buffer,
    contentEncoding: string | string[] | undefined,
): Promise<Buffer> {
    const encodings = (Array.isArray(contentEncoding) ? contentEncoding : [contentEncoding])
        .flatMap((value) => value?.split(",") ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value && value !== "identity")
    let decoded = raw
    for (const encoding of encodings.reverse()) {
        const decoder = decoderFor(encoding)
        decoded = await new Promise<Buffer>((resolve, reject) => {
            decoder(decoded, (error, result) => (error ? reject(error) : resolve(result)))
        })
    }
    return decoded
}

function decoderFor(encoding: string): Decoder {
    if (encoding === "zstd") return zstdDecompress
    if (encoding === "gzip" || encoding === "x-gzip") return gunzip
    if (encoding === "deflate") return inflate
    if (encoding === "br") return brotliDecompress
    throw new Error(`Unsupported content-encoding: ${encoding}`)
}

// Summary jobs never block a request: they run in the background
// against the session's own model and credentials, and the upgraded plan
// applies from the next request.
async function upgradePlanWithSummaries<Body>(
    plan: BoundaryContextPlan,
    turns: Turn[],
    planInputs: BuildPlanInputs,
    model: string,
    req: IncomingMessage,
    options: SharedRouteOptions,
    dialect: Dialect<Body>,
): Promise<void> {
    const summarizer = dialect.createSummarizer(
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
            priorPlan: toPlanSnapshot(plan),
            assistantSummaries: { ...plan.assistantSummaries, ...summaries },
        },
        dialect.spec,
    )
    if (upgraded) await options.plans.save(plan.sessionId, toPlanSnapshot(upgraded))
}

async function passthrough<Body>(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    options: SharedRouteOptions,
    dialect: Dialect<Body>,
): Promise<void> {
    try {
        const upstream = await requestUpstream(options.upstream, {
            method: req.method ?? "GET",
            path,
            headers: forwardableHeaders(req.rawHeaders),
            body: req.method === "GET" || req.method === "HEAD" ? null : req,
        })
        options.logger.info(`${dialect.name} passthrough`, {
            method: req.method,
            path,
            status: upstream.statusCode,
        })
        relay(upstream, res, {})
    } catch (error) {
        respondGatewayError(res, error, options.logger, dialect)
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
    options: SharedRouteOptions,
): Promise<void> {
    await mkdir(options.capturesDir, { recursive: true })
    const name = `${Date.now()}-${sanitizeKey(sessionKey ?? "unknown")}.json`
    await writeFile(join(options.capturesDir, name), raw)
}

async function dumpRewrittenBody(
    rewrite: Rewrite,
    status: number,
    options: SharedRouteOptions,
): Promise<void> {
    await mkdir(options.debugDir, { recursive: true })
    const name = `${Date.now()}-${status}-${sanitizeKey(rewrite.sessionKey ?? "unknown")}.json`
    await writeFile(join(options.debugDir, name), rewrite.body)
    options.logger.warn("Upstream rejected a rewritten request; body dumped for fixturing", {
        status,
        dump: join(options.debugDir, name),
    })
}

function respondGatewayError<Body>(
    res: ServerResponse,
    error: unknown,
    logger: Logger,
    dialect: Dialect<Body>,
): void {
    logger.error("Upstream request failed", {
        error: error instanceof Error ? error.message : String(error),
    })
    if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" })
    }
    res.end(JSON.stringify(dialect.errorBody("api_error", "better-compact-proxy: upstream unreachable")))
}
