/**
 * Better Compact Help command handler.
 * Shows available Better Compact commands and their descriptions.
 */

import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"

export interface HelpCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

const COMMANDS: [string, string][] = [
    ["/better-compact", "Run staged context pruning now"],
    ["/better-compact context", "Show token usage breakdown for current session"],
    ["/better-compact stats", "Show pruning statistics"],
    ["/better-compact help", "Show this help"],
    ["/better-compact-settings", "Open Better Compact settings panel"],
]

export function formatHelpMessage(state: SessionState, config: PluginConfig): string {
    const commands = COMMANDS
    const colWidth = Math.max(...commands.map(([cmd]) => cmd.length)) + 4
    const lines: string[] = []

    lines.push("╭─────────────────────────────────────────────────────────────────────────╮")
    lines.push("│                         Better Compact Commands                         │")
    lines.push("╰─────────────────────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("  Better Compact preserves raw user messages first, prunes assistant/tool-heavy history in stages, and writes transcript refs for exact recall.")
    lines.push("")
    for (const [cmd, desc] of commands) {
        lines.push(`  ${cmd.padEnd(colWidth)}${desc}`)
    }
    lines.push("")

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const { config } = ctx
    const message = formatHelpMessage(state, config)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Help command executed")
}
