import { randomUUID } from "node:crypto"
import {
    buildPlan,
    COMPACTION_PRESETS,
    formatPrefixSummary,
    primaryToolTarget,
    type CompactionProfile,
    type Turn,
} from "@better-compact/core"
import { anthropicCodec, anthropicSpec, type WireBlock, type WireMessage } from "../anthropic/codec"
import type { TranscriptEntry } from "./transcript"

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

// Prune the heavy parts (old tool inputs/outputs, old reasoning) in place
// while preserving every conversation entry and the parentUuid chain — the
// non-destructive tier of the ladder, applied directly to the transcript.
export function stubTranscript(
    entries: TranscriptEntry[],
    options: CompactionOptions = {},
): StubOutcome | null {
    const conv = liveConversation(entries)
    if (conv.length === 0) return null
    const keepTailTokens = options.keepTailTokens ?? 25_000

    // Keep the most recent messages fully intact up to the tail budget; prune
    // older tool output and reasoning. Token-based so it holds regardless of
    // how sparse the user prompts are (tool-result turns fold into assistant
    // runs, so a user-turn floor would keep almost everything).
    const keepIntact = new Set<number>()
    let budget = 0
    for (let position = conv.length - 1; position >= 0 && budget < keepTailTokens; position--) {
        keepIntact.add(conv[position])
        budget += estimateEntryTokens(entries[conv[position]])
    }

    const preTokens = totalTokens(conv, entries)
    let stubbedTools = 0
    let strippedReasoning = 0
    for (const index of conv) {
        if (keepIntact.has(index)) continue
        const result = stubEntry(entries[index])
        stubbedTools += result.stubbedTools
        strippedReasoning += result.strippedReasoning
    }
    // A transcript pruned by an earlier run still needs its stale usage
    // anchor cleared, even when there is nothing new to stub.
    const previouslyPruned = entries.some(hasStubMarker)
    const usageReset =
        stubbedTools > 0 || strippedReasoning > 0 || previouslyPruned
            ? resetStaleUsage(entries)
            : false
    if (stubbedTools === 0 && strippedReasoning === 0 && !usageReset) return null

    return {
        entries,
        preTokens,
        postTokens: totalTokens(conv, entries),
        stubbedTools,
        strippedReasoning,
        keptTailMessages: keepIntact.size,
        totalMessages: conv.length,
    }
}

// Our stub shapes exactly, not any text that happens to mention the marker
// (e.g. a session working on this repo): a tool_result whose content IS a
// stub string, or a tool_use whose input carries our `pruned` field.
function hasStubMarker(entry: TranscriptEntry): boolean {
    const content = entry.message?.content
    if (!Array.isArray(content)) return false
    for (const block of content as WireBlock[]) {
        if (
            block.type === "tool_result" &&
            typeof block.content === "string" &&
            block.content.startsWith("[better-compact: pruned")
        ) {
            return true
        }
        if (
            block.type === "tool_use" &&
            typeof (block.input as { pruned?: unknown } | undefined)?.pruned === "string" &&
            ((block.input as { pruned: string }).pruned.startsWith("[better-compact: pruned"))
        ) {
            return true
        }
    }
    return false
}

function estimateEntryTokens(entry: TranscriptEntry): number {
    return Math.round(contentChars(entry.message?.content) / 4)
}

function totalTokens(conv: number[], entries: TranscriptEntry[]): number {
    return anthropicCodec.estimateTurns(
        anthropicCodec.encode(conv.map((index) => entries[index].message as WireMessage)),
    )
}

function stubEntry(entry: TranscriptEntry): { stubbedTools: number; strippedReasoning: number } {
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
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
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
            // Oversized tool inputs (Write/Edit file contents) dominate
            // write-heavy sessions. Keep the action record — name, id, and
            // primary target — and prune the payload.
            if (block.type === "tool_use") {
                const size = contentChars(block.input)
                if (size > STUB_MIN_CHARS) {
                    const target = primaryToolTarget(block.input)
                    kept.push({
                        ...block,
                        input: {
                            ...(target ? { target: target.display } : {}),
                            pruned: `[better-compact: pruned ${size}-char tool input — full copy in backup]`,
                        },
                    })
                    stubbedTools++
                    continue
                }
            }
            kept.push(block)
        }
        if (kept.length > 0) {
            entry.message!.content = kept
        } else if (content.length > 0) {
            entry.message!.content = [{ type: "text", text: "[better-compact: pruned]" }]
        }
        // An originally-empty content array stays empty — Claude Code wrote
        // it that way (e.g. an interrupted turn) and a marker would be false.
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
    const keepTailTokens = options.keepTailTokens ?? 25_000
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

    resetStaleUsage(entries)
    return {
        entries: [...entries, boundary, summary],
        preTokens,
        postTokens,
        keptMessages: keptUuids.length,
        droppedMessages: conv.length - keptUuids.length,
    }
}

// --- shared ---

// Claude Code seeds its context meter (and the client-side send gate) from the
// LAST API usage recorded in the transcript — it only re-tokenizes the actual
// content when no usage record exists (verified against the 2.1.211 binary's
// /context estimator). After pruning, that recorded usage describes a request
// that no longer exists, so zero its input-side counters: Claude Code then
// falls back to counting the real, pruned content.
export function resetStaleUsage(entries: TranscriptEntry[]): boolean {
    let reset = false
    // Every record, not just the last in file order: Claude Code anchors on
    // the last usage along the resolved parentUuid chain, and transcripts
    // written by competing instances interleave branches — any record can end
    // up being the anchor (observed live). Stale input-side numbers carry no
    // information after pruning; outputs are kept.
    for (const entry of entries) {
        const usage = entry.message?.usage as Record<string, unknown> | undefined
        if (!usage || typeof usage !== "object") continue
        if (usageInputSide(usage) === 0) continue
        zeroInputSide(usage)
        // Claude Code reconstructs usage from the per-iteration records at
        // load, so a top-level reset alone gets resurrected (verified live).
        if (Array.isArray(usage.iterations)) {
            for (const iteration of usage.iterations as Record<string, unknown>[]) {
                if (iteration && typeof iteration === "object") zeroInputSide(iteration)
            }
        }
        reset = true
    }
    return reset
}

function usageInputSide(usage: Record<string, unknown>): number {
    let total =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0)
    if (Array.isArray(usage.iterations)) {
        for (const iteration of usage.iterations as Record<string, unknown>[]) {
            if (iteration && typeof iteration === "object") {
                total +=
                    (Number(iteration.input_tokens) || 0) +
                    (Number(iteration.cache_creation_input_tokens) || 0) +
                    (Number(iteration.cache_read_input_tokens) || 0)
            }
        }
    }
    return total
}

function zeroInputSide(record: Record<string, unknown>): void {
    if ("input_tokens" in record) record.input_tokens = 0
    if ("cache_creation_input_tokens" in record) record.cache_creation_input_tokens = 0
    if ("cache_read_input_tokens" in record) record.cache_read_input_tokens = 0
}

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
