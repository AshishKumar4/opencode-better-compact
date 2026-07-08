/**
 * Better Compact Stats command handler.
 * Reports the live boundary pruning plan for the current session.
 */

import type { Logger } from "../logger"
import type { BoundaryJobStatus, SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import { getCurrentParams } from "../token-utils"

export interface StatsCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export interface StatsStageSummary {
    label: string
    clearedTokens: number
    status: string
}

export interface StatsReport {
    hasPlan: boolean
    status: BoundaryJobStatus | null
    beforeTokens: number
    afterTokens: number
    clearedTokens: number
    targetTokens: number
    contextLimit: number
    transcriptPath: string | null
    createdAt: number | null
    stages: StatsStageSummary[]
}

export function buildStatsReport(state: SessionState): StatsReport {
    const plan = state.boundary.activePlan
    const status = state.boundary.job?.status ?? null

    if (!plan || plan.sessionId !== state.sessionId) {
        return {
            hasPlan: false,
            status,
            beforeTokens: 0,
            afterTokens: 0,
            clearedTokens: 0,
            targetTokens: 0,
            contextLimit: 0,
            transcriptPath: null,
            createdAt: null,
            stages: [],
        }
    }

    return {
        hasPlan: true,
        status,
        beforeTokens: plan.beforeTokens,
        afterTokens: plan.afterPruneTokens,
        clearedTokens: Math.max(0, plan.beforeTokens - plan.afterPruneTokens),
        targetTokens: plan.targetTokens,
        contextLimit: plan.contextLimit,
        transcriptPath: plan.transcriptRelativePath || null,
        createdAt: plan.createdAt ?? null,
        stages: (plan.stages ?? []).map((stage) => ({
            label: stage.label,
            clearedTokens: stage.clearedTokens,
            status: stage.status,
        })),
    }
}

export function formatStatsMessage(report: StatsReport): string {
    const lines: string[] = []

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                Better Compact Statistics                  │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")

    if (!report.hasPlan) {
        lines.push("No Better Compact plan is active for this session yet.")
        lines.push("Run /better-compact to prune historical context.")
        return lines.join("\n")
    }

    lines.push("Active pruning plan:")
    lines.push("─".repeat(60))
    lines.push(`  Status:           ${report.status ?? "unknown"}`)
    lines.push(
        `  Context:          ~${formatTokenCount(report.beforeTokens)} -> ~${formatTokenCount(report.afterTokens)}`,
    )
    lines.push(`  Cleared:          ~${formatTokenCount(report.clearedTokens)}`)
    lines.push(`  Target:           ~${formatTokenCount(report.targetTokens)}`)
    lines.push(`  Context limit:    ~${formatTokenCount(report.contextLimit)}`)
    if (report.createdAt) {
        lines.push(`  Created:          ${new Date(report.createdAt).toISOString()}`)
    }
    if (report.transcriptPath) {
        lines.push(`  Transcript:       ${report.transcriptPath}`)
    }

    const appliedStages = report.stages.filter((stage) => stage.clearedTokens > 0)
    if (appliedStages.length > 0) {
        lines.push("")
        lines.push("Stages:")
        for (const stage of appliedStages) {
            lines.push(`  → ${stage.label}: ~${formatTokenCount(stage.clearedTokens)} cleared`)
        }
    }

    return lines.join("\n")
}

export async function handleStatsCommand(ctx: StatsCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const report = buildStatsReport(state)
    const message = formatStatsMessage(report)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Stats command executed", {
        hasPlan: report.hasPlan,
        clearedTokens: report.clearedTokens,
        status: report.status,
    })
}
