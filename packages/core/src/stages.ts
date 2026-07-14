import { countTokens, estimateTurns, truncate, type Estimator } from "./estimate"
import { assistantRunKey, syntheticTextKey } from "./identity"
import type { CodecOps, Conventions, Item, Turn } from "./ir"
import type { BoundaryStageName, BoundarySummaryJob } from "./plan"
import { formatAssistantSummaryPrompt, formatSummarySections } from "./summarize"

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
        stubToolItems(working, ctx, (item) => ctx.conventions.isSkillItem?.(item) ?? false),
}

export const supersedeReadsStage: Stage = {
    name: "supersede-reads",
    label: "Superseded repeated tool reads",
    always: true,
    run: (working, ctx) => supersedeToolReads(working, ctx),
}

export const purgeErrorInputsStage: Stage = {
    name: "purge-error-inputs",
    label: "Purged stale failed tool inputs",
    always: true,
    run: (working, ctx) => purgeErrorInputs(working, ctx),
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
    run: (working, ctx) =>
        stripAssistantItems(working, ctx.rawTailStartIndex, (item) => item.kind === "reasoning"),
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

export function findRawTailStartIndex(
    turns: Turn[],
    minTurns: number,
    minUserTurns: number,
): number {
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

export function formatPrefixSummary(turns: Turn[]): string {
    const userMessages = turns
        .filter((turn) => turn.role === "user" && !turn.ephemeral)
        .map((turn) => turnText(turn).trim())
        .filter(Boolean)
    const assistantFacts = turns
        .filter((turn) => turn.role === "assistant")
        .map((turn) => turnText(turn).trim())
        .filter(Boolean)

    return formatSummarySections([
        [],
        [],
        [],
        [],
        userMessages.map(formatSummaryItem),
        assistantFacts.map(
            (text) => `Resume from prior assistant progress: ${formatSummaryItem(text)}`,
        ),
    ])
}

function formatSummaryItem(text: string): string {
    return truncate(oneLine(text).trim(), 600).replace("\n[...omitted]", " [...omitted]")
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

function stubToolItems(
    working: Turn[],
    ctx: StageContext,
    matches: (item: Extract<Item, { kind: "tool" }>) => boolean,
    outcome?: (item: Extract<Item, { kind: "tool" }>) => string | undefined,
): StageMutationResult {
    const changedTurns = new Set<string>()
    let changedItems = 0
    for (let index = 0; index < ctx.rawTailStartIndex; index++) {
        const turn = working[index]
        if (!turn || turn.role !== "assistant") continue
        let changed = false
        turn.items = turn.items.map((item) => {
            if (item.kind !== "tool" || !matches(item)) return item
            changed = true
            changedItems++
            return toolStub(item, ctx.conventions, outcome?.(item))
        })
        if (changed) changedTurns.add(turn.key)
    }
    return { changedTurns, changedItems }
}

function supersedeToolReads(working: Turn[], ctx: StageContext): StageMutationResult {
    const newestByTarget = new Map<string, { name: string; target: string; itemKey: string }>()
    for (let turnIndex = ctx.rawTailStartIndex - 1; turnIndex >= 0; turnIndex--) {
        const turn = working[turnIndex]
        if (!turn || turn.role !== "assistant") continue
        for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex--) {
            const item = turn.items[itemIndex]
            if (item.kind !== "tool") continue
            const details = ctx.conventions.tool?.(item)
            const target = primaryToolTarget(details?.input)
            if (!details || !target) continue
            const name = oneLine(details.name).trim()
            const identity = JSON.stringify([name, target.normalized])
            if (!newestByTarget.has(identity)) {
                newestByTarget.set(identity, { name, target: target.normalized, itemKey: item.key })
            }
        }
    }

    return stubToolItems(
        working,
        ctx,
        (item) => {
            const details = ctx.conventions.tool?.(item)
            const target = primaryToolTarget(details?.input)
            if (!details || !target) return false
            const name = oneLine(details.name).trim()
            const newest = newestByTarget.get(JSON.stringify([name, target.normalized]))
            return newest !== undefined && newest.itemKey !== item.key
        },
        (item) => {
            const details = ctx.conventions.tool?.(item)
            const target = primaryToolTarget(details?.input)
            if (!details || !target) return undefined
            const name = oneLine(details.name).trim()
            const newest = newestByTarget.get(JSON.stringify([name, target.normalized]))
            if (!newest || newest.itemKey === item.key) return undefined
            const error = details.error === undefined ? "" : `; error: ${firstLine(details.error)}`
            return `superseded by later ${newest.name} on ${newest.target}${error}`
        },
    )
}

function purgeErrorInputs(working: Turn[], ctx: StageContext): StageMutationResult {
    return stubToolItems(
        working,
        ctx,
        (item) =>
            !ctx.preservedToolCallIds.has(item.callId) &&
            ctx.conventions.tool?.(item).error !== undefined,
    )
}

function stripToolItems(
    working: Turn[],
    ctx: StageContext,
    preserved: ReadonlySet<string>,
): StageMutationResult {
    const todo = ctx.conventions.todo
    const latestTodoCallId = findLatestTodoCallId(
        working.slice(0, ctx.rawTailStartIndex),
        ctx.conventions,
    )
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
            nextItems.push(toolStub(item, ctx.conventions))
            removedTools++
        }

        if (latestTodoState) nextItems.push(syntheticText(turn, latestTodoState))
        if (removedTools > 0) {
            turn.items = nextItems
            changedTurns.add(turn.key)
            changedItems += removedTools
        }
    }

    return { changedTurns, changedItems }
}

function toolStub(
    item: Extract<Item, { kind: "tool" }>,
    conventions: Conventions,
    outcomeOverride?: string,
): Item {
    const details = conventions.tool?.(item)
    const name = oneLine(details?.name || "tool")
    const target = primaryToolTarget(details?.input)?.display ?? `callId=${oneLine(item.callId)}`
    const outcome =
        outcomeOverride ??
        (details?.error === undefined ? "ok" : `error: ${firstLine(details.error)}`)
    const text = `[tool:${name}] ${target} — ${outcome}`
    return { kind: "synthetic", key: syntheticTextKey(item.key, text), text }
}

export function primaryToolTarget(input: unknown): { display: string; normalized: string } | null {
    const parsed = parseToolInput(input)
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
        const display = oneLine(String(parsed)).trim()
        return display ? { display, normalized: display } : null
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null

    const record = parsed as Record<string, unknown>
    const pathKeys = ["filePath", "file_path", "path", "filename", "directory", "dir"]
    const keys = [
        ...pathKeys,
        "command",
        "cmd",
        "key",
        "query",
        "pattern",
        "url",
        "uri",
        "id",
        "name",
    ]
    for (const key of keys) {
        const value = record[key]
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
            continue
        const display = oneLine(String(value)).trim()
        if (display) {
            const normalized = pathKeys.includes(key) ? normalizePath(display) : display
            return { display, normalized }
        }
    }
    return null
}

function normalizePath(value: string): string {
    const path = value.replace(/\\/g, "/")
    const absolute = path.startsWith("/")
    const segments: string[] = []
    for (const segment of path.split("/")) {
        if (!segment || segment === ".") continue
        if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
            segments.pop()
        } else if (segment !== ".." || !absolute) {
            segments.push(segment)
        }
    }
    const normalized = `${absolute ? "/" : ""}${segments.join("/")}`
    return normalized || (absolute ? "/" : ".")
}

function parseToolInput(input: unknown): unknown {
    if (typeof input !== "string") return input
    try {
        return JSON.parse(input)
    } catch {
        return input
    }
}

function oneLine(value: string): string {
    return value.replace(/\r\n|\n|\r/g, " ").replace(/\s+/g, " ")
}

function firstLine(value: string): string {
    return value.split(/\r\n|\n|\r/, 1)[0]
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

function selectAssistantRunsToSummarize(
    compacted: Turn[],
    allTurns: Turn[],
    ctx: StageContext,
): Set<string> {
    const needed =
        estimateTurns(allTurns, ctx.codec, ctx.estimator) + ctx.referenceTokens - ctx.targetTokens
    if (needed <= 0) return new Set()

    let selectedSavings = 0
    const groups = assistantGroups(compacted)
        .map((group) => {
            const before = estimateTurns(group.turns, ctx.codec, { overheadTokens: 0 })
            const summaryText = group.turns.map(turnText).filter(Boolean).join("\n\n")
            const after = Math.max(
                1,
                countTokens(truncate(summaryText, ASSISTANT_TEXT_PREVIEW_CHARS)),
            )
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

export function assistantGroups(turns: Turn[]): Array<{ key: string; turns: Turn[]; endIndex: number }> {
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
        items: [
            {
                kind: "synthetic",
                key: `${first.key}_better_compact_compactified`,
                text: lines.join("\n"),
            },
        ],
    }
}

function syntheticText(turn: Turn, text: string): Item {
    return { kind: "synthetic", key: syntheticTextKey(turn.key, text), text }
}
