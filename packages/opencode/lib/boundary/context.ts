import { existsSync } from "node:fs"
import { join } from "node:path"
import {
    buildPlan,
    rangeHash,
    replayPlanSnapshot,
    toPlanSnapshot,
    transformTurns,
    writeTranscript,
    type BoundaryContextOptions,
    type BoundaryContextPlan,
    type ReplayOptions,
} from "@better-compact/core"
import type { Logger } from "../logger"
import { openCodeCodec, openCodeSpec, sessionKeyOf } from "../codec"
import { loadPersistedBoundaryPlans, type BoundaryPlanSnapshot, type SessionState, type WithParts } from "../state"
import { boundaryRangeHash } from "./fingerprint"
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

export function applyBoundaryPlanSnapshot(
    messages: WithParts[],
    snapshot: BoundaryPlanSnapshot,
    options: ReplayOptions = {},
): boolean {
    const replayed = replayPlanSnapshot(openCodeCodec.encode(messages), snapshot, openCodeSpec, options)
    if (!replayed) return false
    replaceMessages(messages, openCodeCodec.decode(replayed, messages))
    return true
}

// Core snapshots carry the id-based rangeHash; the OpenCode layer adds a
// content-addressed prefix identity so forked sessions can inherit the plan.
export function toBoundaryPlanSnapshot(plan: BoundaryContextPlan, messages: WithParts[]): BoundaryPlanSnapshot {
    if (plan.rawTailItemBoundary !== undefined) return toPlanSnapshot(plan)
    const prefix = messages.slice(0, plan.rawTailStartIndex)
    return {
        ...toPlanSnapshot(plan),
        prefixFingerprint: boundaryRangeHash(prefix),
        compactedMessageCount: prefix.length,
    }
}

export function storeBoundaryPlan(state: SessionState, plan: BoundaryContextPlan, messages: WithParts[]): void {
    state.boundary.activePlan = toBoundaryPlanSnapshot(plan, messages)
}

// A forked session copies message content but mints new ids. Match this
// session's prefix against persisted plans by content fingerprint and rebase
// the winning snapshot onto the fork's ids so core replay validation holds.
export async function findMatchingBoundaryPlan(
    sessionId: string,
    messages: WithParts[],
    directory: string,
    logger: Logger,
): Promise<BoundaryPlanSnapshot | null> {
    const plans = await loadPersistedBoundaryPlans(logger)
    const hashes = new Map<number, string>()
    for (const plan of plans) {
        if (plan.rawTailItemBoundary !== undefined) continue
        const compactedCount = plan.compactedMessageCount
        if (!plan.prefixFingerprint || !compactedCount || compactedCount >= messages.length) continue
        const hash = hashes.get(compactedCount) ?? boundaryRangeHash(messages.slice(0, compactedCount))
        hashes.set(compactedCount, hash)
        if (hash !== plan.prefixFingerprint) continue
        if (!existsSync(join(directory, plan.transcriptRelativePath))) continue
        return {
            ...plan,
            sessionId,
            rawTailStartMessageId: messages[compactedCount].info.id,
            rangeHash: rangeHash(openCodeCodec.encode(messages.slice(0, compactedCount))),
        }
    }
    return null
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
