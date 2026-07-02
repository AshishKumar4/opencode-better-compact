import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { applyBoundaryPlanSnapshot } from "../boundary"
import { estimateContextBreakdown } from "../context-estimate"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import { isIgnoredUserMessage } from "../messages/query"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"

export interface ContextCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export interface TokenBreakdown {
    reportedTotal: number
    estimatedTotal: number
    user: number
    assistant: number
    reasoning: number
    tools: number
    references: number
    other: number
    unattributed: number
    toolCount: number
    toolsInContextCount: number
    prunedTokens: number
    prunedToolCount: number
    prunedMessageCount: number
}

export function analyzeContextTokens(state: SessionState, messages: WithParts[]): TokenBreakdown {
    const activeMessages = cloneMessages(messages)
    if (state.boundary.activePlan && state.boundary.activePlan.sessionId === state.sessionId) {
        applyBoundaryPlanSnapshot(activeMessages, state.boundary.activePlan)
    }

    const estimated = estimateContextBreakdown(activeMessages)
    const reportedTotal = getCurrentTokenUsage(state, messages)
    const pruned = countPrunedTargets(state, messages)

    return {
        reportedTotal,
        estimatedTotal: estimated.total,
        user: estimated.user,
        assistant: estimated.assistant,
        reasoning: estimated.reasoning,
        tools: estimated.tools,
        references: estimated.references,
        other: estimated.other,
        unattributed: Math.max(0, reportedTotal - estimated.total),
        toolCount: estimated.toolCount,
        toolsInContextCount: estimated.toolCount,
        prunedTokens: state.stats.totalPruneTokens,
        prunedToolCount: pruned.tools,
        prunedMessageCount: pruned.messages,
    }
}

export function formatContextMessage(breakdown: TokenBreakdown): string {
    const lines: string[] = []
    const barWidth = 30
    const categories = [
        { label: "User messages", value: breakdown.user, char: "▓" },
        { label: "Assistant text", value: breakdown.assistant, char: "▒" },
        { label: "Reasoning", value: breakdown.reasoning, char: "▒" },
        { label: `Tool calls/results (${breakdown.toolsInContextCount})`, value: breakdown.tools, char: "░" },
        { label: "BC refs/summaries", value: breakdown.references, char: "█" },
        { label: "Other visible history", value: breakdown.other, char: "░" },
    ].filter((item) => item.value > 0)

    const maxLabelLen = Math.max(1, ...categories.map((category) => category.label.length))

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│              Better Compact Context Analysis              │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Reported by OpenCode:")
    lines.push(`  Current usage:             ~${formatTokenCount(breakdown.reportedTotal)}`)
    lines.push("")
    lines.push("Estimated active history shape:")
    lines.push(`  Estimated visible history: ~${formatTokenCount(breakdown.estimatedTotal)}`)
    if (breakdown.unattributed > 0) {
        lines.push(`  Unattributed/provider overhead/cache/system: ~${formatTokenCount(breakdown.unattributed)}`)
    }
    lines.push("─".repeat(60))
    lines.push("")

    if (categories.length === 0) {
        lines.push("  No visible history content found.")
    } else {
        for (const category of categories) {
            const bar = createBar(category.value, breakdown.estimatedTotal, barWidth, category.char)
            const percentage = breakdown.estimatedTotal > 0 ? ((category.value / breakdown.estimatedTotal) * 100).toFixed(1) : "0.0"
            const labelWithPct = `${category.label.padEnd(maxLabelLen)} ${percentage.padStart(5)}% `
            const valueStr = formatTokenCount(category.value).padStart(13)
            lines.push(`${labelWithPct}│${bar.padEnd(barWidth)}│${valueStr}`)
        }
    }

    lines.push("")
    lines.push("Notes:")
    lines.push("  Reported usage is provider/OpenCode token accounting and should match the footer.")
    lines.push("  Category percentages are OpenCode-style estimates over visible active history, not exact provider attribution.")

    if (breakdown.prunedTokens > 0) {
        const pruned = []
        if (breakdown.prunedToolCount > 0) pruned.push(`${breakdown.prunedToolCount} tools`)
        if (breakdown.prunedMessageCount > 0) pruned.push(`${breakdown.prunedMessageCount} messages`)
        lines.push("")
        lines.push(`  Better Compact pruned: ${pruned.join(", ")} (~${formatTokenCount(breakdown.prunedTokens)})`)
    }

    lines.push("")
    return lines.join("\n")
}

export async function handleContextCommand(ctx: ContextCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx
    const message = formatContextMessage(analyzeContextTokens(state, messages))
    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)
}

function createBar(value: number, maxValue: number, width: number, char: string): string {
    if (maxValue <= 0) return ""
    const filled = Math.round((value / maxValue) * width)
    return char.repeat(Math.max(0, filled))
}

function countPrunedTargets(state: SessionState, messages: WithParts[]): { tools: number; messages: number } {
    const visibleMessageIds = new Set(messages.filter((message) => !isIgnoredUserMessage(message)).map((message) => message.info.id))
    let prunedMessages = 0
    for (const [id, entry] of state.prune.messages.byMessageId) {
        if (visibleMessageIds.has(id) && entry.activeBlockIds.length > 0) prunedMessages++
    }
    return {
        tools: state.prune.tools.size,
        messages: prunedMessages,
    }
}

function cloneMessages(messages: WithParts[]): WithParts[] {
    return messages.map((message) => ({
        info: message.info,
        parts: [...message.parts],
    }))
}
