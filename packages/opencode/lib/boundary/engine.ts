import {
    createEngine,
    resolveCompactionProfile,
    type BoundaryContextPlan,
    type BoundarySummaryJob,
    type EnginePorts,
    type PlanSnapshot,
} from "@better-compact/core"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { openCodeCodec, openCodeSpec, sessionKeyOf } from "../codec"
import { saveSessionState, type SessionState, type WithParts } from "../state"
import { boundaryRangeHash } from "./fingerprint"
import { createTranscriptStore } from "./transcripts"

// The auto transform path: replay the session's cached plan when it still
// holds, otherwise build, persist, and apply a fresh one. Mutates the
// messages array in place only when the engine changed anything, and only
// after the new plan is durably persisted (a failed save must not leave a
// transformed request without its plan). Returns the freshly built plan so
// the caller can surface it, or null when nothing new was planned.
export async function processBoundaryTransform(input: {
    state: SessionState
    logger: Logger
    config: PluginConfig
    directory: string
    messages: WithParts[]
    providerReportedTokens?: number
    summarize?: (jobs: BoundarySummaryJob[]) => Promise<Record<string, string>>
}): Promise<BoundaryContextPlan | null> {
    const ports: EnginePorts = {
        transcripts: createTranscriptStore(input.directory),
        plans: {
            load: () => input.state.boundary.activePlan,
            save: async (_sessionKey, snapshot) => {
                const previous = input.state.boundary.activePlan
                input.state.boundary.activePlan = snapshot ? stampForkIdentity(snapshot, input.messages) : null
                try {
                    await saveSessionState(input.state, input.logger)
                } catch (error) {
                    input.state.boundary.activePlan = previous
                    throw error
                }
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
        providerReportedTokens: input.providerReportedTokens,
        summarize: input.summarize,
    })
    if (result.outcome === "unchanged") return null
    const decoded = openCodeCodec.decode(result.turns, input.messages)
    input.messages.length = 0
    input.messages.push(...decoded)
    return result.outcome === "planned" ? result.plan : null
}

function stampForkIdentity(snapshot: PlanSnapshot, messages: WithParts[]) {
    if (snapshot.rawTailItemBoundary !== undefined) return snapshot
    const tailIndex = messages.findIndex((message) => message.info.id === snapshot.rawTailStartMessageId)
    if (tailIndex <= 0) return snapshot
    const prefix = messages.slice(0, tailIndex)
    return {
        ...snapshot,
        prefixFingerprint: boundaryRangeHash(prefix),
        compactedMessageCount: prefix.length,
    }
}
