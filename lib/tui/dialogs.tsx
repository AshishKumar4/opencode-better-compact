/** @jsxImportSource @opentui/solid */

import { compressPermission } from "../compress-permission"
import { analyzeContextTokens } from "../commands/context"
import {
    normalizeCompactionCustom,
    resolveCompactionProfile,
    type CompactionConfig,
    type CompactionPreset,
} from "../compaction-settings"
import {
    type PluginConfig,
} from "../config"
import type { BoundaryJobProgress, BoundaryJobStage, SessionState, WithParts } from "../state"
import { formatTokenCount } from "../ui/utils"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { formatDuration, formatRatio } from "./format"
import { ActionRow, BetterCompactFrame, Card, Metric, Progress, PromptRow, StatusPill } from "./ui"
import type { StatsReport, Theme, TuiApi } from "./types"

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"]

export function StatusDialog(props: {
    api: TuiApi
    title: string
    eyebrow: string
    message: string
}) {
    return (
        <BetterCompactFrame api={props.api} title={props.title} eyebrow={props.eyebrow}>
            <box paddingTop={1} paddingBottom={1}>
                <text fg={props.api.theme.current.textMuted}>{props.message}</text>
            </box>
        </BetterCompactFrame>
    )
}

export function ContextDialog(props: {
    api: TuiApi
    state: SessionState
    messages: WithParts[]
    onBack: () => void
}) {
    const theme = props.api.theme.current
    const breakdown = analyzeContextTokens(props.state, props.messages)
    const estimatedTotal = Math.max(0, breakdown.estimatedTotal)
    const activePruned = breakdown.prunedToolCount + breakdown.prunedMessageCount

    return (
        <BetterCompactFrame api={props.api} title="Context" eyebrow="Better Compact" onBack={props.onBack}>
            <Card theme={theme} title="Reported by OpenCode">
                <Metric
                    theme={theme}
                    label="Current usage"
                    value={`~${formatTokenCount(breakdown.reportedTotal)}`}
                />
                <Metric
                    theme={theme}
                    label="Estimated history"
                    value={`~${formatTokenCount(breakdown.estimatedTotal)}`}
                />
                <Metric theme={theme} label="Unattributed overhead" value={`~${formatTokenCount(breakdown.unattributed)}`} />
            </Card>
            <Card theme={theme} title="Better Compact State">
                <Metric theme={theme} label="Active pruned targets" value={`${activePruned}`} />
                <Metric
                    theme={theme}
                    label="Tokens pruned"
                    value={`~${formatTokenCount(breakdown.prunedTokens)}`}
                />
            </Card>
            <Card theme={theme} title="Estimated Active History">
                <Progress
                    theme={theme}
                    label="User"
                    value={breakdown.user}
                    total={estimatedTotal}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.user)}`}
                />
                <Progress
                    theme={theme}
                    label="Assistant"
                    value={breakdown.assistant}
                    total={estimatedTotal}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.assistant)}`}
                />
                <Progress
                    theme={theme}
                    label="Reasoning"
                    value={breakdown.reasoning}
                    total={estimatedTotal}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.reasoning)}`}
                />
                <Progress
                    theme={theme}
                    label={`Tools (${breakdown.toolsInContextCount})`}
                    value={breakdown.tools}
                    total={estimatedTotal}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.tools)}`}
                />
                <Progress
                    theme={theme}
                    label="BC refs"
                    value={breakdown.references}
                    total={estimatedTotal}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.references)}`}
                />
                <Progress
                    theme={theme}
                    label="Other"
                    value={breakdown.other}
                    total={estimatedTotal}
                    color="primary"
                    detail={`~${formatTokenCount(breakdown.other)}`}
                />
            </Card>
        </BetterCompactFrame>
    )
}

export function StatsDialog(props: { api: TuiApi; report: StatsReport; onBack: () => void }) {
    const theme = props.api.theme.current
    const ratio = formatRatio(props.report.sessionTokens, props.report.sessionSummaryTokens)
    return (
        <BetterCompactFrame api={props.api} title="Stats" eyebrow="Better Compact" onBack={props.onBack}>
            <Card theme={theme} title="Session">
                <Metric
                    theme={theme}
                    label="Tokens saved"
                    value={`~${formatTokenCount(props.report.sessionTokens)}`}
                    hint="tokens"
                />
                <Metric
                    theme={theme}
                    label="Summary size"
                    value={`~${formatTokenCount(props.report.sessionSummaryTokens)}`}
                    hint="tokens"
                />
                <Metric theme={theme} label="Compression ratio" value={ratio} />
                <Metric
                    theme={theme}
                    label="Compression time"
                    value={formatDuration(props.report.sessionDurationMs)}
                />
                <Metric theme={theme} label="Tools pruned" value={`${props.report.sessionTools}`} />
                <Metric
                    theme={theme}
                    label="Messages pruned"
                    value={`${props.report.sessionMessages}`}
                />
            </Card>
            <Card theme={theme} title="All time">
                <Metric
                    theme={theme}
                    label="Tokens saved"
                    value={`~${formatTokenCount(props.report.allTime.totalTokens)}`}
                    hint="tokens"
                />
                <Metric
                    theme={theme}
                    label="Tools pruned"
                    value={`${props.report.allTime.totalTools}`}
                />
                <Metric
                    theme={theme}
                    label="Messages pruned"
                    value={`${props.report.allTime.totalMessages}`}
                />
                <Metric
                    theme={theme}
                    label="Sessions with Better Compact history"
                    value={`${props.report.allTime.sessionCount}`}
                />
            </Card>
        </BetterCompactFrame>
    )
}

export function ProgressDialog(props: {
    api: TuiApi
    initialJob?: BoundaryJobProgress | null
    loadJob: () => Promise<BoundaryJobProgress | null>
    onBack?: () => void
}) {
    const theme = props.api.theme.current
    const dimensions = useTerminalDimensions()
    const [job, setJob] = createSignal<BoundaryJobProgress | null>(props.initialJob ?? null)
    const [tick, setTick] = createSignal(0)

    createEffect(() => {
        let stopped = false
        const refresh = async () => {
            try {
                const next = await props.loadJob()
                if (!stopped && next) setJob(next)
            } catch {}
        }
        void refresh()
        const interval = setInterval(() => {
            setTick((value) => value + 1)
            void refresh()
        }, 250)
        onCleanup(() => {
            stopped = true
            clearInterval(interval)
        })
    })

    const current = () => job()
    const spinner = () => SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]
    const percent = () => current()?.percent ?? 0
    const elapsed = () => {
        const item = current()
        if (!item) return "0s"
        const end = item.completedAt ?? Date.now()
        return formatDuration(Math.max(0, end - item.startedAt))
    }
    const bodyHeight = () => Math.max(4, Math.min(6, Math.floor(dimensions().height * 0.2)))

    return (
        <BetterCompactFrame api={props.api} title="Progress" eyebrow="Better Compact" onBack={props.onBack}>
            <Card theme={theme} title="Run">
                <box flexDirection="row" justifyContent="space-between">
                    <box flexDirection="row" gap={2} flexGrow={1}>
                        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                            {current()?.status === "running" ? spinner() : current()?.status === "failed" ? "×" : "✓"}
                        </text>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                            {current()?.currentStage ?? "Waiting for Better Compact to start"}
                        </text>
                    </box>
                    <text fg={theme.textMuted}>{elapsed()}</text>
                </box>
                <Progress
                    theme={theme}
                    label="Overall"
                    value={percent()}
                    total={100}
                    color={current()?.status === "failed" ? "error" : "primary"}
                    detail={`${percent()}%`}
                />
                <ContextWindowMeters theme={theme} job={current()} />
                {current()?.error ? <text fg={theme.error}>{current()?.error}</text> : null}
            </Card>

            <scrollbox height={bodyHeight()} scrollbarOptions={{ visible: true }}>
                <box flexDirection="column" gap={1}>
                    <Card theme={theme} title="Stages">
                        <box flexDirection="column" gap={0}>
                            {(current()?.stages ?? []).map((stage) => (
                                <StageRow theme={theme} stage={stage} spinning={spinner()} />
                            ))}
                            {!current() ? <text fg={theme.textMuted}>Waiting for first progress update...</text> : null}
                        </box>
                    </Card>

                    <Card theme={theme} title="Live Log">
                        <box flexDirection="column" gap={0}>
                            {(current()?.logs ?? []).slice(-8).map((line) => (
                                <text fg={theme.textMuted}>{line}</text>
                            ))}
                            {!current()?.logs?.length ? <text fg={theme.textMuted}>No log entries yet.</text> : null}
                        </box>
                    </Card>
                </box>
            </scrollbox>
        </BetterCompactFrame>
    )
}

function ContextWindowMeters(props: { theme: Theme; job: BoundaryJobProgress | null }) {
    const counters = () => props.job?.counters ?? {}
    const limit = () => counters().contextLimit ?? 0
    const before = () => counters().beforeTokens ?? 0
    const current = () => counters().currentTokens ?? before()
    const cleared = () => counters().clearedTokens ?? Math.max(0, before() - current())
    return (
        <box flexDirection="column" gap={0} paddingTop={1}>
            <text fg={props.theme.primary} attributes={TextAttributes.BOLD}>Context window</text>
            {limit() > 0 ? (
                <>
                    <ContextMeterRow theme={props.theme} label="Before" tokens={before()} limit={limit()} color="warning" />
                    <ContextMeterRow theme={props.theme} label="Now" tokens={current()} limit={limit()} color="primary" />
                    <box flexDirection="row" gap={1} paddingTop={1}>
                        <box width={8}>
                            <text fg={props.theme.textMuted}>Saved:</text>
                        </box>
                        <text fg={props.theme.success} attributes={TextAttributes.BOLD}>{formatTokenCount(cleared(), true)}</text>
                    </box>
                </>
            ) : (
                <box paddingTop={1}>
                    <text fg={props.theme.textMuted}>Waiting for model context limit...</text>
                </box>
            )}
        </box>
    )
}

function ContextMeterRow(props: { theme: Theme; label: string; tokens: number; limit: number; color: "primary" | "success" | "warning" }) {
    const width = 22
    const ratio = Math.max(0, Math.min(1, props.tokens / Math.max(1, props.limit)))
    const filled = Math.round(ratio * width)
    const percent = Math.round((props.tokens / Math.max(1, props.limit)) * 100)
    return (
        <box flexDirection="row" gap={1}>
            <box width={8}>
                <text fg={props.theme.textMuted}>{`${props.label}:`}</text>
            </box>
            <box width={18}>
                <text fg={props.theme.text}>{`${formatTokenCount(props.tokens, true)} / ${formatTokenCount(props.limit, true)}`}</text>
            </box>
            <box width={width} flexDirection="row">
                <text fg={props.theme[props.color]}>{"█".repeat(filled)}</text>
                <text fg={props.theme.borderSubtle}>{"░".repeat(width - filled)}</text>
            </box>
            <text fg={props.theme.textMuted}>{`${percent}%`}</text>
        </box>
    )
}

function StageRow(props: { theme: Theme; stage: BoundaryJobStage; spinning: string }) {
    const statusText = () => {
        if (props.stage.status === "running") return props.spinning
        if (props.stage.status === "completed") return "✓"
        if (props.stage.status === "skipped") return "-"
        if (props.stage.status === "failed") return "×"
        return "○"
    }
    const color = () => {
        if (props.stage.status === "running") return props.theme.primary
        if (props.stage.status === "completed") return props.theme.success
        if (props.stage.status === "failed") return props.theme.error
        return props.theme.textMuted
    }
    const detail = () => props.stage.detail ?? (props.stage.clearedTokens ? `-${formatTokenCount(props.stage.clearedTokens)}` : "")
    return (
        <box flexDirection="column" gap={0} paddingBottom={detail() ? 1 : 0}>
            <box flexDirection="row" gap={2}>
                <box width={2}>
                    <text fg={color()} attributes={props.stage.status === "running" ? TextAttributes.BOLD : undefined}>
                        {statusText()}
                    </text>
                </box>
                <box flexGrow={1}>
                    <text fg={props.theme.text}>{props.stage.label}</text>
                </box>
            </box>
            {detail() ? (
                <box paddingLeft={4}>
                    <text fg={props.theme.textMuted}>{detail()}</text>
                </box>
            ) : null}
        </box>
    )
}

export function PanelDialog(props: {
    api: TuiApi
    state: SessionState
    config: PluginConfig
    settings: CompactionConfig
    onSettingsChange: (settings: CompactionConfig) => void
    onContext: () => void
    onStats: () => void
}) {
    const theme = props.api.theme.current
    const canCompress = compressPermission(props.state, props.config) !== "deny"
    const profile = () => resolveCompactionProfile(props.config, props.settings)
    const setPreset = (preset: CompactionPreset) => props.onSettingsChange({ ...props.settings, preset })
    const setCustom = (custom: Partial<CompactionConfig["custom"]>) =>
        props.onSettingsChange({
            ...props.settings,
            preset: "custom",
            custom: normalizeCompactionCustom({ ...props.settings.custom, ...custom }),
        })
    return (
        <BetterCompactFrame api={props.api} eyebrow="Better Compact">
            <Card theme={theme} title="Compaction Level">
                <box flexDirection="column" gap={1}>
                    <PresetRow theme={theme} current={props.settings.preset} onSelect={setPreset} />
                    <Metric theme={theme} label="Trigger" value={`${profile().triggerPercent}%`} />
                    <Metric theme={theme} label="Target" value={`${profile().targetPercent}%`} />
                    <Metric theme={theme} label="Recent tool tail" value={`~${formatTokenCount(profile().recentToolTokens)}`} />
                </box>
            </Card>
            <Card theme={theme} title="Custom Sliders">
                <box flexDirection="column" gap={1}>
                    <SliderRow
                        theme={theme}
                        label="Trigger"
                        value={props.settings.custom.triggerPercent}
                        min={50}
                        max={95}
                        step={5}
                        suffix="%"
                        onChange={(value) => setCustom({ triggerPercent: value })}
                    />
                    <SliderRow
                        theme={theme}
                        label="Target"
                        value={props.settings.custom.targetPercent}
                        min={10}
                        max={60}
                        step={5}
                        suffix="%"
                        onChange={(value) => setCustom({ targetPercent: value })}
                    />
                    <SliderRow
                        theme={theme}
                        label="Tool tail"
                        value={props.settings.custom.recentToolTokens}
                        min={0}
                        max={80_000}
                        step={5_000}
                        formatter={(value) => `~${formatTokenCount(value)}`}
                        onChange={(value) => setCustom({ recentToolTokens: value })}
                    />
                    <SliderRow
                        theme={theme}
                        label="Parallel jobs"
                        value={props.settings.custom.summarizerConcurrency}
                        min={1}
                        max={12}
                        step={1}
                        onChange={(value) => setCustom({ summarizerConcurrency: value })}
                    />
                </box>
            </Card>
            <Card theme={theme} title="Views">
                <box flexDirection="column" gap={1}>
                    <ActionRow
                        theme={theme}
                        title="Context"
                        detail="Token usage"
                        onClick={props.onContext}
                    />
                    <ActionRow
                        theme={theme}
                        title="Stats"
                        detail="Savings"
                        onClick={props.onStats}
                    />
                </box>
            </Card>
            <Card theme={theme} title="Prompt">
                {canCompress ? (
                    <PromptRow
                        theme={theme}
                        command="/better-compact"
                        description="Run staged context pruning"
                        accent="primary"
                    />
                ) : (
                    <text fg={theme.textMuted}>Compression is denied by permissions.</text>
                )}
            </Card>
            <Card theme={theme} title="Session State">
                <BoundaryStatus api={props.api} />
                <StatusPill
                    theme={theme}
                    label="Compaction command"
                    value={canCompress ? "enabled" : "disabled"}
                    accent={canCompress ? "success" : "warning"}
                />
            </Card>
        </BetterCompactFrame>
    )
}

function PresetRow(props: { theme: Theme; current: CompactionPreset; onSelect: (preset: CompactionPreset) => void }) {
    const presets: CompactionPreset[] = ["light", "moderate", "max", "custom"]
    return (
        <box flexDirection="row" gap={1}>
            {presets.map((preset) => {
                const selected = props.current === preset
                return (
                    <box
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={selected ? props.theme.primary : props.theme.backgroundElement}
                        onMouseUp={() => props.onSelect(preset)}
                    >
                        <text fg={selected ? props.theme.selectedListItemText : props.theme.text} attributes={selected ? TextAttributes.BOLD : undefined}>
                            {preset}
                        </text>
                    </box>
                )
            })}
        </box>
    )
}

function SliderRow(props: {
    theme: Theme
    label: string
    value: number
    min: number
    max: number
    step: number
    suffix?: string
    formatter?: (value: number) => string
    onChange: (value: number) => void
}) {
    const width = 24
    const ratio = Math.max(0, Math.min(1, (props.value - props.min) / Math.max(1, props.max - props.min)))
    const filled = Math.round(ratio * width)
    const display = props.formatter ? props.formatter(props.value) : `${props.value}${props.suffix ?? ""}`
    const set = (next: number) => props.onChange(Math.max(props.min, Math.min(props.max, next)))
    return (
        <box flexDirection="row" gap={2} alignItems="center">
            <box width={16}>
                <text fg={props.theme.text}>{props.label}</text>
            </box>
            <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme.backgroundElement} onMouseUp={() => set(props.value - props.step)}>
                <text fg={props.theme.text}>-</text>
            </box>
            <box width={width} flexDirection="row">
                <text fg={props.theme.primary}>{"█".repeat(filled)}</text>
                <text fg={props.theme.borderSubtle}>{"░".repeat(width - filled)}</text>
            </box>
            <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme.backgroundElement} onMouseUp={() => set(props.value + props.step)}>
                <text fg={props.theme.text}>+</text>
            </box>
            <box width={12}>
                <text fg={props.theme.text} attributes={TextAttributes.BOLD}>{display}</text>
            </box>
        </box>
    )
}

function BoundaryStatus(props: {
    api: TuiApi
}) {
    const theme = props.api.theme.current
    return (
        <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
            <box width={22}>
                <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                    Boundary pruning
                </text>
            </box>
            <box
                backgroundColor={theme.success}
                paddingLeft={1}
                paddingRight={1}
            >
                <text fg={theme.background}>enabled</text>
            </box>
        </box>
    )
}
