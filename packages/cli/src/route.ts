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
    isContextOverflowError,
    toPlanSnapshot,
    type BoundaryContextPlan,
    type BuildPlanInputs,
    type CompactionProfile,
    type EnginePorts,
    type LadderSpec,
    type Logger,
    type PlanStore,
    type Summarizer,
    type SummaryScheduler,
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
    summaryScheduler: SummaryScheduler
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
    stripManualTrigger(body: Body, marker: string): { forced: boolean; stripped: boolean }
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
    estimatedTokens: number | null
}

interface BufferedResponse {
    status: number
    headers: IncomingHttpHeaders
    rawHeaders: string[]
    body: Buffer
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
            upstream = await forwardRewrite(req, path, rewrite, options)
        } catch (error) {
            respondGatewayError(res, error, options.logger, dialect)
            return
        }

        observeUpstream(upstream.statusCode ?? 502, raw, rewrite, options, dialect)
        if ((upstream.statusCode ?? 502) === 400) {
            let original: BufferedResponse
            try {
                original = await bufferResponse(upstream)
            } catch (error) {
                respondGatewayError(res, error, options.logger, dialect)
                return
            }
            if (await isOverflowResponse(original, options.logger)) {
                const forced = await rewriteBody(raw, req, options, dialect, ports, {
                    force: true,
                    scheduleSummaries: false,
                })
                if (
                    forced.pruned &&
                    forced.estimatedTokens !== null &&
                    rewrite.estimatedTokens !== null &&
                    forced.estimatedTokens < rewrite.estimatedTokens
                ) {
                    let retry: IncomingMessage
                    try {
                        retry = await forwardRewrite(req, path, forced, options)
                    } catch (error) {
                        options.logger.warn("Overflow retry failed; forwarding original response", {
                            sessionKey: rewrite.sessionKey,
                            error: String(error),
                        })
                        relayBuffered(original, res)
                        return
                    }
                    observeUpstream(retry.statusCode ?? 502, raw, forced, options, dialect)
                    if ((retry.statusCode ?? 502) === 400) {
                        let bufferedRetry: BufferedResponse
                        try {
                            bufferedRetry = await bufferResponse(retry)
                        } catch (error) {
                            options.logger.warn(
                                "Overflow retry response failed; forwarding original response",
                                { sessionKey: rewrite.sessionKey, error: String(error) },
                            )
                            relayBuffered(original, res)
                            return
                        }
                        if (await isOverflowResponse(bufferedRetry, options.logger)) {
                            relayBuffered(original, res)
                        } else {
                            relayBuffered(bufferedRetry, res)
                        }
                        return
                    }
                    relayWithUsage(retry, res, forced, options, dialect)
                    return
                }
                options.logger.warn("Overflow retry skipped; no further pruning was possible", {
                    sessionKey: rewrite.sessionKey,
                })
            }
            relayBuffered(original, res)
            return
        }

        relayWithUsage(upstream, res, rewrite, options, dialect)
    }
}

function forwardRewrite(
    req: IncomingMessage,
    path: string,
    rewrite: Rewrite,
    options: SharedRouteOptions,
): Promise<IncomingMessage> {
    return requestUpstream(options.upstream, {
        method: "POST",
        path,
        // When we rewrote the body it is fresh plaintext, so any client
        // content-encoding no longer applies; content-length is re-derived.
        headers: forwardableHeaders(
            req.rawHeaders,
            rewrite.rewritten ? ["content-encoding"] : undefined,
        ),
        body: rewrite.body,
    })
}

function observeUpstream<Body>(
    status: number,
    raw: Buffer,
    rewrite: Rewrite,
    options: SharedRouteOptions,
    dialect: Dialect<Body>,
): void {
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
}

function relayWithUsage<Body>(
    upstream: IncomingMessage,
    res: ServerResponse,
    rewrite: Rewrite,
    options: SharedRouteOptions,
    dialect: Dialect<Body>,
): void {
    const status = upstream.statusCode ?? 502
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
    behavior: { force?: boolean; scheduleSummaries?: boolean } = {},
): Promise<Rewrite> {
    let sessionKey: string | null = null
    let fallbackBody = raw
    let manualTrigger = false
    let manualTriggerStripped = false
    try {
        const decoded = await decodeRequestBody(raw, req.headers["content-encoding"])
        const { body, model } = dialect.readBody(decoded)
        const trigger = dialect.stripManualTrigger(body, MANUAL_TRIGGER)
        manualTrigger = trigger.forced
        manualTriggerStripped = trigger.stripped
        if (manualTriggerStripped) fallbackBody = Buffer.from(JSON.stringify(body))
        sessionKey = dialect.sessionKeyOf(req, body)
        const runtime = options.sessions.runtime(sessionKey)
        const configuredContextLimit = dialect.contextLimit(req, body)
        const contextLimit = Math.max(
            configuredContextLimit,
            runtime.calibratedContextLimits.get(model) ?? 0,
        )
        const turns = dialect.encode(body)
        const estimatedTokens = dialect.spec.codec.estimateTurns(turns)
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
            providerReportedTokens: behavior.force
                ? Math.max(runtime.reportedTokens ?? 0, contextLimit)
                : runtime.reportedTokens,
            force: behavior.force || manualTrigger,
        })
        if (result.outcome === "unchanged") {
            return {
                body: fallbackBody,
                rewritten: manualTriggerStripped,
                pruned: false,
                sessionKey,
                model,
                contextLimit,
                estimatedTokens,
            }
        }

        const rewritten = dialect.rewrite(body, result.turns)
        if (
            result.outcome === "planned" &&
            result.plan.summaryJobs.length > 0 &&
            behavior.scheduleSummaries !== false &&
            !runtime.summarizing
        ) {
            runtime.summarizing = true
            void upgradePlanWithSummaries(
                result.plan,
                turns,
                planInputs,
                model,
                req,
                options,
                dialect,
            )
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
            estimatedTokens: dialect.spec.codec.estimateTurns(result.turns),
        }
    } catch (error) {
        options.logger.error("Rewrite failed; forwarding original request", {
            sessionKey,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        })
        return {
            body: fallbackBody,
            rewritten: manualTriggerStripped,
            pruned: false,
            sessionKey,
            model: null,
            contextLimit: null,
            estimatedTokens: null,
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
        forwardableHeaders(req.rawHeaders, ["content-encoding"]),
        options.logger,
    )
    const summaries = await options.summaryScheduler.summarize({
        sessionKey: plan.sessionId,
        jobs: plan.summaryJobs,
        summarizer,
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

function bufferResponse(upstream: IncomingMessage): Promise<BufferedResponse> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        upstream.on("data", (chunk: Buffer) => chunks.push(chunk))
        upstream.on("end", () =>
            resolve({
                status: upstream.statusCode ?? 502,
                headers: upstream.headers,
                rawHeaders: upstream.rawHeaders,
                body: Buffer.concat(chunks),
            }),
        )
        upstream.on("error", reject)
    })
}

async function isOverflowResponse(response: BufferedResponse, logger: Logger): Promise<boolean> {
    try {
        const decoded = await decodeRequestBody(response.body, response.headers["content-encoding"])
        return isContextOverflowError(response.status, decoded.toString("utf-8"))
    } catch (error) {
        logger.warn("Could not inspect upstream 400 response", { error: String(error) })
        return false
    }
}

function relayBuffered(upstream: BufferedResponse, res: ServerResponse): void {
    res.writeHead(upstream.status, filterResponseHeaders(upstream.rawHeaders))
    res.end(upstream.body)
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
    res.end(
        JSON.stringify(
            dialect.errorBody("api_error", "better-compact: upstream unreachable"),
        ),
    )
}
