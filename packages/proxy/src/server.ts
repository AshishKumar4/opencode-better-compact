import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { CompactionProfile, Logger } from "@better-compact/core"
import { createAnthropicRoute } from "./anthropic/route"
import { createOpenAIRoute } from "./openai/route"
import { errorEnvelope } from "./route"
import { createSessionTracker } from "./sessions"
import { createPlanStore, createTranscriptStore } from "./stores"

export const SERVICE_NAME = "better-compact-proxy"

export interface ProxyServerOptions {
    upstream: string
    openaiUpstream: string
    openaiContextLimit?: number
    profile: CompactionProfile
    plansDir: string
    transcriptsDir: string
    capturesDir: string
    debugDir: string
    capture: boolean
    logger: Logger
}

type Route = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>

// One daemon, both dialects mounted by route prefix. The two shared stores and
// session tracker are created once and reused across dialects.
export function createProxyServer(options: ProxyServerOptions): Server {
    const shared = {
        profile: options.profile,
        plans: createPlanStore(options.plansDir, options.logger),
        transcripts: createTranscriptStore(options.transcriptsDir),
        sessions: createSessionTracker(),
        logger: options.logger,
        capture: options.capture,
        capturesDir: options.capturesDir,
        debugDir: options.debugDir,
    }
    const anthropic = createAnthropicRoute({ ...shared, upstream: new URL(options.upstream) })
    const openai = createOpenAIRoute({
        ...shared,
        upstream: new URL(options.openaiUpstream),
        openaiContextLimit: options.openaiContextLimit,
    })

    return createServer((req, res) => {
        const url = req.url ?? "/"
        if (req.method === "GET" && url === "/healthz") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
                JSON.stringify({
                    service: SERVICE_NAME,
                    pid: process.pid,
                    upstream: options.upstream,
                    openaiUpstream: options.openaiUpstream,
                    openaiContextLimit: options.openaiContextLimit,
                    capture: options.capture,
                }),
            )
            return
        }
        const dispatched =
            dispatch(url, "/anthropic", anthropic, req, res, options.logger) ||
            dispatch(url, "/openai", openai, req, res, options.logger)
        if (dispatched) return
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify(errorEnvelope(dialectOf(url), "not_found_error", "unknown route")))
    })
}

function dialectOf(url: string): "anthropic" | "openai" {
    return url === "/openai" || url.startsWith("/openai/") ? "openai" : "anthropic"
}

function dispatch(
    url: string,
    prefix: string,
    route: Route,
    req: IncomingMessage,
    res: ServerResponse,
    logger: Logger,
): boolean {
    if (url !== prefix && !url.startsWith(`${prefix}/`)) return false
    const path = url.slice(prefix.length) || "/"
    route(req, res, path).catch((error) => {
        logger.error("Request handling failed", { error: String(error) })
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify(errorEnvelope(dialectOf(url), "api_error", "proxy failure")))
    })
    return true
}
