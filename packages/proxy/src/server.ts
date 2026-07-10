import { createServer, type Server } from "node:http"
import type { CompactionProfile, Logger } from "@better-compact/core"
import { createAnthropicRoute } from "./anthropic/route"
import { createSessionTracker } from "./sessions"
import { createPlanStore, createTranscriptStore } from "./stores"

export const SERVICE_NAME = "better-compact-proxy"

export interface ProxyServerOptions {
    upstream: string
    profile: CompactionProfile
    plansDir: string
    transcriptsDir: string
    capturesDir: string
    debugDir: string
    capture: boolean
    logger: Logger
}

// One daemon, dialects mounted by route prefix: /anthropic this phase, the
// OpenAI Responses route joins as a second prefix in Phase 4.
export function createProxyServer(options: ProxyServerOptions): Server {
    const anthropic = createAnthropicRoute({
        upstream: new URL(options.upstream),
        profile: options.profile,
        plans: createPlanStore(options.plansDir, options.logger),
        transcripts: createTranscriptStore(options.transcriptsDir),
        sessions: createSessionTracker(),
        logger: options.logger,
        capture: options.capture,
        capturesDir: options.capturesDir,
        debugDir: options.debugDir,
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
                    capture: options.capture,
                }),
            )
            return
        }
        if (url === "/anthropic" || url.startsWith("/anthropic/")) {
            const path = url.slice("/anthropic".length) || "/"
            anthropic(req, res, path).catch((error) => {
                options.logger.error("Request handling failed", { error: String(error) })
                if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
                res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "proxy failure" } }))
            })
            return
        }
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "unknown route" } }))
    })
}
