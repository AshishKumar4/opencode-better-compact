import { spawn } from "node:child_process"
import { mkdirSync, openSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_PORT, loadConfig, proxyPaths } from "./config"
import { checkHealth, readLock, runDaemon } from "./daemon"

const HELP = `better-compact-proxy — local context-pruning proxy for Anthropic-wire agents

Usage:
  better-compact-proxy start [--capture]   Start the daemon (idempotent)
  better-compact-proxy run [--capture]     Run in the foreground
  better-compact-proxy stop                Stop the daemon
  better-compact-proxy status              Show daemon status

--capture writes sanitized request bodies to ~/.better-compact/captures/`

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2)
    const capture = rest.includes("--capture")
    const paths = proxyPaths()

    switch (command) {
        case "start": {
            const health = await checkHealth(DEFAULT_PORT)
            if (health.kind === "ours") {
                console.log(
                    `better-compact-proxy already running (pid ${health.pid}, port ${DEFAULT_PORT})`,
                )
                return
            }
            if (health.kind === "foreign") {
                console.error(
                    `Port ${DEFAULT_PORT} is in use by another process; refusing to start.`,
                )
                process.exit(1)
            }
            mkdirSync(paths.home, { recursive: true })
            const log = openSync(paths.logFile, "a")
            const child = spawn(
                process.execPath,
                [fileURLToPath(import.meta.url), "run", ...(capture ? ["--capture"] : [])],
                { detached: true, stdio: ["ignore", log, log] },
            )
            child.unref()
            const started = await waitFor(
                () => checkHealth(DEFAULT_PORT),
                (state) => state.kind === "ours",
                5_000,
            )
            if (started?.kind !== "ours") {
                console.error(`Daemon failed to start; see ${paths.logFile}`)
                process.exit(1)
            }
            console.log(`better-compact-proxy started (pid ${started.pid}, port ${DEFAULT_PORT})`)
            console.log(`Upstream: ${started.upstream}`)
            return
        }
        case "run": {
            runDaemon(paths, DEFAULT_PORT, capture)
            return
        }
        case "stop": {
            const lock = readLock(paths)
            const health = await checkHealth(DEFAULT_PORT)
            const pid = health.kind === "ours" ? health.pid : lock?.pid
            if (!pid) {
                console.log("better-compact-proxy is not running")
                return
            }
            try {
                process.kill(pid, "SIGTERM")
            } catch {
                console.log("better-compact-proxy is not running")
                return
            }
            const stopped = await waitFor(
                () => checkHealth(DEFAULT_PORT),
                (state) => state.kind === "down",
                3_000,
            )
            console.log(
                stopped
                    ? `Stopped better-compact-proxy (pid ${pid})`
                    : `Sent SIGTERM to pid ${pid}`,
            )
            return
        }
        case "status": {
            const health = await checkHealth(DEFAULT_PORT)
            if (health.kind === "ours") {
                console.log(`running  pid=${health.pid} port=${DEFAULT_PORT}`)
                console.log(`anthropic=${health.upstream} openai=${health.openaiUpstream}`)
                console.log(`capture=${health.capture}`)
            } else if (health.kind === "foreign") {
                console.log(`port ${DEFAULT_PORT} is occupied by a foreign process`)
                process.exit(1)
            } else {
                console.log(
                    `stopped  (configured upstream: ${loadConfig(paths).anthropicUpstream})`,
                )
            }
            return
        }
        default: {
            console.log(HELP)
            if (command !== undefined && command !== "--help" && command !== "-h") process.exit(1)
        }
    }
}

async function waitFor<T>(
    probe: () => Promise<T>,
    done: (value: T) => boolean,
    timeoutMs: number,
): Promise<T | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const value = await probe()
        if (done(value)) return value
        await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return null
}

void main()
