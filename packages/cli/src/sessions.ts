const MAX_TRACKED_SESSIONS = 256

export interface SessionRuntime {
    // Usage the upstream reported for this session's last unpruned request;
    // fed to the engine as providerReportedTokens so the overhead offset is
    // measured against a request whose raw estimate covers the same turns.
    reportedTokens?: number
    // OpenAI model-window observations are session-local because gateways can
    // expose different aliases or deployments under the same model name.
    calibratedContextLimits: Map<string, number>
    // One background summary upgrade per session at a time.
    summarizing: boolean
}

export interface SessionTracker {
    runtime(sessionKey: string): SessionRuntime
    recordUsage(
        sessionKey: string,
        tokens: number,
        requestWasPruned: boolean,
        calibration?: { model: string; assumedLimit: number },
    ): void
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
            const runtime: SessionRuntime = {
                calibratedContextLimits: new Map(),
                summarizing: false,
            }
            sessions.set(sessionKey, runtime)
            for (const key of sessions.keys()) {
                if (sessions.size <= MAX_TRACKED_SESSIONS) break
                sessions.delete(key)
            }
            return runtime
        },
        recordUsage(sessionKey, tokens, requestWasPruned, calibration) {
            const runtime = this.runtime(sessionKey)
            runtime.reportedTokens = requestWasPruned ? undefined : tokens
            if (calibration && tokens > calibration.assumedLimit) {
                const current = runtime.calibratedContextLimits.get(calibration.model) ?? 0
                runtime.calibratedContextLimits.set(calibration.model, Math.max(current, tokens))
            }
        },
    }
}
