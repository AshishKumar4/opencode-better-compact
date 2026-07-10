import type { Logger } from "../logger"
import type { WithParts, SessionState } from "./types"
import { createSessionState, initializeSessionState, refreshSessionState } from "./state"

interface SessionEntry {
    state: SessionState
    initialized: boolean
    initialization?: Promise<void>
    compaction?: Promise<void>
}

export interface RuntimeState {
    get(sessionId: string): SessionState
    peek(sessionId: string): SessionState | undefined
    prepare(
        sessionId: string,
        messages: WithParts[],
        manualModeDefault: boolean,
    ): Promise<SessionState>
    evict(sessionId: string): void
    setModelLimit(providerId: string, modelId: string, limit: number): void
    getModelLimit(providerId: string, modelId: string): number | undefined
    resolveModelLimit(providerId: string, modelId: string): Promise<number | undefined>
    trackScratch(sessionId: string): () => void
    isScratch(sessionId: string): boolean
    startCompaction(sessionId: string, operation: () => Promise<void>): boolean
    activeCompaction(sessionId: string): Promise<void> | undefined
}

export function createRuntimeState(client: any, logger: Logger): RuntimeState {
    const sessions = new Map<string, SessionEntry>()
    const modelLimits = new Map<string, number>()
    const modelLimitRequests = new Map<string, Promise<number | undefined>>()
    const scratchSessions = new Set<string>()

    const entry = (sessionId: string): SessionEntry => {
        const existing = sessions.get(sessionId)
        if (existing) return existing
        const created = {
            state: createSessionState(sessionId),
            initialized: false,
        }
        sessions.set(sessionId, created)
        return created
    }

    return {
        get(sessionId) {
            return entry(sessionId).state
        },
        peek(sessionId) {
            return sessions.get(sessionId)?.state
        },
        async prepare(sessionId, messages, manualModeDefault) {
            const current = entry(sessionId)
            if (!current.initialized) {
                if (!current.initialization) {
                    const initialization = initializeSessionState(
                        client,
                        current.state,
                        sessionId,
                        logger,
                        messages,
                        manualModeDefault,
                    ).then(() => {
                        current.initialized = true
                    })
                    current.initialization = initialization
                    void initialization.catch(() => {
                        if (current.initialization === initialization) {
                            current.initialization = undefined
                        }
                    })
                }
                await current.initialization
            } else {
                await refreshSessionState(
                    current.state,
                    messages,
                    sessionId,
                    logger,
                    manualModeDefault,
                )
            }
            return current.state
        },
        evict(sessionId) {
            sessions.delete(sessionId)
        },
        setModelLimit(providerId, modelId, limit) {
            if (Number.isFinite(limit) && limit > 0) {
                modelLimits.set(`${providerId}/${modelId}`, limit)
            }
        },
        getModelLimit(providerId, modelId) {
            return modelLimits.get(`${providerId}/${modelId}`)
        },
        async resolveModelLimit(providerId, modelId) {
            const key = `${providerId}/${modelId}`
            const cached = modelLimits.get(key)
            if (cached) return cached
            const existing = modelLimitRequests.get(key)
            if (existing) return existing
            const request = (async () => {
                try {
                    const response = await client.provider.list()
                    const payload = response?.data ?? response
                    const providers = Array.isArray(payload)
                        ? payload
                        : Array.isArray(payload?.all)
                          ? payload.all
                          : Array.isArray(payload?.providers)
                            ? payload.providers
                            : []
                    const provider = providers.find((item: any) => item?.id === providerId)
                    const model = provider?.models?.[modelId]
                    const limit = model?.limit?.context
                    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
                        modelLimits.set(key, limit)
                        return limit
                    }
                } catch (error) {
                    logger.warn("Failed to resolve model context limit", {
                        providerId,
                        modelId,
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
                return undefined
            })().finally(() => {
                if (modelLimitRequests.get(key) === request) modelLimitRequests.delete(key)
            })
            modelLimitRequests.set(key, request)
            return request
        },
        trackScratch(sessionId) {
            scratchSessions.add(sessionId)
            return () => scratchSessions.delete(sessionId)
        },
        isScratch(sessionId) {
            return scratchSessions.has(sessionId)
        },
        startCompaction(sessionId, operation) {
            const current = entry(sessionId)
            if (current.compaction) return false
            const tracked = Promise.resolve()
                .then(operation)
                .finally(() => {
                    if (current.compaction === tracked) current.compaction = undefined
                })
            current.compaction = tracked
            return true
        },
        activeCompaction(sessionId) {
            return sessions.get(sessionId)?.compaction
        },
    }
}
