import { randomUUID } from "node:crypto"
import {
    buildPlan,
    COMPACTION_PRESETS,
    formatPrefixSummary,
    type CompactionProfile,
    type Turn,
} from "@better-compact/core"
import { anthropicCodec, anthropicSpec, type WireMessage } from "../anthropic/codec"
import type { TranscriptEntry } from "./transcript"

const REFERENCE_PREAMBLE =
    "This session is being continued from a previous conversation that ran out of context. " +
    "The summary below covers the earlier portion of the conversation."

export interface CompactionOptions {
    // Token budget kept verbatim as the recent tail; the rest is summarized.
    keepTailTokens?: number
    profile?: CompactionProfile
    now?: string
}

export interface CompactionOutcome {
    entries: TranscriptEntry[]
    preTokens: number
    postTokens: number
    keptMessages: number
    droppedMessages: number
}

// Returns the compacted entry list (original entries unchanged + two appended
// markers), or null when there is nothing worth compacting.
export function compactTranscript(
    entries: TranscriptEntry[],
    options: CompactionOptions = {},
): CompactionOutcome | null {
    const profile = options.profile ?? COMPACTION_PRESETS.light
    // Only the live conversation (after the most recent compaction boundary)
    // participates; earlier history is already summarized and severed.
    const lastBoundary = lastIndex(entries, (e) => e.subtype === "compact_boundary")
    const live = lastBoundary >= 0 ? entries.slice(lastBoundary + 1) : entries

    const conversation = live.filter(isConversationEntry)
    if (conversation.length === 0) return null

    const messages: WireMessage[] = []
    const uuidOf = new Map<WireMessage, string>()
    for (const entry of conversation) {
        const message = entry.message as WireMessage
        messages.push(message)
        if (entry.uuid) uuidOf.set(message, entry.uuid)
    }

    const turns = anthropicCodec.encode(messages)
    // targetRatio * contextLimit sets the raw-tail budget; derive the limit
    // from the tail budget we want to keep so the knob is a token count. The
    // char/4 estimator undercounts tool-heavy Claude Code turns, so the real
    // preserved tail runs larger than this figure — keep the default modest.
    const keepTailTokens = options.keepTailTokens ?? 20_000
    const contextLimit = Math.round(keepTailTokens / (profile.targetPercent / 100))
    const plan = buildPlan(
        turns,
        {
            contextLimit,
            triggerRatio: profile.triggerPercent / 100,
            targetRatio: profile.targetPercent / 100,
            // Cap recent tool-result preservation to the tail budget so a few
            // large recent outputs don't dominate the kept context.
            recentToolResultBudgetTokens: Math.min(profile.recentToolTokens, keepTailTokens),
            force: true,
            sessionKey: firstUuid(conversation) ?? "claude-session",
            citablePath: () => "",
        },
        anthropicSpec,
    )
    if (!plan || plan.rawTailStartIndex <= 0) return null

    const prefixTurns = turns.slice(0, plan.rawTailStartIndex)
    const tailTurns = turns.slice(plan.rawTailStartIndex)
    if (prefixTurns.length === 0) return null

    const summaryBody = formatPrefixSummary(prefixTurns).trim()
    const keptUuids = tailUuids(tailTurns, uuidOf)
    if (keptUuids.length === 0) return null

    const tailUuid = keptUuids[keptUuids.length - 1]
    const headUuid = keptUuids[0]
    const preTokens = anthropicCodec.estimateTurns(turns)
    const postTokens =
        anthropicCodec.estimateTurns(tailTurns) + Math.round(summaryBody.length / 4)

    const template = templateFields(entries)
    const now = options.now ?? new Date().toISOString()
    const summaryUuid = randomUUID()
    const boundaryUuid = randomUUID()

    const boundary: TranscriptEntry = {
        ...template,
        parentUuid: null,
        logicalParentUuid: tailUuid,
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        level: "info",
        compactMetadata: {
            trigger: "manual",
            preTokens,
            postTokens,
            preservedSegment: { headUuid, anchorUuid: summaryUuid, tailUuid },
            preservedMessages: { anchorUuid: summaryUuid, uuids: keptUuids, allUuids: keptUuids },
        },
        uuid: boundaryUuid,
        timestamp: now,
    }
    const summary: TranscriptEntry = {
        ...template,
        parentUuid: boundaryUuid,
        promptId: randomUUID(),
        type: "user",
        message: {
            role: "user",
            content: `${REFERENCE_PREAMBLE}\n\nSummary:\n${summaryBody}`,
        },
        isVisibleInTranscriptOnly: true,
        isCompactSummary: true,
        uuid: summaryUuid,
        session_id: randomUUID(),
        timestamp: now,
    }

    return {
        entries: [...entries, boundary, summary],
        preTokens,
        postTokens,
        keptMessages: keptUuids.length,
        droppedMessages: conversation.length - keptUuids.length,
    }
}

function isConversationEntry(entry: TranscriptEntry): boolean {
    return (
        (entry.type === "user" || entry.type === "assistant") &&
        !entry.isCompactSummary &&
        typeof entry.message === "object" &&
        entry.message !== null &&
        entry.message.content !== undefined
    )
}

// Entry uuids of every native message folded into the kept tail turns. A
// turn's handle is the WireMessage[] it was encoded from — the same objects
// we mapped to their source entry uuids.
function tailUuids(tailTurns: Turn[], uuidOf: Map<WireMessage, string>): string[] {
    const uuids: string[] = []
    for (const turn of tailTurns) {
        const group = turn.handle as WireMessage[] | undefined
        if (!group) continue
        for (const message of group) {
            const uuid = uuidOf.get(message)
            if (uuid) uuids.push(uuid)
        }
    }
    return uuids
}

function templateFields(entries: TranscriptEntry[]): Partial<TranscriptEntry> {
    const source = entries.find((e) => e.cwd && e.sessionId && e.version) ?? entries[0] ?? {}
    return {
        cwd: source.cwd,
        sessionId: source.sessionId,
        version: source.version,
        gitBranch: source.gitBranch,
        userType: "external",
        entrypoint: "cli",
        isSidechain: false,
    }
}

function firstUuid(entries: TranscriptEntry[]): string | undefined {
    return entries.find((e) => e.uuid)?.uuid
}

function lastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
    for (let index = items.length - 1; index >= 0; index--) {
        if (predicate(items[index])) return index
    }
    return -1
}
