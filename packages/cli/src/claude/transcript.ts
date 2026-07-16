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
// used when no session id is given. Matches Claude Code's own project-dir
// encoding (cwd with `/` and `.` replaced by `-`).
export function latestSessionForCwd(cwd: string, home = homedir()): ResolvedSession | null {
    const encoded = cwd.replace(/[/.]/g, "-")
    const projectDir = join(projectsDir(home), encoded)
    if (!existsSync(projectDir)) return null
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

// A session is live when a registry entry names it and that process is still
// running. Editing a live transcript is unsafe: Claude Code holds it in
// memory and would overwrite the change on its next append.
export function liveSessionPid(sessionId: string, home = homedir()): number | null {
    const dir = sessionsDir(home)
    if (!existsSync(dir)) return null
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
    return null
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

// The most recent backup captured for a session, used by --from-backup to
// undo a prior compaction before recompacting from the full history.
export function latestBackup(sessionId: string, home = homedir()): string | null {
    const dir = backupDir(home)
    if (!existsSync(dir)) return null
    const prefix = `${sessionId}.jsonl.`
    let newest: { file: string; mtimeMs: number } | null = null
    for (const name of readdirSync(dir)) {
        if (!name.startsWith(prefix) || !name.endsWith(".bak")) continue
        const file = join(dir, name)
        const mtimeMs = statSync(file).mtimeMs
        if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs }
    }
    return newest?.file ?? null
}
