/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { registerCommands } from "./lib/tui/commands"
import { activeSessionID, currentContextUsage, loadConfig, loadTuiCompactionSettings } from "./lib/tui/data"
import { resolveCompactionProfile } from "@better-compact/core"
import { openPanelModal, openProgressModal } from "./lib/tui/modals"

const tui: TuiPluginModule["tui"] = async (api) => {
    const config = loadConfig(api)
    if (!config.enabled || !config.commands.enabled) return

    registerCommands(api, [
        {
            title: "Better Compact",
            name: "better-compact.run",
            description: "Run Better Compact staged pruning",
            slashName: "better-compact",
            run: async () => {
                const sessionID = activeSessionID(api)
                if (!sessionID) {
                    api.ui.toast({
                        title: "Better Compact",
                        message: "Open a session first.",
                        variant: "warning",
                    })
                    return
                }
                const settings = loadTuiCompactionSettings(api, config)
                const profile = resolveCompactionProfile(config, settings)
                const usage = currentContextUsage(api, sessionID)
                const percent = usage.limit > 0 ? Math.round((usage.tokens / usage.limit) * 100) : 0
                const run = async () => {
                    openProgressModal(api, config, sessionID)
                    await api.client.session.prompt({
                        sessionID,
                        noReply: true,
                        parts: [
                            {
                                type: "text",
                                text: "Better Compact requested.",
                                ignored: true,
                                metadata: {
                                    betterCompact: "run",
                                    compaction: settings,
                                    contextLimit: usage.limit,
                                    currentTokens: usage.tokens,
                                },
                            },
                        ],
                    })
                }
                if (usage.limit > 0 && percent < profile.triggerPercent) {
                    api.ui.dialog.replace(() => (
                        <api.ui.DialogConfirm
                            title="Compact anyway?"
                            message={`Current context is about ${percent}% used, below the ${profile.triggerPercent}% ${profile.preset} trigger. Target is ${profile.targetPercent}%. Continue?`}
                            onConfirm={() => void run()}
                        />
                    ))
                    api.ui.dialog.setSize("medium")
                    return
                }
                await run()
            },
        },
        {
            title: "Better Compact Settings",
            name: "better-compact.panel",
            description: "Open Better Compact settings",
            slashName: "better-compact-settings",
            run: () => openPanelModal(api, config),
        },
    ])
}

export default {
    id: "better-compact",
    tui,
} satisfies TuiPluginModule
