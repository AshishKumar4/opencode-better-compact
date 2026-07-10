/**
 * State persistence for the Better Compact plugin.
 * Persists the boundary pruning plan across sessions so it survives OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/better-compact/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { BoundaryPlanSnapshot, SessionState } from "./types"
import type { Logger } from "../logger"
import { ensurePrivateDirectory, securePrivateFile, securePrivateTree, writePrivateFile } from "../private-storage"

export interface PersistedSessionState {
    sessionName?: string
    manualMode?: boolean
    boundary?: {
        activePlan?: SessionState["boundary"]["activePlan"]
        job?: SessionState["boundary"]["job"]
    }
    lastUpdated: string
}

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "better-compact",
)

async function ensureStorageDir(): Promise<void> {
    await ensurePrivateDirectory(STORAGE_DIR)
}

export async function secureSessionStorage(): Promise<void> {
    await securePrivateTree(STORAGE_DIR)
}

const stateWrites = new Map<string, Promise<void>>()
let boundaryPlanIndex: Promise<BoundaryPlanSnapshot[]> | undefined

function getSessionFilePath(sessionId: string): string {
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(sessionId)) {
        throw new Error(`Invalid Better Compact session ID: ${sessionId}`)
    }
    return join(STORAGE_DIR, `${sessionId}.json`)
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
): Promise<void> {
    const filePath = getSessionFilePath(sessionId)
    const content = JSON.stringify(state, null, 2)
    const previous = stateWrites.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => writePrivateFile(filePath, content, STORAGE_DIR))
    stateWrites.set(sessionId, current)
    try {
        await current
        boundaryPlanIndex = undefined
    } finally {
        if (stateWrites.get(sessionId) === current) stateWrites.delete(sessionId)
    }

    logger.info("Saved session state to disk", { sessionId })
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    if (!sessionState.sessionId) {
        return
    }

    const state: PersistedSessionState = {
        sessionName: sessionName,
        manualMode: !!sessionState.manualMode,
        boundary: {
            activePlan: sessionState.boundary.activePlan,
            job: sessionState.boundary.job,
        },
        lastUpdated: new Date().toISOString(),
    }

    try {
        await writePersistedSessionState(sessionState.sessionId, state, logger)
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        })
        throw error
    }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    try {
        await ensureStorageDir()
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        await securePrivateFile(filePath)
        const state = JSON.parse(content) as PersistedSessionState

        if (!state || typeof state !== "object") {
            logger.warn("Invalid session state file, ignoring", { sessionId })
            return null
        }

        logger.info("Loaded session state from disk", { sessionId })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

// Every persisted boundary plan, newest first, cached until the next state
// write. Fork inheritance scans these for a content-matching prefix.
export async function loadPersistedBoundaryPlans(logger: Logger): Promise<BoundaryPlanSnapshot[]> {
    if (!existsSync(STORAGE_DIR)) return []
    boundaryPlanIndex ??= (async () => {
        const files = (await fs.readdir(STORAGE_DIR)).filter((file) => file.endsWith(".json")).sort()
        const states = await Promise.all(files.map((file) => loadSessionState(file.slice(0, -5), logger)))
        return states
            .map((state) => state?.boundary?.activePlan)
            .filter((plan): plan is BoundaryPlanSnapshot => !!plan)
            .sort((left, right) => right.createdAt - left.createdAt)
    })()
    return boundaryPlanIndex
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
    return {
        manualMode,
        boundary: {
            activePlan: null,
            job: null,
        },
        lastUpdated: new Date().toISOString(),
    }
}

export async function loadManualModeSetting(
    sessionId: string,
    logger: Logger,
): Promise<boolean | undefined> {
    const state = await loadSessionState(sessionId, logger)
    return typeof state?.manualMode === "boolean" ? state.manualMode : undefined
}

export async function saveManualModeSetting(
    sessionId: string,
    manualMode: boolean,
    logger: Logger,
): Promise<void> {
    const existing = await loadSessionState(sessionId, logger)
    const state = existing ?? emptyPersistedState(manualMode)
    state.manualMode = manualMode
    state.lastUpdated = new Date().toISOString()
    await writePersistedSessionState(sessionId, state, logger)
}
