import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { get } from "node:http"
import { loadConfig, type ProxyPaths } from "./config"
import { createLogger } from "./logger"
import { createProxyServer, SERVICE_NAME } from "./server"

export interface LockInfo {
    port: number
    pid: number
}

export type HealthState =
    | { kind: "ours"; pid: number; upstream: string; capture: boolean }
    | { kind: "foreign" }
    | { kind: "down" }

export function readLock(paths: ProxyPaths): LockInfo | null {
    try {
        const lock = JSON.parse(readFileSync(paths.lockfile, "utf-8")) as LockInfo
        return typeof lock.port === "number" && typeof lock.pid === "number" ? lock : null
    } catch {
        return null
    }
}

// Anything listening that does not answer our health check is a foreign
// process squatting the port; only a refused connection means the port is
// free.
export function checkHealth(port: number): Promise<HealthState> {
    return new Promise((resolve) => {
        const request = get(
            { host: "127.0.0.1", port, path: "/healthz", timeout: 1_000 },
            (response) => {
                const chunks: Buffer[] = []
                response.on("data", (chunk: Buffer) => chunks.push(chunk))
                response.on("end", () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
                            service?: string
                            pid?: number
                            upstream?: string
                            capture?: boolean
                        }
                        if (body.service === SERVICE_NAME && typeof body.pid === "number") {
                            resolve({
                                kind: "ours",
                                pid: body.pid,
                                upstream: body.upstream ?? "",
                                capture: body.capture ?? false,
                            })
                            return
                        }
                    } catch {
                        // Fall through: it responded, but it is not us.
                    }
                    resolve({ kind: "foreign" })
                })
            },
        )
        request.on("timeout", () => {
            request.destroy()
            resolve({ kind: "foreign" })
        })
        request.on("error", (error: NodeJS.ErrnoException) => {
            resolve(error.code === "ECONNREFUSED" ? { kind: "down" } : { kind: "foreign" })
        })
    })
}

export function runDaemon(paths: ProxyPaths, port: number, capture: boolean): void {
    const logger = createLogger()
    const config = loadConfig(paths)
    const server = createProxyServer({
        upstream: config.anthropicUpstream,
        profile: config.profile,
        plansDir: paths.plansDir,
        transcriptsDir: paths.transcriptsDir,
        capturesDir: paths.capturesDir,
        debugDir: paths.debugDir,
        capture,
        logger,
    })

    server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
            logger.error(`Port ${port} is already in use by another process; refusing to start`, {})
        } else {
            logger.error("Proxy server failed", { error: error.message })
        }
        process.exit(1)
    })

    server.listen(port, "127.0.0.1", () => {
        mkdirSync(paths.home, { recursive: true })
        writeFileSync(paths.lockfile, JSON.stringify({ port, pid: process.pid } satisfies LockInfo))
        logger.info("better-compact-proxy listening", {
            port,
            pid: process.pid,
            upstream: config.anthropicUpstream,
            capture,
        })
    })

    const shutdown = () => {
        removeOwnLock(paths)
        server.close(() => process.exit(0))
        setTimeout(() => process.exit(0), 1_000).unref()
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
    process.on("exit", () => removeOwnLock(paths))
}

function removeOwnLock(paths: ProxyPaths): void {
    if (!existsSync(paths.lockfile)) return
    const lock = readLock(paths)
    if (lock && lock.pid !== process.pid) return
    rmSync(paths.lockfile, { force: true })
}
