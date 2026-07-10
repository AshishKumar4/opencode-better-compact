const MAX_TRACKED_SESSIONS = 256

export interface SessionRuntime {
    // Usage the upstream reported for this session's last unpruned request;
    // fed to the engine as providerReportedTokens so the overhead offset is
    // measured against a request whose raw estimate covers the same turns.
    reportedTokens?: number
    // One background summary upgrade per session at a time.
    summarizing: boolean
}

export interface SessionTracker {
    runtime(sessionKey: string): SessionRuntime
    recordUsage(sessionKey: string, tokens: number, requestWasPruned: boolean): void
}

export function createSessionTracker(): SessionTracker {
    const sessions = new Map<string, SessionRuntime>()
    return {
        runtime(sessionKey) {
            const existing = sessions.get(sessionKey)
            if (existing) {
                // Refresh recency for the size cap below.
                sessions.delete(sessionKey)
                sessions.set(sessionKey, existing)
                return existing
            }
            const runtime: SessionRuntime = { summarizing: false }
            sessions.set(sessionKey, runtime)
            for (const key of sessions.keys()) {
                if (sessions.size <= MAX_TRACKED_SESSIONS) break
                sessions.delete(key)
            }
            return runtime
        },
        recordUsage(sessionKey, tokens, requestWasPruned) {
            const runtime = this.runtime(sessionKey)
            runtime.reportedTokens = requestWasPruned ? undefined : tokens
        },
    }
}
