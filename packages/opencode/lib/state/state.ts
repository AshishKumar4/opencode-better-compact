import type { SessionState, WithParts } from "./types"
import type { Logger } from "../logger"
import { loadManualModeSetting, loadSessionState, saveSessionState } from "./persistence"
import {
    isSubAgentSession,
    findLastCompactionTimestamp,
    countTurns,
    resetOnCompaction,
} from "./utils"
import { getLastUserMessage } from "../messages/query"

export const checkSession = async (
    client: any,
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    manualModeDefault: boolean,
): Promise<void> => {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const lastSessionId = lastUserMessage.info.sessionID

    if (state.sessionId === null || state.sessionId !== lastSessionId) {
        logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`)
        try {
            await ensureSessionInitialized(
                client,
                state,
                lastSessionId,
                logger,
                messages,
                manualModeDefault,
            )
        } catch (err: any) {
            logger.error("Failed to initialize session state", { error: err.message })
        }
    }

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
    await refreshManualMode(state, lastSessionId, logger, manualModeDefault)
}

export function createSessionState(): SessionState {
    return {
        sessionId: null,
        isSubAgent: false,
        manualMode: false,
        compressPermission: undefined,
        boundary: {
            scratchSessionIds: new Set<string>(),
            runningSessionIds: new Set<string>(),
            job: null,
            activePlan: null,
        },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
    }
}

export function resetSessionState(state: SessionState): void {
    state.sessionId = null
    state.isSubAgent = false
    state.manualMode = false
    state.compressPermission = undefined
    state.boundary = {
        scratchSessionIds: new Set<string>(),
        // Keep the instance so an in-flight run still releases its guard.
        runningSessionIds: state.boundary.runningSessionIds,
        job: null,
        activePlan: null,
    }
    state.lastCompaction = 0
    state.currentTurn = 0
    state.modelContextLimit = undefined
}

export async function ensureSessionInitialized(
    client: any,
    state: SessionState,
    sessionId: string,
    logger: Logger,
    messages: WithParts[],
    manualModeEnabled: boolean,
): Promise<void> {
    if (state.sessionId === sessionId) {
        return
    }

    // logger.info("session ID = " + sessionId)
    // logger.info("Initializing session state", { sessionId: sessionId })

    resetSessionState(state)
    state.manualMode = manualModeEnabled ? "active" : false
    state.sessionId = sessionId

    const isSubAgent = await isSubAgentSession(client, sessionId)
    state.isSubAgent = isSubAgent
    // logger.info("isSubAgent = " + isSubAgent)

    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.currentTurn = countTurns(state, messages)

    const persisted = await loadSessionState(sessionId, logger)
    if (persisted === null) {
        return
    }

    if (typeof persisted.manualMode === "boolean") {
        state.manualMode = persisted.manualMode ? "active" : false
    }

    state.boundary.activePlan = persisted.boundary?.activePlan ?? null
    state.boundary.job = persisted.boundary?.job ?? null
}

export async function refreshManualMode(
    state: SessionState,
    sessionId: string,
    logger: Logger,
    manualModeDefault: boolean,
): Promise<void> {
    if (state.manualMode === "compress-pending") {
        return
    }

    const persisted = await loadManualModeSetting(sessionId, logger)
    const enabled = persisted ?? manualModeDefault
    state.manualMode = enabled ? "active" : false
}
