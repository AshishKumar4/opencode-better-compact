import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { stubTranscript, summarizeTranscript } from "./compact"
import {
    backupTranscript,
    latestBackup,
    latestSessionForCwd,
    liveSessionPid,
    parseTranscript,
    resolveSession,
    serializeTranscript,
    type TranscriptEntry,
} from "./transcript"

interface ClaudeArgs {
    sessionId?: string
    resume: boolean
    aggressive: boolean
    fromBackup: boolean
    run: boolean
    keepTailTokens?: number
    passthrough: string[]
}

export async function claudeCommand(rest: string[]): Promise<void> {
    const args = parseArgs(rest)
    if (args.run) return claudeRun(args)

    const resolved = args.sessionId
        ? resolveSession(args.sessionId)
        : latestSessionForCwd(process.cwd())
    if (!resolved) {
        console.error(
            args.sessionId
                ? `No transcript found for session ${args.sessionId}.`
                : "No Claude Code session found for this directory. Pass a session id.",
        )
        process.exit(1)
    }

    const outcome = compactSession(resolved.file, resolved.sessionId, args)
    if (outcome === "live") process.exit(1)
    if (args.resume) resumeClaude(resolved.sessionId, [])
}

type CompactResult = "compacted" | "nothing" | "live"

// The shared core: refuse-if-live, restore-from-backup, prune, verify, back up,
// write. Used by both the one-shot command and the --run launcher.
function compactSession(file: string, sessionId: string, args: ClaudeArgs): CompactResult {
    const pid = liveSessionPid(sessionId)
    if (pid !== null) {
        console.error(
            `Session ${sessionId} is open in Claude Code (pid ${pid}). ` +
                "Quit that session first — compacting a live transcript is unsafe.",
        )
        return "live"
    }

    if (args.fromBackup) {
        const backup = latestBackup(sessionId)
        if (!backup) {
            console.error(`No backup found for session ${sessionId}.`)
            return "nothing"
        }
        copyFileSync(backup, file)
        console.log(`Restored full history from ${backup}`)
    }

    const original = parseTranscript(readFileSync(file, "utf-8"))
    const options = { keepTailTokens: args.keepTailTokens }

    if (args.aggressive) {
        const outcome = summarizeTranscript(clone(original), options)
        if (!outcome) {
            console.log("Nothing to compact — the session is already small.")
            return "nothing"
        }
        if (!commit(file, outcome.entries, original.length + 2, "summary")) return "nothing"
        console.log(
            `Compacted (aggressive) ${sessionId}: ~${outcome.preTokens.toLocaleString()} -> ` +
                `~${outcome.postTokens.toLocaleString()} est tokens (${outcome.droppedMessages} summarized, ` +
                `${outcome.keptMessages} kept verbatim)`,
        )
        return "compacted"
    }

    const outcome = stubTranscript(clone(original), options)
    if (!outcome) {
        console.log("Nothing to prune — no old tool output or reasoning to stub.")
        return "nothing"
    }
    if (!commit(file, outcome.entries, original.length, "stub")) return "nothing"
    if (outcome.stubbedTools === 0 && outcome.strippedReasoning === 0) {
        console.log(
            `Reset ${sessionId}'s stale context anchor (already pruned; Claude Code will now recount the actual content).`,
        )
    } else {
        console.log(
            `Compacted ${sessionId}: ~${outcome.preTokens.toLocaleString()} -> ` +
                `~${outcome.postTokens.toLocaleString()} est tokens (${outcome.stubbedTools} tool inputs/outputs ` +
                `stubbed, ${outcome.strippedReasoning} reasoning blocks removed; all ${outcome.totalMessages} messages kept)`,
        )
    }
    return "compacted"
}

function commit(
    file: string,
    entries: TranscriptEntry[],
    expectedLines: number,
    mode: "stub" | "summary",
): boolean {
    const serialized = serializeTranscript(entries)
    const check = verifyIntegrity(serialized, entries, expectedLines, mode)
    if (!check.ok) {
        console.error(`Compaction produced an invalid transcript (${check.reason}); aborting.`)
        return false
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backup = backupTranscript(file, stamp)
    writeFileSync(file, serialized)
    console.log(`  backup: ${backup}`)
    return true
}

// --run: wrap `claude` so `/better-compact` can compact + reopen without tmux.
// The command inside the session drops a flag; on exit we honor it, prune, and
// re-exec `claude --resume`, looping until the user quits without a flag.
async function claudeRun(args: ClaudeArgs): Promise<void> {
    let claudeArgs = [...args.passthrough]
    let sessionId = args.sessionId ?? sessionIdFromArgs(claudeArgs)
    if (!sessionId) {
        sessionId = randomUUID()
        claudeArgs = ["--session-id", sessionId, ...claudeArgs]
    }
    const flag = join(homedir(), ".better-compact", "recompact", sessionId)
    mkdirSync(dirname(flag), { recursive: true })
    rmSync(flag, { force: true })

    for (;;) {
        const code = await spawnClaude(claudeArgs)
        if (!existsSync(flag)) process.exit(code)
        rmSync(flag, { force: true })
        const resolved = resolveSession(sessionId)
        if (resolved) compactSession(resolved.file, sessionId, { ...args, resume: false })
        claudeArgs = ["--resume", sessionId]
    }
}

function spawnClaude(claudeArgs: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn("claude", claudeArgs, { stdio: "inherit" })
        child.on("exit", (code) => resolve(code ?? 0))
        child.on("error", reject)
    })
}

function resumeClaude(sessionId: string, extra: string[]): void {
    const child = spawn("claude", ["--resume", sessionId, ...extra], { stdio: "inherit" })
    child.on("exit", (code) => process.exit(code ?? 0))
    child.on("error", (error) => {
        console.error(`Could not launch claude --resume: ${error.message}`)
        process.exit(1)
    })
}

function sessionIdFromArgs(claudeArgs: string[]): string | undefined {
    for (let index = 0; index < claudeArgs.length; index++) {
        if (
            (claudeArgs[index] === "--resume" ||
                claudeArgs[index] === "-r" ||
                claudeArgs[index] === "--session-id") &&
            claudeArgs[index + 1] &&
            !claudeArgs[index + 1].startsWith("-")
        ) {
            return claudeArgs[index + 1]
        }
    }
    return undefined
}

function verifyIntegrity(
    serialized: string,
    entries: TranscriptEntry[],
    expectedLines: number,
    mode: "stub" | "summary",
): { ok: true } | { ok: false; reason: string } {
    let reparsed: TranscriptEntry[]
    try {
        reparsed = parseTranscript(serialized)
    } catch (error) {
        return { ok: false, reason: `re-parse failed: ${(error as Error).message}` }
    }
    if (reparsed.length !== expectedLines) {
        return { ok: false, reason: `line count ${reparsed.length} != expected ${expectedLines}` }
    }
    if (mode === "summary") {
        const summary = entries[entries.length - 1]
        const boundary = entries[entries.length - 2]
        if (boundary?.subtype !== "compact_boundary" || boundary.parentUuid !== null) {
            return { ok: false, reason: "boundary marker malformed" }
        }
        if (!summary?.isCompactSummary || summary.parentUuid !== boundary.uuid) {
            return { ok: false, reason: "summary not rooted at boundary" }
        }
    }
    return { ok: true }
}

function clone(entries: TranscriptEntry[]): TranscriptEntry[] {
    return entries.map((entry) => structuredClone(entry))
}

function parseArgs(rest: string[]): ClaudeArgs {
    const args: ClaudeArgs = { resume: false, aggressive: false, fromBackup: false, run: false, passthrough: [] }
    let seenRun = false
    for (let index = 0; index < rest.length; index++) {
        const token = rest[index]
        // Everything after --run is forwarded to claude verbatim.
        if (seenRun) {
            args.passthrough.push(token)
            continue
        }
        if (token === "--run") {
            args.run = true
            seenRun = true
        } else if (token === "--resume") args.resume = true
        else if (token === "--aggressive") args.aggressive = true
        else if (token === "--from-backup") args.fromBackup = true
        else if (token === "--keep-tokens") args.keepTailTokens = Number(rest[++index]) || undefined
        else if (!token.startsWith("-") && !args.sessionId) args.sessionId = token
    }
    return args
}
