/** @jsxImportSource @opentui/solid */

import { analyzeContextTokens } from "../commands/context"
import {
    normalizeCompactionCustom,
    resolveCompactionProfile,
    type CompactionConfig,
    type CompactionPreset,
    type SummaryEffort,
} from "../compaction-settings"
import {
    type PluginConfig,
} from "../config"
import type { BoundaryJobProgress, BoundaryJobStage, SessionState, WithParts } from "../state"
import { formatTokenCount } from "../ui/utils"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { formatDuration, formatRatio } from "./format"
import { BetterCompactFrame, Card, DialogButton, Metric, Progress } from "./ui"
import type { StatsReport, Theme, TuiApi } from "./types"

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
    job: BoundaryJobProgress
    now: number
    spinner: string
    onScrollRef?: (ref: { scrollTop: number }) => void
    onBack?: () => void
}) {
    const theme = props.api.theme.current
    const dimensions = useTerminalDimensions()
    const percent = () => props.job.percent
    const elapsed = () => {
        const end = props.job.completedAt ?? props.now
        return formatDuration(Math.max(0, end - props.job.startedAt))
    }
    const frameHeight = () => Math.max(12, Math.floor(dimensions().height / 2) - 1)

    return (
        <BetterCompactFrame
            api={props.api}
            title="Progress"
            eyebrow="Better Compact"
            onBack={props.onBack}
            height={frameHeight()}
        >
            <scrollbox
                flexGrow={1}
                flexShrink={1}
                minHeight={0}
                scrollX={false}
                scrollY={true}
                verticalScrollbarOptions={{ visible: true }}
                horizontalScrollbarOptions={{ visible: false }}
                ref={(ref) => props.onScrollRef?.(ref)}
            >
                <box flexDirection="column" gap={1}>
                    <Card theme={theme} title="Run" gap={0}>
                        <box flexDirection="column" gap={0}>
                            <box height={1} flexDirection="row" justifyContent="space-between">
                                <box flexDirection="row" gap={2} flexGrow={1}>
                                    <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                                        {props.job.status === "running" ? props.spinner : props.job.status === "failed" ? "×" : "✓"}
                                    </text>
                                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                                        {props.job.currentStage}
                                    </text>
                                </box>
                                <text fg={theme.textMuted}>{elapsed()}</text>
                            </box>
                            <Progress
                                theme={theme}
                                label="Overall"
                                value={percent()}
                                total={100}
                                color={props.job.status === "failed" ? "error" : "primary"}
                                detail={`${percent()}%`}
                            />
                            <ContextWindowMeters theme={theme} job={props.job} />
                            {props.job.error ? <text fg={theme.error}>{props.job.error}</text> : null}
                        </box>
                    </Card>

                    <Card theme={theme} title="Stages" gap={0}>
                        <box flexDirection="column" gap={0}>
                            {props.job.stages.map((stage) => (
                                <StageRow theme={theme} stage={stage} spinning={props.spinner} />
                            ))}
                        </box>
                    </Card>

                    <Card theme={theme} title="Live Log">
                        <box flexDirection="column" gap={0}>
                            {props.job.logs.slice(-8).map((line) => (
                                <text fg={theme.textMuted}>{line}</text>
                            ))}
                            {!props.job.logs.length ? <text fg={theme.textMuted}>No log entries yet.</text> : null}
                        </box>
                    </Card>
                </box>
            </scrollbox>
        </BetterCompactFrame>
    )
}

function ContextWindowMeters(props: { theme: Theme; job: BoundaryJobProgress }) {
    const counters = () => props.job.counters
    const limit = () => counters().contextLimit ?? 0
    const before = () => counters().beforeTokens ?? 0
    const current = () => counters().currentTokens ?? before()
    const cleared = () => counters().clearedTokens ?? Math.max(0, before() - current())
    return (
        <box flexDirection="column" gap={0} paddingTop={1}>
            <text fg={props.theme.primary} attributes={TextAttributes.BOLD}>Context window</text>
            {limit() > 0 ? (
                <>
                    <ContextMeterRow theme={props.theme} label="Provider before" tokens={before()} limit={limit()} color="warning" />
                    <ContextMeterRow theme={props.theme} label="Estimated now" tokens={current()} limit={limit()} color="primary" />
                    <box height={1} flexDirection="row" gap={1}>
                        <box width={16}>
                            <text fg={props.theme.textMuted}>Estimated saved:</text>
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
        <box height={1} flexDirection="row" gap={1}>
            <box width={16}>
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
    settings: CompactionConfig
    availableEfforts: Set<SummaryEffort>
    onSettingsChange: (settings: CompactionConfig) => void
    onSave: () => void
    onCancel: () => void
}) {
    const theme = props.api.theme.current
    const dimensions = useTerminalDimensions()
    const profile = () =>
        resolveCompactionProfile({ compaction: props.settings }, props.settings)
    const setPreset = (preset: CompactionPreset) => props.onSettingsChange({ ...props.settings, preset })
    const setCustom = (custom: Partial<CompactionConfig["custom"]>) =>
        props.onSettingsChange({
            ...props.settings,
            preset: "custom",
            custom: normalizeCompactionCustom({ ...props.settings.custom, ...custom }),
        })
    return (
        <BetterCompactFrame
            api={props.api}
            title="Global settings"
            eyebrow="Better Compact"
            height={Math.max(12, Math.floor(dimensions().height / 2) - 1)}
            footer={
                <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingTop={1}>
                    <DialogButton
                        theme={theme}
                        label="cancel"
                        variant="muted"
                        onClick={props.onCancel}
                    />
                    <DialogButton
                        theme={theme}
                        label="save"
                        variant="primary"
                        onClick={props.onSave}
                    />
                </box>
            }
        >
            <scrollbox
                flexGrow={1}
                flexShrink={1}
                minHeight={0}
                scrollX={false}
                scrollY={true}
                verticalScrollbarOptions={{ visible: true }}
                horizontalScrollbarOptions={{ visible: false }}
            >
                <box flexDirection="column" gap={1}>
                    <Card theme={theme} title="Automatic compaction">
                        <ToggleRow
                            theme={theme}
                            label="Run automatically"
                            enabled={props.settings.automatic}
                            onToggle={() =>
                                props.onSettingsChange({
                                    ...props.settings,
                                    automatic: !props.settings.automatic,
                                })
                            }
                        />
                        <text fg={theme.textMuted}>
                            Create a context plan when usage reaches the selected threshold.
                        </text>
                    </Card>

                    <Card theme={theme} title="Compaction strength">
                        <box flexDirection="column" gap={0}>
                            <PresetRow
                                theme={theme}
                                current={props.settings.preset}
                                onSelect={setPreset}
                            />
                            <Metric
                                theme={theme}
                                label="Starts at"
                                value={`${profile().triggerPercent}%`}
                            />
                            <Metric
                                theme={theme}
                                label="Deep summary goal"
                                value={`${profile().targetPercent}%`}
                            />
                            <Metric
                                theme={theme}
                                label="Recent tool output"
                                value={`~${formatTokenCount(profile().recentToolTokens)}`}
                            />
                        </box>
                    </Card>

                    <Card theme={theme} title="Summary effort">
                        <EffortRow
                            theme={theme}
                            current={props.settings.summaryEffort}
                            available={props.availableEfforts}
                            onSelect={(summaryEffort) =>
                                props.onSettingsChange({ ...props.settings, summaryEffort })
                            }
                        />
                        <text fg={theme.textMuted}>
                            Used only when old assistant turns need model-written summaries.
                        </text>
                    </Card>

                    {props.settings.preset === "custom" ? (
                        <Card theme={theme} title="Custom compaction">
                            <box flexDirection="column" gap={0}>
                                <SliderRow
                                    theme={theme}
                                    label="Start at"
                                    value={props.settings.custom.triggerPercent}
                                    min={50}
                                    max={95}
                                    step={5}
                                    suffix="%"
                                    onChange={(value) =>
                                        setCustom({
                                            triggerPercent: Math.max(
                                                value,
                                                props.settings.custom.targetPercent + 5,
                                            ),
                                        })
                                    }
                                />
                                <SliderRow
                                    theme={theme}
                                    label="Deep goal"
                                    value={props.settings.custom.targetPercent}
                                    min={10}
                                    max={60}
                                    step={5}
                                    suffix="%"
                                    onChange={(value) =>
                                        setCustom({
                                            targetPercent: Math.min(
                                                value,
                                                props.settings.custom.triggerPercent - 5,
                                            ),
                                        })
                                    }
                                />
                                <ToolRetentionRow
                                    theme={theme}
                                    value={props.settings.custom.recentToolTokens}
                                    onSelect={(recentToolTokens) => setCustom({ recentToolTokens })}
                                />
                            </box>
                        </Card>
                    ) : null}
                </box>
            </scrollbox>
        </BetterCompactFrame>
    )
}

function PresetRow(props: { theme: Theme; current: CompactionPreset; onSelect: (preset: CompactionPreset) => void }) {
    const presets: Array<{ id: CompactionPreset; label: string }> = [
        { id: "light", label: "gentle" },
        { id: "moderate", label: "balanced" },
        { id: "max", label: "aggressive" },
        { id: "custom", label: "custom" },
    ]
    return (
        <box flexDirection="row" gap={1} paddingBottom={1}>
            {presets.map((preset) => {
                const selected = props.current === preset.id
                return (
                    <box
                        width={12}
                        justifyContent="center"
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={selected ? props.theme.primary : props.theme.backgroundElement}
                        onMouseUp={() => props.onSelect(preset.id)}
                    >
                        <text fg={selected ? props.theme.selectedListItemText : props.theme.text} attributes={selected ? TextAttributes.BOLD : undefined}>
                            {preset.label}
                        </text>
                    </box>
                )
            })}
        </box>
    )
}

function EffortRow(props: {
    theme: Theme
    current: SummaryEffort
    available: Set<SummaryEffort>
    onSelect: (effort: SummaryEffort) => void
}) {
    const efforts: Array<{ id: SummaryEffort; label: string }> = [
        { id: "inherit", label: "model default" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
    ]
    return (
        <box flexDirection="row" gap={1} paddingBottom={1}>
            {efforts.map((effort) => {
                const selected = props.current === effort.id
                const available = props.available.has(effort.id)
                return (
                    <box
                        paddingLeft={1}
                        paddingRight={1}
                        backgroundColor={selected ? props.theme.primary : props.theme.backgroundElement}
                        onMouseUp={() => available && props.onSelect(effort.id)}
                    >
                        <text
                            fg={
                                selected
                                    ? props.theme.selectedListItemText
                                    : available
                                      ? props.theme.text
                                      : props.theme.textMuted
                            }
                            attributes={selected ? TextAttributes.BOLD : undefined}
                        >
                            {effort.label}
                        </text>
                    </box>
                )
            })}
        </box>
    )
}

function ToggleRow(props: {
    theme: Theme
    label: string
    enabled: boolean
    onToggle: () => void
}) {
    return (
        <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.text}>{props.label}</text>
            <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={props.enabled ? props.theme.success : props.theme.backgroundElement}
                onMouseUp={props.onToggle}
            >
                <text fg={props.enabled ? props.theme.background : props.theme.textMuted}>
                    {props.enabled ? "on" : "off"}
                </text>
            </box>
        </box>
    )
}

function ToolRetentionRow(props: {
    theme: Theme
    value: number
    onSelect: (value: number) => void
}) {
    const options = [
        { label: "less", value: 12_000 },
        { label: "standard", value: 30_000 },
        { label: "more", value: 40_000 },
        { label: "most", value: 80_000 },
    ]
    return (
        <box flexDirection="column" gap={0} paddingTop={1}>
            <text fg={props.theme.text}>Keep recent tool output</text>
            <box flexDirection="row" gap={1}>
                {options.map((option) => {
                    const selected = props.value === option.value
                    return (
                        <box
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={selected ? props.theme.primary : props.theme.backgroundElement}
                            onMouseUp={() => props.onSelect(option.value)}
                        >
                            <text
                                fg={selected ? props.theme.selectedListItemText : props.theme.text}
                                attributes={selected ? TextAttributes.BOLD : undefined}
                            >
                                {`${option.label} ${formatTokenCount(option.value)}`}
                            </text>
                        </box>
                    )
                })}
            </box>
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
        <box height={1} flexDirection="row" gap={2} alignItems="center">
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
