import { createEngine, resolveCompactionProfile, type EnginePorts } from "@better-compact/core"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { openCodeCodec, openCodeSpec, sessionKeyOf } from "../codec"
import { saveSessionState, type SessionState, type WithParts } from "../state"
import { createTranscriptStore } from "./transcripts"

// The auto transform path: replay the session's cached plan when it still
// holds, otherwise build, persist, and apply a fresh one. Mutates the
// messages array in place only when the engine changed anything.
export async function processBoundaryTransform(input: {
    state: SessionState
    logger: Logger
    config: PluginConfig
    directory: string
    messages: WithParts[]
}): Promise<void> {
    const ports: EnginePorts = {
        transcripts: createTranscriptStore(input.directory),
        plans: {
            load: () => input.state.boundary.activePlan,
            save: async (_sessionKey, snapshot) => {
                input.state.boundary.activePlan = snapshot
                await saveSessionState(input.state, input.logger)
            },
        },
        logger: input.logger,
    }
    const profile = resolveCompactionProfile(input.config)
    const engine = createEngine(openCodeSpec, ports)
    const result = await engine.process({
        sessionKey: sessionKeyOf(input.messages),
        turns: openCodeCodec.encode(input.messages),
        contextLimit: input.state.modelContextLimit,
        triggerRatio: profile.triggerPercent / 100,
        targetRatio: profile.targetPercent / 100,
        recentToolResultBudgetTokens: profile.recentToolTokens,
    })
    if (result.outcome === "unchanged") return
    const decoded = openCodeCodec.decode(result.turns, input.messages)
    input.messages.length = 0
    input.messages.push(...decoded)
}
