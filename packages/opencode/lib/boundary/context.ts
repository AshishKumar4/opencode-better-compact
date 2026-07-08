import {
    buildPlan,
    replayPlanSnapshot,
    toPlanSnapshot,
    transformTurns,
    writeTranscript,
    type BoundaryContextOptions,
    type BoundaryContextPlan,
    type PlanSnapshot,
} from "@better-compact/core"
import type { Logger } from "../logger"
import { openCodeCodec, openCodeSpec, sessionKeyOf } from "../codec"
import type { SessionState, WithParts } from "../state"
import { createTranscriptStore, transcriptCitablePath } from "./transcripts"

export type {
    BoundaryContextOptions,
    BoundaryContextPlan,
    BoundaryStageName,
    BoundaryStageReport,
    BoundarySummaryJob,
    BoundaryTranscriptArtifact,
} from "@better-compact/core"

export function buildBoundaryContextPlan(
    messages: WithParts[],
    options: BoundaryContextOptions = {},
): BoundaryContextPlan | null {
    return buildPlan(
        openCodeCodec.encode(messages),
        { ...options, sessionKey: sessionKeyOf(messages), citablePath: transcriptCitablePath },
        openCodeSpec,
    )
}

export function applyBoundaryContextPlan(messages: WithParts[], plan: BoundaryContextPlan): void {
    const transformed = transformTurns(openCodeCodec.encode(messages), plan.rawTailStartIndex, plan, openCodeSpec)
    replaceMessages(messages, openCodeCodec.decode(transformed, messages))
}

export function applyBoundaryPlanSnapshot(messages: WithParts[], snapshot: PlanSnapshot): boolean {
    const replayed = replayPlanSnapshot(openCodeCodec.encode(messages), snapshot, openCodeSpec)
    if (!replayed) return false
    replaceMessages(messages, openCodeCodec.decode(replayed, messages))
    return true
}

export function storeBoundaryPlan(state: SessionState, plan: BoundaryContextPlan): void {
    state.boundary.activePlan = toPlanSnapshot(plan)
}

export async function writeBoundaryTranscript(
    directory: string,
    plan: BoundaryContextPlan,
    logger: Logger,
): Promise<void> {
    await writeTranscript(plan, { transcripts: createTranscriptStore(directory), logger, codec: openCodeCodec })
}

function replaceMessages(messages: WithParts[], next: WithParts[]): void {
    messages.length = 0
    messages.push(...next)
}
