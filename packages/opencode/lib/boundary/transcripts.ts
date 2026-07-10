import { join } from "node:path"
import type { TranscriptStore } from "@better-compact/core"
import { writePrivateFile } from "../private-storage"

const PLUGIN_ROOT = ".opencode/better-compact"
const TRANSCRIPT_ROOT = `${PLUGIN_ROOT}/sessions`

export function transcriptCitablePath(sessionKey: string, rangeHash: string): string {
    return `${TRANSCRIPT_ROOT}/${safePathPart(sessionKey)}/${rangeHash}.md`
}

// Transcripts carry raw session history: private modes, symlink refusal, and
// a blanket gitignore so they never land in the user's repository.
export function createTranscriptStore(directory: string): TranscriptStore {
    return {
        citablePath: transcriptCitablePath,
        async write(relativePath, content) {
            const absolutePath = join(directory, relativePath)
            await writePrivateFile(join(directory, PLUGIN_ROOT, ".gitignore"), "*\n!.gitignore\n", directory)
            await writePrivateFile(absolutePath, content, directory)
            return { absolutePath }
        },
    }
}

function safePathPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown"
}
