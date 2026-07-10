import { countTokens, estimateTurns, truncate, type Estimator } from "./estimate"
import { assistantRunKey, syntheticTextKey } from "./identity"
import type { CodecOps, Conventions, Item, Turn } from "./ir"
import type { BoundaryStageName, BoundarySummaryJob } from "./plan"
import { formatAssistantSummaryPrompt } from "./summarize"

const ASSISTANT_TEXT_PREVIEW_CHARS = 1_200

export interface StageMutationResult {
    changedTurns: Set<string>
    changedItems: number
}

export interface StageContext {
    codec: CodecOps
    conventions: Conventions
    estimator: Estimator
    rawTailStartIndex: number
    transcriptRelativePath: string
    preservedToolCallIds: ReadonlySet<string>
    // Latest todo across the original compacted range; preserved tool items
    // folded into a collapsed run still surface their todo state.
    latestTodoCallId: string | null
    assistantSummaries: Record<string, string>
    assistantSummaryKeys: Set<string>
    summaryJobs: BoundarySummaryJob[]
    // Planning selects runs to meet the target; replay reuses recorded keys.
    selectRuns: boolean
    targetTokens: number
    referenceTokens: number
}

export interface Stage {
    name: BoundaryStageName
    label: string
    // Skills and tools-old always run; later stages only while the
    // projected context is still above the trigger.
    always?: boolean
    run(working: Turn[], ctx: StageContext): StageMutationResult
}

export const skillsStage: Stage = {
    name: "skills",
    label: "Pruned loaded skills",
    always: true,
    run: (working, ctx) =>
        stripAssistantItems(working, ctx.rawTailStartIndex, (item) => ctx.conventions.isSkillItem?.(item) ?? false),
}

export const toolsOldStage: Stage = {
    name: "tools-old",
    label: "Pruned old tool calls/results",
    always: true,
    run: (working, ctx) => stripToolItems(working, ctx, ctx.preservedToolCallIds),
}

export const reasoningStage: Stage = {
    name: "reasoning",
    label: "Pruned thinking tokens",
    run: (working, ctx) => stripAssistantItems(working, ctx.rawTailStartIndex, (item) => item.kind === "reasoning"),
}

export const toolsRemainingStage: Stage = {
    name: "tools-remaining",
    label: "Pruned remaining tool calls/results",
    run: (working, ctx) => stripToolItems(working, ctx, new Set()),
}

export const assistantRunsStage: Stage = {
    name: "assistant-runs",
    label: "Summarized assistant turns",
    run: (working, ctx) => compactAssistantRuns(working, ctx),
}

export function findRawTailStartIndex(turns: Turn[], minTurns: number, minUserTurns: number): number {
    let userTurns = 0
    for (let index = turns.length - 1; index >= 0; index--) {
        if (turns[index].role !== "user" || turns[index].ephemeral) continue
        userTurns++
        if (userTurns >= minUserTurns) return index
    }
    return Math.max(0, turns.length - Math.min(minTurns, turns.length))
}

export function findRecentToolCallTail(
    turns: Turn[],
    budgetTokens: number,
    codec: CodecOps,
    conventions: Conventions,
): Set<string> {
    const preserved = new Set<string>()
    if (budgetTokens <= 0) return preserved

    let used = 0
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
        const turn = turns[turnIndex]
        if (turn.role !== "assistant") continue
        for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex--) {
            const item = turn.items[itemIndex]
            if (item.kind !== "tool") continue
            if (conventions.isSkillItem?.(item)) continue
            if (!item.callId || preserved.has(item.callId)) continue

            const cost = Math.max(1, Math.round(codec.estimateItem(item)))
            if (used >= budgetTokens) return preserved
            if (preserved.size > 0 && used + cost > budgetTokens) return preserved
            preserved.add(item.callId)
            used += cost
        }
    }
    return preserved
}

export function findLatestTodoCallId(turns: Turn[], conventions: Conventions): string | null {
    const todo = conventions.todo
    if (!todo) return null
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
        const turn = turns[turnIndex]
        for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex--) {
            const item = turn.items[itemIndex]
            if (item.kind === "tool" && todo.isTodoItem(item)) return item.callId
        }
    }
    return null
}

export function transformCompactedPrefix(turns: Turn[], ctx: StageContext): Turn[] {
    const result: Turn[] = []
    let assistantGroup: Turn[] = []

    const flushAssistantGroup = () => {
        if (assistantGroup.length === 0) return
        if (!ctx.assistantSummaryKeys.has(assistantRunKey(assistantGroup))) {
            result.push(...assistantGroup)
        } else {
            result.push(collapseAssistantRun(assistantGroup, ctx))
        }
        assistantGroup = []
    }

    for (const turn of turns) {
        if (turn.role === "user") {
            flushAssistantGroup()
            result.push(turn)
            continue
        }
        assistantGroup.push(turn)
    }
    flushAssistantGroup()
    return result
}

export function turnText(turn: Turn): string {
    return turn.items
        .filter(
            (item): item is Extract<Item, { kind: "text" | "synthetic" }> =>
                item.kind === "text" || item.kind === "synthetic",
        )
        .map((item) => item.text)
        .filter(Boolean)
        .join("\n\n")
}

export function formatPrefixSummary(turns: Turn[], transcriptRelativePath: string): string {
    const userMessages = turns
        .filter((turn) => turn.role === "user" && !turn.ephemeral)
        .map((turn) => turnText(turn).trim())
        .filter(Boolean)
    const assistantFacts = turns
        .filter((turn) => turn.role === "assistant")
        .map((turn) => turnText(turn).trim())
        .filter(Boolean)

    return [
        "Older context was compacted as a last resort. Exact raw history is available in the reference transcript.",
        "",
        "## Preserved User Messages From Prefix",
        ...(userMessages.length > 0 ? userMessages.map((text) => `- ${truncate(text, 600)}`) : ["- (none)"]),
        "",
        "## Assistant Progress From Prefix",
        ...(assistantFacts.length > 0 ? assistantFacts.map((text) => `- ${truncate(text, 600)}`) : ["- (none)"]),
        "",
        "## Reference Files",
        `- "${transcriptRelativePath}"`,
    ].join("\n")
}

function stripAssistantItems(
    working: Turn[],
    rawTailStartIndex: number,
    matches: (item: Item) => boolean,
): StageMutationResult {
    const changedTurns = new Set<string>()
    let changedItems = 0
    for (let index = 0; index < rawTailStartIndex; index++) {
        const turn = working[index]
        if (!turn || turn.role !== "assistant") continue
        const before = turn.items.length
        turn.items = turn.items.filter((item) => !matches(item))
        const removed = before - turn.items.length
        if (removed > 0) {
            changedTurns.add(turn.key)
            changedItems += removed
        }
    }
    return { changedTurns, changedItems }
}

function stripToolItems(working: Turn[], ctx: StageContext, preserved: ReadonlySet<string>): StageMutationResult {
    const todo = ctx.conventions.todo
    const latestTodoCallId = findLatestTodoCallId(working.slice(0, ctx.rawTailStartIndex), ctx.conventions)
    const changedTurns = new Set<string>()
    let changedItems = 0

    for (let index = 0; index < ctx.rawTailStartIndex; index++) {
        const turn = working[index]
        if (!turn || turn.role !== "assistant") continue
        const nextItems: Item[] = []
        let removedTools = 0
        let latestTodoState: string | null = null

        for (const item of turn.items) {
            if (item.kind !== "tool") {
                nextItems.push(item)
                continue
            }
            if (preserved.has(item.callId)) {
                nextItems.push(item)
                continue
            }
            if (todo?.isTodoItem(item) && item.callId === latestTodoCallId) {
                latestTodoState = `Latest todo state preserved: ${todo.format(item)}`
            }
            removedTools++
        }

        if (latestTodoState) nextItems.push(syntheticText(turn, latestTodoState))
        if (removedTools > 0 && nextItems.length === 0) {
            nextItems.push(
                syntheticText(turn, `[tool calls/results cleared]\nRaw transcript: ${ctx.transcriptRelativePath}`),
            )
        }
        if (removedTools > 0) {
            turn.items = nextItems
            changedTurns.add(turn.key)
            changedItems += removedTools
        }
    }

    return { changedTurns, changedItems }
}

function compactAssistantRuns(working: Turn[], ctx: StageContext): StageMutationResult {
    const compacted = working.slice(0, ctx.rawTailStartIndex)
    if (ctx.selectRuns) {
        const selected = selectAssistantRunsToSummarize(compacted, working, ctx)
        for (const key of selected) ctx.assistantSummaryKeys.add(key)
    }
    const transformed = transformCompactedPrefix(compacted, ctx)
    const tail = working.slice(ctx.rawTailStartIndex)
    const changedTurns = new Set<string>()
    let changedItems = 0
    for (const group of assistantGroups(compacted)) {
        if (!ctx.assistantSummaryKeys.has(group.key)) continue
        let groupItems = 0
        for (const turn of group.turns) {
            changedTurns.add(turn.key)
            groupItems += turn.items.length
        }
        // Each selected group collapses into a single replacement text item.
        changedItems += Math.max(0, groupItems - 1)
    }
    working.length = 0
    working.push(...transformed, ...tail)
    return { changedTurns, changedItems }
}

function selectAssistantRunsToSummarize(compacted: Turn[], allTurns: Turn[], ctx: StageContext): Set<string> {
    const needed = estimateTurns(allTurns, ctx.codec, ctx.estimator) + ctx.referenceTokens - ctx.targetTokens
    if (needed <= 0) return new Set()

    let selectedSavings = 0
    const groups = assistantGroups(compacted)
        .map((group) => {
            const before = estimateTurns(group.turns, ctx.codec, { overheadTokens: 0 })
            const summaryText = group.turns.map(turnText).filter(Boolean).join("\n\n")
            const after = Math.max(1, countTokens(truncate(summaryText, ASSISTANT_TEXT_PREVIEW_CHARS)))
            const savings = Math.max(0, Math.round(before - after))
            const age = compacted.length <= 1 ? 1 : 1 - group.endIndex / (compacted.length - 1)
            return {
                ...group,
                savings,
                score: savings * (1 + age),
            }
        })
        .filter((group) => group.savings > 0)
        .sort((a, b) => b.score - a.score)

    const selected = new Set<string>()
    for (const group of groups) {
        selected.add(group.key)
        selectedSavings += group.savings
        if (selectedSavings >= needed) break
    }
    return selected
}

function assistantGroups(turns: Turn[]): Array<{ key: string; turns: Turn[]; endIndex: number }> {
    const groups: Array<{ key: string; turns: Turn[]; endIndex: number }> = []
    let current: Turn[] = []
    const flush = (endIndex: number) => {
        if (current.length === 0) return
        groups.push({ key: assistantRunKey(current), turns: current, endIndex })
        current = []
    }
    turns.forEach((turn, index) => {
        if (turn.role === "user") {
            flush(index - 1)
            return
        }
        current.push(turn)
    })
    flush(turns.length - 1)
    return groups
}

function collapseAssistantRun(group: Turn[], ctx: StageContext): Turn {
    const first = group[0]
    if (!first) throw new Error("Cannot compact empty assistant turn")
    const key = assistantRunKey(group)
    const assistantText = group.map(turnText).filter(Boolean).join("\n\n")
    const existingSummary = ctx.assistantSummaries[key]
    if (!existingSummary) {
        ctx.summaryJobs.push({
            key,
            rangeStartMessageId: first.key,
            rangeEndMessageId: group.at(-1)?.key ?? first.key,
            transcriptRelativePath: ctx.transcriptRelativePath,
            prompt: formatAssistantSummaryPrompt(group, ctx.transcriptRelativePath, ctx.codec),
        })
    }

    const lines = ["[Assistant turn summary]"]
    lines.push(
        existingSummary?.trim() ||
            truncate(assistantText.trim(), ASSISTANT_TEXT_PREVIEW_CHARS) ||
            "Historical assistant/tool activity compactified.",
    )

    let latestTodoState: string | null = null
    for (const item of group.flatMap((turn) => turn.items)) {
        if (
            item.kind === "tool" &&
            ctx.conventions.todo?.isTodoItem(item) &&
            item.callId === ctx.latestTodoCallId
        ) {
            latestTodoState = `Latest todo state preserved: ${ctx.conventions.todo.format(item)}`
        }
        const note = ctx.conventions.itemNote?.(item)
        if (note) lines.push(note)
    }
    if (latestTodoState) lines.push(latestTodoState)
    lines.push(`Raw transcript: ${ctx.transcriptRelativePath}`)

    return {
        key: first.key,
        stamp: first.stamp,
        role: first.role,
        handle: first.handle,
        items: [{ kind: "synthetic", key: `${first.key}_better_compact_compactified`, text: lines.join("\n") }],
    }
}

function syntheticText(turn: Turn, text: string): Item {
    return { kind: "synthetic", key: syntheticTextKey(turn.key, text), text }
}
