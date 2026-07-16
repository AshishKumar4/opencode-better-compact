import { spawn } from "node:child_process"
import { mkdirSync, openSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_PORT, loadConfig, proxyPaths, type ProxyPaths } from "./config"
import { claudeCommand } from "./claude/command"
import { checkHealth, daemonNeedsRestart, decideStop, readLock, runDaemon } from "./daemon"
import {
    ANTHROPIC_PROXY_BASE_URL,
    CODEX_PROXY_BASE_URL,
    installClaudeCode,
    installCodex,
} from "./install"

const HELP = `better-compact — local context-pruning for coding agents

Usage:
  better-compact claude [sessionId] [--resume]   Compact a Claude Code session on disk
  better-compact start [--capture]   Start the proxy daemon (idempotent)
  better-compact run [--capture]     Run the proxy in the foreground
  better-compact stop                Stop the daemon
  better-compact status              Show daemon status
  better-compact install claude-code Point Claude Code settings at the proxy
  better-compact install codex       Point Codex config.toml at the proxy

better-compact claude prunes old tool output and reasoning from a session's
transcript in place, keeping every message, so it reopens under Claude Code's
context limit. Quit the session first. Flags:
  --resume        reopen the session afterward
  --aggressive    summarize old turns instead (drops them from view; last resort)
  --from-backup   restore the full history from the latest backup, then compact
  --keep-tokens N recent-tail budget kept fully intact (default 25000)
Originals are backed up to ~/.better-compact/claude-backups/.
--capture writes sanitized request bodies to ~/.better-compact/captures/`

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2)
    const capture = rest.includes("--capture")
    const paths = proxyPaths()

    switch (command) {
        case "claude": {
            await claudeCommand(rest)
            return
        }
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
                console.log("better-compact is not running")
                return
            }
            try {
                process.kill(decision.pid, "SIGTERM")
            } catch {
                console.log("better-compact is not running")
                return
            }
            const stopped = await waitFor(
                () => checkHealth(DEFAULT_PORT),
                (state) => state.kind === "down",
                3_000,
            )
            console.log(
                stopped
                    ? `Stopped better-compact (pid ${decision.pid})`
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
        const shouldRestart = daemonNeedsRestart(health, loadConfig(paths), capture)
        if (!shouldRestart) {
            console.log(
                `better-compact already running (pid ${health.pid}, port ${DEFAULT_PORT})`,
            )
            return
        }
        capture = capture || health.capture
        try {
            process.kill(health.pid, "SIGTERM")
        } catch {
            const current = await checkHealth(DEFAULT_PORT)
            if (current.kind !== "down") {
                console.error(`Could not restart better-compact (pid ${health.pid})`)
                process.exit(1)
            }
        }
        const stopped = await waitFor(
            () => checkHealth(DEFAULT_PORT),
            (state) => state.kind === "down",
            3_000,
        )
        if (!stopped) {
            console.error(`Could not restart better-compact (pid ${health.pid})`)
            process.exit(1)
        }
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
    console.log(`better-compact started (pid ${started.pid}, port ${DEFAULT_PORT})`)
    console.log(`Anthropic upstream: ${started.upstream}`)
    console.log(`OpenAI upstream: ${started.openaiUpstream}`)
}

async function installCommand(
    target: string | undefined,
    paths: ProxyPaths,
    capture: boolean,
): Promise<void> {
    if (target !== "claude-code" && target !== "codex") {
        console.error("Valid targets: claude-code, codex")
        process.exit(1)
    }

    if (target === "claude-code") {
        let result
        try {
            result = installClaudeCode(paths)
        } catch (error) {
            console.error(`Claude Code installation failed: ${(error as Error).message}`)
            process.exit(1)
        }

        console.log("Better Compact is now wired into Claude Code. Changes made:")
        if (result.previousBaseUrl) {
            console.log(
                `  - ${result.configJsonPath}: recorded your previous ANTHROPIC_BASE_URL (${result.previousBaseUrl}) as the proxy upstream`,
            )
        } else {
            console.log(`  - ${result.configJsonPath}: wrote proxy configuration`)
        }
        console.log(
            `  - ${result.settingsPath}: env.ANTHROPIC_BASE_URL=${ANTHROPIC_PROXY_BASE_URL}, env.DISABLE_AUTO_COMPACT=1`,
        )
        await startDaemon(paths, capture)
        console.log("")
        console.log("Claude Code will now route through the proxy.")
        console.log("")
        console.log("To undo:")
        for (const step of result.undoSteps) console.log(`  ${step}`)
        console.log("")
        console.log("Note for OAuth (subscription) logins: OAuth was verified working through the")
        console.log("proxy on Claude Code 2.1.205 with no extra configuration. If a different")
        console.log("version rejects OAuth against a custom base URL, see the README section on")
        console.log("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL.")
        return
    }

    let result
    try {
        result = installCodex(paths)
    } catch (error) {
        console.error(`Codex installation failed: ${(error as Error).message}`)
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
    console.log("  better-compact stop")
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
