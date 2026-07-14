import type { SessionState, WithParts } from "./types"
import type { Logger } from "../logger"
import { loadSessionState, saveSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
} from "./utils"
export async function refreshSessionState(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): Promise<void> {
    const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
    if (lastCompactionTimestamp > state.lastCompaction) {
        state.lastCompaction = lastCompactionTimestamp
        resetOnCompaction(state)
        logger.info("Detected compaction - reset stale state", {
            timestamp: lastCompactionTimestamp,
        })

        saveSessionState(state, logger).catch((error) => {
            logger.warn("Failed to persist state reset after compaction", {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    }

    state.currentTurn = countTurns(state, messages)
}

export function createSessionState(sessionId: string | null = null): SessionState {
    return {
        sessionId,
        isSubAgent: false,
        compressPermission: undefined,
        boundary: {
            job: null,
            activePlan: null,
        },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
    }
}

export async function initializeSessionState(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    if (state.sessionId !== null && state.sessionId !== sessionId) {
        throw new Error(`Session state ${state.sessionId} cannot be initialized as ${sessionId}`)
    }

    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        return
    }

    state.boundary.activePlan = persisted.boundary?.activePlan ?? null
    state.boundary.job = persisted.boundary?.job ?? null
}
