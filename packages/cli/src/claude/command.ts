import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { compactTranscript } from "./compact"
import {
    backupTranscript,
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

    const entries = parseTranscript(readFileSync(resolved.file, "utf-8"))
    const outcome = compactTranscript(entries, { keepTailTokens: args.keepTailTokens })
    if (!outcome) {
        console.log("Nothing to compact — the session is already small.")
        if (args.resume) resumeClaude(resolved.sessionId)
        return
    }

    const serialized = serializeTranscript(outcome.entries)
    const check = verifyIntegrity(serialized, outcome.entries)
    if (!check.ok) {
        console.error(`Compaction produced an invalid transcript (${check.reason}); aborting.`)
        process.exit(1)
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backup = backupTranscript(resolved.file, stamp)
    writeFileSync(resolved.file, serialized)

    console.log(`Compacted ${resolved.sessionId}:`)
    console.log(
        `  ~${outcome.preTokens.toLocaleString()} -> ~${outcome.postTokens.toLocaleString()} est tokens` +
            ` (${outcome.droppedMessages} messages summarized, ${outcome.keptMessages} kept verbatim)`,
    )
    console.log(`  backup: ${backup}`)

    if (args.resume) resumeClaude(resolved.sessionId)
}

function resumeClaude(sessionId: string): void {
    const child = spawn("claude", ["--resume", sessionId], { stdio: "inherit" })
    child.on("exit", (code) => process.exit(code ?? 0))
    child.on("error", (error) => {
        console.error(`Could not launch claude --resume: ${error.message}`)
        process.exit(1)
    })
}

// The two appended entries must form a valid resumable chain, and every line
// must still parse — otherwise Claude Code would reject the transcript.
function verifyIntegrity(
    serialized: string,
    entries: TranscriptEntry[],
): { ok: true } | { ok: false; reason: string } {
    let reparsed: TranscriptEntry[]
    try {
        reparsed = parseTranscript(serialized)
    } catch (error) {
        return { ok: false, reason: `re-parse failed: ${(error as Error).message}` }
    }
    if (reparsed.length !== entries.length) {
        return { ok: false, reason: "line count changed" }
    }
    const summary = entries[entries.length - 1]
    const boundary = entries[entries.length - 2]
    if (boundary?.subtype !== "compact_boundary" || boundary.parentUuid !== null) {
        return { ok: false, reason: "boundary marker malformed" }
    }
    if (!summary?.isCompactSummary || summary.parentUuid !== boundary.uuid) {
        return { ok: false, reason: "summary not rooted at boundary" }
    }
    return { ok: true }
}

function parseArgs(rest: string[]): ClaudeArgs {
    const args: ClaudeArgs = { resume: false }
    for (let index = 0; index < rest.length; index++) {
        const token = rest[index]
        if (token === "--resume") args.resume = true
        else if (token === "--keep-tokens") args.keepTailTokens = Number(rest[++index]) || undefined
        else if (!token.startsWith("-") && !args.sessionId) args.sessionId = token
    }
    return args
}
