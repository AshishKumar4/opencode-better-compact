import { dirname, join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import type { TranscriptStore } from "@better-compact/core"

const TRANSCRIPT_ROOT = ".opencode/better-compact/sessions"

export function transcriptCitablePath(sessionKey: string, rangeHash: string): string {
    return `${TRANSCRIPT_ROOT}/${safePathPart(sessionKey)}/${rangeHash}.md`
}

export function createTranscriptStore(directory: string): TranscriptStore {
    return {
        citablePath: transcriptCitablePath,
        async write(relativePath, content) {
            const absolutePath = join(directory, relativePath)
            await mkdir(dirname(absolutePath), { recursive: true })
            await writeFile(absolutePath, content, "utf-8")
            return { absolutePath }
        },
    }
}

function safePathPart(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown"
}
