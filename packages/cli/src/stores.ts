import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Logger, PlanSnapshot, PlanStore, TranscriptStore } from "@better-compact/core"

// Session keys become path segments; anything outside a conservative
// character set is folded away so a hostile key cannot traverse.
export function sanitizeKey(key: string): string {
    return key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown"
}

// In-memory map backed by ~/.better-compact/plans/<key>.json, so a restarted
// daemon replays the plans live sessions were built on.
export function createPlanStore(plansDir: string, logger: Logger): PlanStore {
    const cache = new Map<string, PlanSnapshot | null>()
    const fileOf = (sessionKey: string) => join(plansDir, `${sanitizeKey(sessionKey)}.json`)
    return {
        async load(sessionKey) {
            if (cache.has(sessionKey)) return cache.get(sessionKey) ?? null
            let snapshot: PlanSnapshot | null = null
            try {
                snapshot = JSON.parse(await readFile(fileOf(sessionKey), "utf-8")) as PlanSnapshot
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    logger.warn("Failed to read persisted plan", {
                        sessionKey,
                        error: String(error),
                    })
                }
            }
            cache.set(sessionKey, snapshot)
            return snapshot
        },
        async save(sessionKey, snapshot) {
            cache.set(sessionKey, snapshot)
            if (!snapshot) {
                await rm(fileOf(sessionKey), { force: true })
                return
            }
            await mkdir(plansDir, { recursive: true })
            await writeFile(fileOf(sessionKey), JSON.stringify(snapshot, null, 2), "utf-8")
        },
    }
}

// citablePath is absolute: the reference message must cite a path the
// agent's Read tool can open from any cwd.
export function createTranscriptStore(transcriptsDir: string): TranscriptStore {
    return {
        citablePath: (sessionKey, rangeHash) =>
            join(transcriptsDir, sanitizeKey(sessionKey), `${rangeHash}.md`),
        async write(path, content) {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, content, "utf-8")
            return { absolutePath: path }
        },
    }
}
