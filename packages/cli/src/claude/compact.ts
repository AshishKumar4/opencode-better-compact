import { randomUUID } from "node:crypto"
import {
    buildPlan,
    COMPACTION_PRESETS,
    findRawTailStartIndex,
    findRecentToolCallTail,
    formatPrefixSummary,
    type CompactionProfile,
    type Turn,
} from "@better-compact/core"
import {
    anthropicCodec,
    anthropicSpec,
    claudeCodeConventions,
    type WireBlock,
    type WireMessage,
} from "../anthropic/codec"
import type { TranscriptEntry } from "./transcript"

// The recent tail kept fully intact and the floor for the ladder tail scan.
const MIN_TAIL_MESSAGES = 3
const MIN_TAIL_USER_TURNS = 2
// Outputs smaller than this aren't worth a stub.
const STUB_MIN_CHARS = 200

export interface CompactionOptions {
    keepTailTokens?: number
    profile?: CompactionProfile
    now?: string
}

// --- default: stub tool output + strip reasoning, keep every message ---

export interface StubOutcome {
    entries: TranscriptEntry[]
    preTokens: number
    postTokens: number
    stubbedTools: number
    strippedReasoning: number
    keptTailMessages: number
    totalMessages: number
}

// Prune the heavy parts (old tool outputs, old reasoning) in place while
// preserving every conversation entry and the parentUuid chain — the
// non-destructive tier of the ladder. Which turns are "recent" and which tool
// calls to spare comes from the engine's own tail selectors, so this stays one
// algorithm with the other harnesses.
export function stubTranscript(
    entries: TranscriptEntry[],
    options: CompactionOptions = {},
): StubOutcome | null {
    const conv = liveConversation(entries)
    if (conv.length === 0) return null

    const messages = conv.map((index) => entries[index].message as WireMessage)
    const turns = anthropicCodec.encode(messages)
    const keepTailTokens = options.keepTailTokens ?? 25_000

    const rawTailStart = findRawTailStartIndex(turns, MIN_TAIL_MESSAGES, MIN_TAIL_USER_TURNS)
    const preserved = findRecentToolCallTail(
        turns,
        keepTailTokens,
        anthropicCodec,
        claudeCodeConventions,
    )
    // Messages folded into the turns before the tail are the "old" ones.
    const oldMessages = new Set<WireMessage>()
    for (let index = 0; index < rawTailStart; index++) {
        for (const message of (turns[index].handle as WireMessage[] | undefined) ?? []) {
            oldMessages.add(message)
        }
    }

    const preTokens = anthropicCodec.estimateTurns(turns)
    let stubbedTools = 0
    let strippedReasoning = 0
    for (const index of conv) {
        if (!oldMessages.has(entries[index].message as WireMessage)) continue
        const result = stubEntry(entries[index], preserved)
        stubbedTools += result.stubbedTools
        strippedReasoning += result.strippedReasoning
    }
    if (stubbedTools === 0 && strippedReasoning === 0) return null

    const postTokens = anthropicCodec.estimateTurns(
        anthropicCodec.encode(conv.map((index) => entries[index].message as WireMessage)),
    )
    return {
        entries,
        preTokens,
        postTokens,
        stubbedTools,
        strippedReasoning,
        keptTailMessages: conv.length - oldMessages.size,
        totalMessages: conv.length,
    }
}

function stubEntry(
    entry: TranscriptEntry,
    preserved: ReadonlySet<string>,
): { stubbedTools: number; strippedReasoning: number } {
    let stubbedTools = 0
    let strippedReasoning = 0
    const content = entry.message?.content
    if (Array.isArray(content)) {
        const kept: WireBlock[] = []
        for (const block of content as WireBlock[]) {
            if (block.type === "thinking" || block.type === "redacted_thinking") {
                strippedReasoning++
                continue
            }
            if (
                block.type === "tool_result" &&
                typeof block.tool_use_id === "string" &&
                !preserved.has(block.tool_use_id)
            ) {
                const size = contentChars(block.content)
                if (size > STUB_MIN_CHARS) {
                    kept.push({
                        ...block,
                        content: `[better-compact: pruned ${size}-char tool output — full copy in backup]`,
                    })
                    stubbedTools++
                    continue
                }
            }
            kept.push(block)
        }
        entry.message!.content =
            kept.length > 0 ? kept : [{ type: "text", text: "[better-compact: pruned]" }]
    }
    // The mirror field Claude Code stores for display; shrink it in lockstep.
    if (entry.toolUseResult && contentChars(entry.toolUseResult) > STUB_MIN_CHARS) {
        entry.toolUseResult = { pruned: true }
    }
    return { stubbedTools, strippedReasoning }
}

// --- opt-in --aggressive: collapse the prefix into a native /compact summary ---

const REFERENCE_PREAMBLE =
    "This session is being continued from a previous conversation that ran out of context. " +
    "The summary below covers the earlier portion of the conversation."

export interface SummaryOutcome {
    entries: TranscriptEntry[]
    preTokens: number
    postTokens: number
    keptMessages: number
    droppedMessages: number
}

// Reproduces Claude Code's own /compact (append boundary + summary, sever the
// chain). Reserve for sessions so large that stubbing cannot get under the
// limit — it drops old turns from view.
export function summarizeTranscript(
    entries: TranscriptEntry[],
    options: CompactionOptions = {},
): SummaryOutcome | null {
    const profile = options.profile ?? COMPACTION_PRESETS.light
    const conv = liveConversation(entries)
    if (conv.length === 0) return null

    const messages = conv.map((index) => entries[index].message as WireMessage)
    const uuidOf = new Map<WireMessage, string>()
    conv.forEach((index, position) => {
        const uuid = entries[index].uuid
        if (uuid) uuidOf.set(messages[position], uuid)
    })

    const turns = anthropicCodec.encode(messages)
    const keepTailTokens = options.keepTailTokens ?? 20_000
    const contextLimit = Math.round(keepTailTokens / (profile.targetPercent / 100))
    const plan = buildPlan(
        turns,
        {
            contextLimit,
            triggerRatio: profile.triggerPercent / 100,
            targetRatio: profile.targetPercent / 100,
            recentToolResultBudgetTokens: Math.min(profile.recentToolTokens, keepTailTokens),
            force: true,
            sessionKey: entries.find((e) => e.uuid)?.uuid ?? "claude-session",
            citablePath: () => "",
        },
        anthropicSpec,
    )
    if (!plan || plan.rawTailStartIndex <= 0) return null

    const prefixTurns = turns.slice(0, plan.rawTailStartIndex)
    const tailTurns = turns.slice(plan.rawTailStartIndex)
    if (prefixTurns.length === 0) return null

    const summaryBody = formatPrefixSummary(prefixTurns).trim()
    const keptUuids = collectUuids(tailTurns, uuidOf)
    if (keptUuids.length === 0) return null

    const preTokens = anthropicCodec.estimateTurns(turns)
    const postTokens =
        anthropicCodec.estimateTurns(tailTurns) + Math.round(summaryBody.length / 4)
    const template = templateFields(entries)
    const now = options.now ?? new Date().toISOString()
    const summaryUuid = randomUUID()
    const boundaryUuid = randomUUID()
    const tailUuid = keptUuids[keptUuids.length - 1]

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
            preservedSegment: { headUuid: keptUuids[0], anchorUuid: summaryUuid, tailUuid },
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
        message: { role: "user", content: `${REFERENCE_PREAMBLE}\n\nSummary:\n${summaryBody}` },
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
        droppedMessages: conv.length - keptUuids.length,
    }
}

// --- shared ---

// Absolute indices of the conversation entries after the most recent
// compaction boundary (earlier history is already summarized/severed).
function liveConversation(entries: TranscriptEntry[]): number[] {
    const lastBoundary = lastIndex(entries, (e) => e.subtype === "compact_boundary")
    const start = lastBoundary >= 0 ? lastBoundary + 1 : 0
    const indices: number[] = []
    for (let index = start; index < entries.length; index++) {
        if (isConversationEntry(entries[index])) indices.push(index)
    }
    return indices
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

function collectUuids(turns: Turn[], uuidOf: Map<WireMessage, string>): string[] {
    const uuids: string[] = []
    for (const turn of turns) {
        for (const message of (turn.handle as WireMessage[] | undefined) ?? []) {
            const uuid = uuidOf.get(message)
            if (uuid) uuids.push(uuid)
        }
    }
    return uuids
}

function contentChars(content: unknown): number {
    if (typeof content === "string") return content.length
    return JSON.stringify(content ?? "").length
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

function lastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
    for (let index = items.length - 1; index >= 0; index--) {
        if (predicate(items[index])) return index
    }
    return -1
}
