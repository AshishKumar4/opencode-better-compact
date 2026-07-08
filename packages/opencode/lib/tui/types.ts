import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { buildStatsReport } from "../commands/stats"

export type TuiApi = Parameters<NonNullable<TuiPluginModule["tui"]>>[0]
export type Theme = TuiApi["theme"]["current"]
export type ThemeColor = Exclude<keyof Theme, "thinkingOpacity" | "_hasSelectedListItemText">
export type StatsReport = Awaited<ReturnType<typeof buildStatsReport>>

export type BetterCompactCommand = {
    title: string
    name: string
    description: string
    slashName: string
    slashAliases?: string[]
    run: () => void | Promise<void>
}
