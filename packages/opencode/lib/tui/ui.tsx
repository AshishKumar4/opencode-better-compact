/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core"
import type { JSX } from "solid-js"
import { pct } from "./format"
import type { Theme, ThemeColor, TuiApi } from "./types"

export function BetterCompactFrame(props: {
    api: TuiApi
    title?: string
    eyebrow: string
    children: JSX.Element
    onBack?: () => void
    height?: number
    footer?: JSX.Element
}) {
    const theme = props.api.theme.current
    return (
        <box
            height={props.height}
            overflow={props.height ? "hidden" : undefined}
            flexDirection="column"
            paddingLeft={3}
            paddingRight={3}
            paddingBottom={1}
            gap={1}
        >
            <box flexShrink={0} flexDirection="row" justifyContent="space-between">
                <box flexDirection="column">
                    <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                        {props.eyebrow}
                    </text>
                    {props.title ? (
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                            {props.title}
                        </text>
                    ) : null}
                </box>
                <text fg={theme.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
                    esc
                </text>
            </box>
            <box flexShrink={0} height={1} border={["bottom"]} borderColor={theme.borderSubtle} />
            {props.children}
            {props.footer ?? (
                <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingTop={1}>
                    {props.onBack ? (
                        <DialogButton
                            theme={theme}
                            label="back"
                            variant="muted"
                            onClick={props.onBack}
                        />
                    ) : (
                        <box />
                    )}
                    <DialogButton
                        theme={theme}
                        label="close"
                        variant="primary"
                        onClick={() => props.api.ui.dialog.clear()}
                    />
                </box>
            )}
        </box>
    )
}

export function DialogButton(props: {
    theme: Theme
    label: string
    variant: "muted" | "primary"
    onClick: () => void
}) {
    const primary = props.variant === "primary"
    return (
        <box
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={primary ? props.theme.primary : props.theme.backgroundElement}
            onMouseUp={props.onClick}
        >
            <text fg={primary ? props.theme.selectedListItemText : props.theme.text}>
                {props.label}
            </text>
        </box>
    )
}

export function Card(props: { theme: Theme; title: string; children: JSX.Element; gap?: number }) {
    const accent = props.theme.primary
    return (
        <box
            flexDirection="column"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={props.theme.backgroundElement}
            border={["left"]}
            borderColor={accent}
            gap={props.gap ?? 1}
        >
            <text fg={accent} attributes={TextAttributes.BOLD}>
                {props.title}
            </text>
            {props.children}
        </box>
    )
}

export function Metric(props: { theme: Theme; label: string; value: string; hint?: string }) {
    return (
        <box height={1} flexDirection="row" gap={2} alignItems="center">
            <box width={24}>
                <text fg={props.theme.textMuted}>{props.label}</text>
            </box>
            <box flexDirection="row" gap={1} flexGrow={1}>
                <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
                    {props.value}
                </text>
                {props.hint ? <text fg={props.theme.textMuted}>{props.hint}</text> : null}
            </box>
        </box>
    )
}

export function Progress(props: {
    theme: Theme
    label: string
    value: number
    total: number
    color: ThemeColor
    detail: string
}) {
    const width = 32
    const filled =
        props.total > 0 ? Math.max(0, Math.round((props.value / props.total) * width)) : 0
    const empty = Math.max(0, width - filled)
    return (
        <box flexDirection="column" gap={0}>
            <box flexDirection="row" gap={2}>
                <box width={20}>
                    <text fg={props.theme.text}>{props.label}</text>
                </box>
                <box flexDirection="row" gap={1} flexGrow={1}>
                    <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
                        {pct(props.value, props.total)}
                    </text>
                    <text fg={props.theme.textMuted}>{props.detail}</text>
                </box>
            </box>
            <box flexDirection="row">
                <text fg={props.theme[props.color]}>{"█".repeat(filled)}</text>
                <text fg={props.theme.borderSubtle}>{"░".repeat(empty)}</text>
            </box>
        </box>
    )
}
