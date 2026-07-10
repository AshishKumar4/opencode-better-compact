import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { TranscriptStore } from "@better-compact/core"

// Transcripts live under pi's session storage rather than the project tree:
// pi keeps no project-scoped data dir, and the reference message needs a path
// the agent's read tool can open from any cwd, so citablePath is absolute.
export function createTranscriptStore(sessionDir: string): TranscriptStore {
    const root = join(sessionDir, "better-compact")
    return {
        citablePath: (sessionKey, rangeHash) => join(root, sessionKey, `${rangeHash}.md`),
        async write(path, content) {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, content, "utf-8")
            return { absolutePath: path }
        },
    }
}
