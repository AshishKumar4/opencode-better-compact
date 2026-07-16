import { spawn } from "node:child_process"
import { copyFileSync, readFileSync, writeFileSync } from "node:fs"
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
    keepTailTokens?: number
}

export async function claudeCommand(rest: string[]): Promise<void> {
    const args = parseArgs(rest)

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

    const pid = liveSessionPid(resolved.sessionId)
    if (pid !== null) {
        console.error(
            `Session ${resolved.sessionId} is open in Claude Code (pid ${pid}). ` +
                "Quit that session first — compacting a live transcript is unsafe.",
        )
        process.exit(1)
    }

    if (args.fromBackup) {
        const backup = latestBackup(resolved.sessionId)
        if (!backup) {
            console.error(`No backup found for session ${resolved.sessionId}.`)
            process.exit(1)
        }
        copyFileSync(backup, resolved.file)
        console.log(`Restored full history from ${backup}`)
    }

    const original = parseTranscript(readFileSync(resolved.file, "utf-8"))
    const options = { keepTailTokens: args.keepTailTokens }

    if (args.aggressive) {
        const outcome = summarizeTranscript(clone(original), options)
        if (!outcome) return done("Nothing to compact — the session is already small.", args, resolved.sessionId)
        commit(resolved.file, outcome.entries, original.length + 2, "summary")
        console.log(`Compacted (aggressive) ${resolved.sessionId}:`)
        console.log(
            `  ~${outcome.preTokens.toLocaleString()} -> ~${outcome.postTokens.toLocaleString()} est tokens` +
                ` (${outcome.droppedMessages} messages summarized, ${outcome.keptMessages} kept verbatim)`,
        )
        reportBackupAndResume(resolved.file, args, resolved.sessionId)
        return
    }

    const working = clone(original)
    const outcome = stubTranscript(working, options)
    if (!outcome) return done("Nothing to prune — no old tool output or reasoning to stub.", args, resolved.sessionId)
    commit(resolved.file, outcome.entries, original.length, "stub")
    console.log(`Compacted ${resolved.sessionId}:`)
    console.log(
        `  ~${outcome.preTokens.toLocaleString()} -> ~${outcome.postTokens.toLocaleString()} est tokens` +
            ` (${outcome.stubbedTools} tool outputs stubbed, ${outcome.strippedReasoning} reasoning blocks removed;` +
            ` all ${outcome.totalMessages} messages kept)`,
    )
    reportBackupAndResume(resolved.file, args, resolved.sessionId)
}

// Written just before commit; stashed so reportBackupAndResume can print it.
let lastBackup = ""

function commit(
    file: string,
    entries: TranscriptEntry[],
    expectedLines: number,
    mode: "stub" | "summary",
): void {
    const serialized = serializeTranscript(entries)
    const check = verifyIntegrity(serialized, entries, expectedLines, mode)
    if (!check.ok) {
        console.error(`Compaction produced an invalid transcript (${check.reason}); aborting.`)
        process.exit(1)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    lastBackup = backupTranscript(file, stamp)
    writeFileSync(file, serialized)
}

function reportBackupAndResume(file: string, args: ClaudeArgs, sessionId: string): void {
    console.log(`  backup: ${lastBackup}`)
    if (args.resume) resumeClaude(sessionId)
}

function done(message: string, args: ClaudeArgs, sessionId: string): void {
    console.log(message)
    if (args.resume) resumeClaude(sessionId)
}

function resumeClaude(sessionId: string): void {
    const child = spawn("claude", ["--resume", sessionId], { stdio: "inherit" })
    child.on("exit", (code) => process.exit(code ?? 0))
    child.on("error", (error) => {
        console.error(`Could not launch claude --resume: ${error.message}`)
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
    const args: ClaudeArgs = { resume: false, aggressive: false, fromBackup: false }
    for (let index = 0; index < rest.length; index++) {
        const token = rest[index]
        if (token === "--resume") args.resume = true
        else if (token === "--aggressive") args.aggressive = true
        else if (token === "--from-backup") args.fromBackup = true
        else if (token === "--keep-tokens") args.keepTailTokens = Number(rest[++index]) || undefined
        else if (!token.startsWith("-") && !args.sessionId) args.sessionId = token
    }
    return args
}
