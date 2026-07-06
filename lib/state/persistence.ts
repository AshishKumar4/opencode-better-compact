/**
 * State persistence module for Better Compact plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/better-compact/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"
import {
    ensurePrivateDirectory,
    securePrivateFile,
    securePrivateTree,
    writePrivateFile,
} from "../private-storage"
import { boundaryRangeHash } from "../boundary/fingerprint"
import type { WithParts } from "./types"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    manualMode?: boolean
    prune: PersistedPrune
    boundary?: {
        activePlan?: SessionState["boundary"]["activePlan"]
        job?: SessionState["boundary"]["job"]
    }
    nudges: PersistedNudges
    stats: SessionStats
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
let boundaryPlanIndex: Promise<Array<NonNullable<SessionState["boundary"]["activePlan"]>>> | undefined

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
    await ensureStorageDir()

    const filePath = getSessionFilePath(sessionId)
    const content = JSON.stringify(state, null, 2)
    const previous = stateWrites.get(sessionId) ?? Promise.resolve()
    const current = previous
        .catch(() => {})
        .then(() => writePrivateFile(filePath, content, STORAGE_DIR))
    stateWrites.set(sessionId, current)
    try {
        await current
        boundaryPlanIndex = undefined
    } finally {
        if (stateWrites.get(sessionId) === current) stateWrites.delete(sessionId)
    }

    logger.info("Saved session state to disk", {
        sessionId,
        totalTokensSaved: state.stats.totalPruneTokens,
    })
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
            prune: {
                tools: Object.fromEntries(sessionState.prune.tools),
                messages: serializePruneMessagesState(sessionState.prune.messages),
            },
            boundary: {
                activePlan: sessionState.boundary.activePlan,
                job: sessionState.boundary.job,
            },
            nudges: {
                contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
                turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
                iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
            },
            stats: sessionState.stats,
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

        const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneTools ||
            !hasPruneMessages ||
            !state.stats ||
            !hasNudgeFormat
        ) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.nudges.contextLimitAnchors = dedupedAnchors

        const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : []
        const validSoftAnchors = rawTurnNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
            logger.warn("Filtered out malformed turnNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawTurnNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.nudges.turnNudgeAnchors = dedupedSoftAnchors

        const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : []
        const validIterationAnchors = rawIterationNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
        if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
            logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawIterationNudgeAnchors.length,
                valid: validIterationAnchors.length,
            })
        }
        state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

export async function findMatchingBoundaryPlan(
    sessionId: string,
    messages: WithParts[],
    directory: string,
    logger: Logger,
): Promise<NonNullable<SessionState["boundary"]["activePlan"]> | null> {
    if (!existsSync(STORAGE_DIR)) return null
    boundaryPlanIndex ??= (async () => {
        const files = (await fs.readdir(STORAGE_DIR))
            .filter((file) => file.endsWith(".json"))
            .sort()
        const states = await Promise.all(
            files.map((file) => loadSessionState(file.slice(0, -5), logger)),
        )
        return states
            .map((state) => state?.boundary?.activePlan)
            .filter(
                (plan): plan is NonNullable<SessionState["boundary"]["activePlan"]> =>
                    !!plan,
            )
            .sort((left, right) => right.createdAt - left.createdAt)
    })()
    const plans = await boundaryPlanIndex
    const hashes = new Map<number, string>()
    for (const plan of plans) {
        const compactedCount = plan?.compactedMessageCount
        if (!plan || !compactedCount || compactedCount >= messages.length) continue
        const hash = hashes.get(compactedCount) ?? boundaryRangeHash(messages.slice(0, compactedCount))
        hashes.set(compactedCount, hash)
        if (hash !== plan.rangeHash) continue
        if (!existsSync(join(directory, plan.transcriptRelativePath))) continue
        return {
            ...plan,
            sessionId,
            rawTailStartMessageId: messages[compactedCount].info.id,
            sourceLastMessageId: messages.at(-1)?.info.id,
        }
    }
    return null
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
    return {
        manualMode,
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        boundary: {
            activePlan: null,
            job: null,
        },
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        stats: {
            pruneTokenCounter: 0,
            totalPruneTokens: 0,
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

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        if (!existsSync(STORAGE_DIR)) {
            return result
        }

        const files = await fs.readdir(STORAGE_DIR)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(STORAGE_DIR, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.tools
                        ? Object.keys(state.prune.tools).length
                        : 0
                    result.totalMessages += state.prune.messages?.byMessageId
                        ? Object.keys(state.prune.messages.byMessageId).length
                        : 0
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
