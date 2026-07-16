import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stubTranscript, summarizeTranscript } from "./compact"
import {
    backupTranscript,
    latestSessionForCwd,
    liveSessionPid,
    parseTranscript,
    resolveSession,
    restoreFromBackups,
    resumeModelArgs,
    serializeTranscript,
    sessionBackups,
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
    if (outcome.status === "live" || outcome.status === "failed") process.exit(1)
    if (args.resume) resumeClaude(["--resume", resolved.sessionId, ...outcome.resumeModel])
}

// resumeModel carries the [1m] variant when the pre-compaction transcript
// proves the session needs the long context — computed BEFORE the usage
// reset zeroes that evidence.
interface CompactResult {
    status: "compacted" | "nothing" | "live" | "failed"
    resumeModel: string[]
}

// The shared core: refuse-if-live, restore-from-backups, prune, verify, back
// up, write. Used by both the one-shot command and the --run launcher.
function compactSession(file: string, sessionId: string, args: ClaudeArgs): CompactResult {
    const pid = liveSessionPid(sessionId)
    if (pid !== null) {
        console.error(
            `Session ${sessionId} is open in Claude Code (pid ${pid}). ` +
                "Quit that session first — compacting a live transcript is unsafe.",
        )
        return { status: "live", resumeModel: [] }
    }

    let original: TranscriptEntry[]
    try {
        original = parseTranscript(readFileSync(file, "utf-8"))
    } catch (error) {
        console.error(`Could not parse ${file}: ${(error as Error).message}`)
        return { status: "failed", resumeModel: [] }
    }
    const resumeModel = resumeModelArgs(original)

    // Restoration is in-memory: the file is only ever written through
    // commit(), which backs up the current state first — turns added after a
    // backup are never lost.
    let working = clone(original)
    if (args.fromBackup) {
        const backups = sessionBackups(sessionId)
        if (backups.length === 0) {
            console.error(`No backups found for session ${sessionId}.`)
            return { status: "failed", resumeModel }
        }
        working = restoreFromBackups(working, backups)
        console.log(`Restored original content from ${backups.length} backup(s).`)
    }

    const options = { keepTailTokens: args.keepTailTokens }
    if (args.aggressive) {
        const outcome = summarizeTranscript(working, options)
        if (!outcome) {
            console.log("Nothing to compact — the session is already small.")
            return { status: "nothing", resumeModel }
        }
        if (!commit(file, sessionId, outcome.entries, original.length + 2, "summary")) {
            return { status: "failed", resumeModel }
        }
        console.log(
            `Compacted (aggressive) ${sessionId}: ~${outcome.preTokens.toLocaleString()} -> ` +
                `~${outcome.postTokens.toLocaleString()} est tokens (${outcome.droppedMessages} summarized, ` +
                `${outcome.keptMessages} kept verbatim)`,
        )
        return { status: "compacted", resumeModel }
    }

    const outcome = stubTranscript(working, options)
    if (!outcome) {
        console.log("Nothing to prune — no old tool output or reasoning to stub.")
        return { status: "nothing", resumeModel }
    }
    if (!commit(file, sessionId, outcome.entries, original.length, "stub")) {
        return { status: "failed", resumeModel }
    }
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
    return { status: "compacted", resumeModel }
}

function commit(
    file: string,
    sessionId: string,
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
    // Compaction of a large transcript takes real time: re-check that no
    // Claude Code instance grabbed the session while we worked.
    const pid = liveSessionPid(sessionId)
    if (pid !== null) {
        console.error(
            `Session ${sessionId} was opened in Claude Code (pid ${pid}) during compaction; aborting.`,
        )
        return false
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backup = backupTranscript(file, stamp)
    const tmp = `${file}.better-compact-tmp`
    writeFileSync(tmp, serialized)
    renameSync(tmp, file)
    console.log(`  backup: ${backup}`)
    return true
}

// --run: wrap `claude` so `/better-compact:compact` can compact + reopen
// without tmux. The command inside the session drops a flag file named by its
// session id; on exit we honor it, prune, and re-exec `claude --resume`,
// looping until the user quits without a flag. No session-id injection: the
// flag itself tells us which session was open, so picker-style `--resume`,
// `--continue`, and plain launches all work.
async function claudeRun(args: ClaudeArgs): Promise<void> {
    const flagDir = join(homedir(), ".better-compact", "recompact")
    mkdirSync(flagDir, { recursive: true })
    let claudeArgs = [...args.passthrough]

    for (;;) {
        const launchedAt = Date.now()
        const code = await spawnClaude(claudeArgs)
        const flagged = newestFlag(flagDir, launchedAt)
        if (!flagged) process.exit(code)
        rmSync(join(flagDir, flagged), { force: true })

        const resolved = resolveSession(flagged)
        const outcome = resolved
            ? compactSession(resolved.file, flagged, args)
            : (console.error(`No transcript found for flagged session ${flagged}; resuming as-is.`),
              { status: "nothing" as const, resumeModel: [] })
        // Session selection is now explicit; every other user flag rides along,
        // and an explicit user --model always wins over the inferred one.
        const kept = stripSessionArgs(args.passthrough)
        const model = kept.includes("--model") ? [] : outcome.resumeModel
        claudeArgs = ["--resume", flagged, ...model, ...kept]
    }
}

// The flag file written by /better-compact:compact during this claude run.
function newestFlag(flagDir: string, launchedAt: number): string | null {
    let newest: { name: string; mtimeMs: number } | null = null
    for (const name of readdirSync(flagDir)) {
        const mtimeMs = statSync(join(flagDir, name)).mtimeMs
        // Small slack for clock skew between touch(1) and Date.now().
        if (mtimeMs < launchedAt - 5_000) continue
        if (!newest || mtimeMs > newest.mtimeMs) newest = { name, mtimeMs }
    }
    return newest?.name ?? null
}

// Drop session-selection flags from the user's claude args; the relaunch
// names its session explicitly and everything else is preserved.
export function stripSessionArgs(claudeArgs: string[]): string[] {
    const kept: string[] = []
    for (let index = 0; index < claudeArgs.length; index++) {
        const token = claudeArgs[index]
        if (token === "--continue" || token === "-c") continue
        if (token === "--resume" || token === "-r" || token === "--session-id") {
            const next = claudeArgs[index + 1]
            if (next !== undefined && !next.startsWith("-")) index++
            continue
        }
        kept.push(token)
    }
    return kept
}

function spawnClaude(claudeArgs: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn("claude", claudeArgs, { stdio: "inherit" })
        child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)))
        child.on("error", reject)
    })
}

function resumeClaude(claudeArgs: string[]): void {
    const child = spawn("claude", claudeArgs, { stdio: "inherit" })
    child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
    child.on("error", (error) => {
        console.error(`Could not launch claude: ${error.message}`)
        process.exit(1)
    })
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
    const args: ClaudeArgs = {
        resume: false,
        aggressive: false,
        fromBackup: false,
        run: false,
        passthrough: [],
    }
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
        else if (token === "--keep-tokens") {
            const value = Number(rest[++index])
            if (!Number.isFinite(value) || value <= 0) {
                console.error("--keep-tokens requires a positive number.")
                process.exit(1)
            }
            args.keepTailTokens = value
        } else if (!token.startsWith("-") && !args.sessionId) args.sessionId = token
    }
    return args
}
