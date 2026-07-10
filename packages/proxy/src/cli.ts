import { spawn } from "node:child_process"
import { mkdirSync, openSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_PORT, loadConfig, proxyPaths, type ProxyPaths } from "./config"
import { checkHealth, decideStop, readLock, runDaemon } from "./daemon"
import { CODEX_PROXY_BASE_URL, installCodex } from "./install"

const HELP = `better-compact-proxy — local context-pruning proxy for coding agents

Usage:
  better-compact-proxy start [--capture]   Start the daemon (idempotent)
  better-compact-proxy run [--capture]     Run in the foreground
  better-compact-proxy stop                Stop the daemon
  better-compact-proxy status              Show daemon status
  better-compact-proxy install codex       Point Codex (~/.codex/config.toml) at the proxy

--capture writes sanitized request bodies to ~/.better-compact/captures/`

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2)
    const capture = rest.includes("--capture")
    const paths = proxyPaths()

    switch (command) {
        case "start": {
            await startDaemon(paths, capture)
            return
        }
        case "install": {
            await installCommand(rest[0], paths, capture)
            return
        }
        case "run": {
            runDaemon(paths, DEFAULT_PORT, capture)
            return
        }
        case "stop": {
            const decision = decideStop(await checkHealth(DEFAULT_PORT), readLock(paths))
            if (decision.action !== "signal") {
                if (decision.action === "clear-stale") rmSync(paths.lockfile, { force: true })
                console.log("better-compact-proxy is not running")
                return
            }
            try {
                process.kill(decision.pid, "SIGTERM")
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
                    ? `Stopped better-compact-proxy (pid ${decision.pid})`
                    : `Sent SIGTERM to pid ${decision.pid}`,
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

async function startDaemon(paths: ProxyPaths, capture: boolean): Promise<void> {
    const health = await checkHealth(DEFAULT_PORT)
    if (health.kind === "ours") {
        console.log(
            `better-compact-proxy already running (pid ${health.pid}, port ${DEFAULT_PORT})`,
        )
        return
    }
    if (health.kind === "foreign") {
        console.error(`Port ${DEFAULT_PORT} is in use by another process; refusing to start.`)
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
    console.log(`Anthropic upstream: ${started.upstream}`)
    console.log(`OpenAI upstream: ${started.openaiUpstream}`)
}

async function installCommand(
    target: string | undefined,
    paths: ProxyPaths,
    capture: boolean,
): Promise<void> {
    if (target !== "codex") {
        console.error("Usage: better-compact-proxy install codex")
        process.exit(1)
    }
    let result
    try {
        result = installCodex(paths)
    } catch (error) {
        console.error(`Refusing to edit ~/.codex/config.toml: ${(error as Error).message}`)
        process.exit(1)
    }

    console.log("Better Compact is now wired into Codex. Changes made:")
    console.log(
        `  - ${result.codexConfigPath}: ${result.action} openai_base_url = "${CODEX_PROXY_BASE_URL}"`,
    )
    if (result.previousBaseUrl) {
        console.log(
            `  - ${result.configJsonPath}: recorded your previous base_url (${result.previousBaseUrl}) as the proxy upstream`,
        )
    }
    await startDaemon(paths, capture)
    console.log("")
    console.log("Codex will now route through the proxy. Native 90% auto-compaction is pre-empted")
    console.log("structurally by our earlier trigger; no Codex setting needs disabling.")
    console.log("")
    console.log("To undo:")
    console.log("  better-compact-proxy stop")
    console.log(
        result.previousBaseUrl
            ? `  restore openai_base_url = "${result.previousBaseUrl}" in ${result.codexConfigPath}`
            : `  remove the openai_base_url line from ${result.codexConfigPath}`,
    )
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
