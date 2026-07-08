import { createEngine, type EnginePorts } from "@better-compact/core"
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
    const engine = createEngine(openCodeSpec, ports)
    const result = await engine.process({
        sessionKey: sessionKeyOf(input.messages),
        turns: openCodeCodec.encode(input.messages),
        contextLimit: input.state.modelContextLimit,
    })
    if (result.outcome === "unchanged") return
    const decoded = openCodeCodec.decode(result.turns, input.messages)
    input.messages.length = 0
    input.messages.push(...decoded)
}
