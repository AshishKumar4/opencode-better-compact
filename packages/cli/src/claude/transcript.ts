import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// A single line of a Claude Code session transcript. Only the fields the
// compactor reads are named; everything else rides along via the index
// signature and is re-emitted verbatim.
export interface TranscriptEntry {
    type?: string
    subtype?: string
    uuid?: string
    parentUuid?: string | null
    message?: { role: string; content: unknown; [key: string]: unknown }
    sessionId?: string
    session_id?: string
    cwd?: string
    version?: string
    gitBranch?: string
    timestamp?: string
    isCompactSummary?: boolean
    [key: string]: unknown
}

export function projectsDir(home = homedir()): string {
    return join(home, ".claude", "projects")
}

export function sessionsDir(home = homedir()): string {
    return join(home, ".claude", "sessions")
}

export function parseTranscript(text: string): TranscriptEntry[] {
    const entries: TranscriptEntry[] = []
    for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        entries.push(JSON.parse(trimmed) as TranscriptEntry)
    }
    return entries
}

export function serializeTranscript(entries: TranscriptEntry[]): string {
    return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
}

export interface ResolvedSession {
    sessionId: string
    file: string
    projectDir: string
}

// Locate `<sessionId>.jsonl` across every project directory. Session ids are
// globally unique, so the first match is authoritative.
export function resolveSession(sessionId: string, home = homedir()): ResolvedSession | null {
    const root = projectsDir(home)
    if (!existsSync(root)) return null
    for (const project of readdirSync(root)) {
        const file = join(root, project, `${sessionId}.jsonl`)
        if (existsSync(file)) return { sessionId, file, projectDir: join(root, project) }
    }
    return null
}

// The most recently modified session transcript for a working directory,
// used when no session id is given. Claude Code encodes the project dir as
// the cwd with every non-alphanumeric replaced by `-` (verified against the
// 2.1.211 binary; paths over 200 chars additionally get truncated with a
// hash suffix — those fall through to a cwd-field scan of the transcripts).
export function latestSessionForCwd(cwd: string, home = homedir()): ResolvedSession | null {
    const projectDir = join(projectsDir(home), cwd.replace(/[^a-zA-Z0-9]/g, "-"))
    if (existsSync(projectDir)) return newestTranscript(projectDir)

    const root = projectsDir(home)
    if (!existsSync(root)) return null
    for (const project of readdirSync(root)) {
        const dir = join(root, project)
        const newest = newestTranscript(dir)
        if (newest && transcriptCwd(newest.file) === cwd) return newest
    }
    return null
}

function newestTranscript(projectDir: string): ResolvedSession | null {
    let newest: { file: string; sessionId: string; mtimeMs: number } | null = null
    for (const name of readdirSync(projectDir)) {
        if (!name.endsWith(".jsonl")) continue
        const file = join(projectDir, name)
        const mtimeMs = statSync(file).mtimeMs
        if (!newest || mtimeMs > newest.mtimeMs) {
            newest = { file, sessionId: name.slice(0, -".jsonl".length), mtimeMs }
        }
    }
    return newest ? { sessionId: newest.sessionId, file: newest.file, projectDir } : null
}

// The cwd recorded by the transcript's first entries that carry one.
function transcriptCwd(file: string): string | null {
    let text: string
    try {
        text = readFileSync(file, "utf-8")
    } catch {
        return null
    }
    for (const line of text.split("\n").slice(0, 20)) {
        if (!line.trim()) continue
        try {
            const entry = JSON.parse(line) as TranscriptEntry
            if (typeof entry.cwd === "string") return entry.cwd
        } catch {
            continue
        }
    }
    return null
}

// A session is live when a registry entry names it and that process is still
// running — or when a claude process was launched to resume it but has not
// registered yet (the registry lags startup by several seconds, a real race).
// Editing a live transcript is unsafe: Claude Code reads it once at resume
// and holds it in memory, blind to any change underneath.
export function liveSessionPid(sessionId: string, home = homedir()): number | null {
    const dir = sessionsDir(home)
    if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
            if (!name.endsWith(".json")) continue
            let record: { sessionId?: string; pid?: number }
            try {
                record = JSON.parse(readFileSync(join(dir, name), "utf-8")) as {
                    sessionId?: string
                    pid?: number
                }
            } catch {
                continue
            }
            if (record.sessionId !== sessionId || typeof record.pid !== "number") continue
            try {
                process.kill(record.pid, 0)
                return record.pid
            } catch {
                // ESRCH: the process is gone, the registry entry is stale.
            }
        }
    }
    return resumingProcessPid(sessionId)
}

// A not-yet-registered `claude --resume <id>` (or --session-id) process,
// found by its command line. Linux reads /proc directly; elsewhere `ps`.
function resumingProcessPid(sessionId: string): number | null {
    if (process.platform === "linux") {
        for (const name of readdirSync("/proc")) {
            const pid = Number(name)
            if (!Number.isInteger(pid) || pid === process.pid) continue
            let cmdline: string
            try {
                cmdline = readFileSync(join("/proc", name, "cmdline"), "utf-8")
            } catch {
                continue
            }
            const args = cmdline.split("\0")
            if (args.some((arg) => arg === sessionId) && args.some(isClaudeArg)) return pid
        }
        return null
    }
    try {
        const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf-8" })
        for (const line of out.split("\n")) {
            const parts = line.trim().split(/\s+/)
            const pid = Number(parts[0])
            if (!Number.isInteger(pid) || pid === process.pid) continue
            if (parts.includes(sessionId) && parts.some(isClaudeArg)) return pid
        }
    } catch {
        // ps unavailable: fall back to registry-only detection.
    }
    return null
}

// The claude binary itself (argv0 or a re-exec path), not any string that
// happens to mention it — a shell wrapper quoting the command must not match.
function isClaudeArg(arg: string): boolean {
    return arg === "claude" || arg.endsWith("/claude")
}

export function backupDir(home = homedir()): string {
    return join(home, ".better-compact", "claude-backups")
}

export function backupTranscript(file: string, stamp: string): string {
    const dir = backupDir()
    mkdirSync(dir, { recursive: true })
    const base = file.split("/").pop() ?? "session.jsonl"
    const backup = join(dir, `${base}.${stamp}.bak`)
    copyFileSync(file, backup)
    return backup
}

// All backups captured for a session, oldest first.
export function sessionBackups(sessionId: string, home = homedir()): string[] {
    const dir = backupDir(home)
    if (!existsSync(dir)) return []
    const prefix = `${sessionId}.jsonl.`
    return readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
        .map((name) => join(dir, name))
        .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
}

// Restore original content in memory: entries are appended once by Claude
// Code and only ever modified by compaction, so the OLDEST backup containing
// an entry holds its original form. Later backups are themselves pruned, and
// turns added after a backup exist only in the current file — the current
// entry list stays authoritative for membership and order, each entry
// swapped for its oldest recorded version.
export function restoreFromBackups(
    current: TranscriptEntry[],
    backupFiles: string[],
): TranscriptEntry[] {
    const oldest = new Map<string, TranscriptEntry>()
    for (const file of backupFiles) {
        for (const entry of parseTranscript(readFileSync(file, "utf-8"))) {
            if (typeof entry.uuid === "string" && !oldest.has(entry.uuid)) {
                oldest.set(entry.uuid, entry)
            }
        }
    }
    return current.map((entry) =>
        typeof entry.uuid === "string" ? (oldest.get(entry.uuid) ?? entry) : entry,
    )
}
