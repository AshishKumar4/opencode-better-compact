/** @jsxImportSource @opentui/solid */

import { buildStatsReport } from "../commands/stats"
import {
    hasGlobalCompactionConfig,
    loadGlobalCompactionConfig,
    saveGlobalCompactionConfig,
    type PluginConfig,
} from "../config"
import {
    activeSessionID,
    availableSummaryEfforts,
    loadBoundaryJob,
    loadSessionData,
    loadTuiCompactionSettings,
} from "./data"
import { ContextDialog, PanelDialog, ProgressDialog, StatsDialog, StatusDialog } from "./dialogs"
import type { BoundaryJobProgress } from "../state"
import type { TuiApi } from "./types"

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"]

export function showDialog(api: TuiApi, render: () => any, onClose?: () => void) {
    api.ui.dialog.replace(render, onClose)
    api.ui.dialog.setSize("xlarge")
}

export function showStatusDialog(api: TuiApi, title: string, eyebrow: string, message: string) {
    showDialog(api, () => (
        <StatusDialog api={api} title={title} eyebrow={eyebrow} message={message} />
    ))
}

export function showError(api: TuiApi, title: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    showStatusDialog(api, title, "Better Compact Error", message || "Command failed.")
}

export function openContextModal(api: TuiApi, config: PluginConfig) {
    runModal(api, "Context", async () => {
        const data = await loadSessionData(api)
        if (!data) {
            showStatusDialog(api, "Context", "No session", "Open a session first.")
            return
        }
        showDialog(api, () => (
            <ContextDialog
                api={api}
                state={data.state}
                messages={data.messages}
                onBack={() => openPanelModal(api, config)}
            />
        ))
    })
}

export function openStatsModal(api: TuiApi, config: PluginConfig) {
    runModal(api, "Stats", async () => {
        const data = await loadSessionData(api)
        if (!data) {
            showStatusDialog(api, "Stats", "No session", "Open a session first.")
            return
        }
        const report = buildStatsReport(data.state)
        showDialog(api, () => (
            <StatsDialog api={api} report={report} onBack={() => openPanelModal(api, config)} />
        ))
    })
}

export function openProgressModal(
    api: TuiApi,
    config: PluginConfig,
    initialJob: BoundaryJobProgress,
    options?: {
        loadJob?: () => Promise<BoundaryJobProgress | null>
        intervalMs?: number
    },
) {
    let snapshot = initialJob
    let scrollTop = 0
    let scrollRef: { scrollTop: number } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let replacing = false
    let refreshing = false
    let frame = 0
    let removeDispose = () => {}
    const openedAt = Date.now()

    const terminal = () => snapshot.status === "completed" || snapshot.status === "failed"
    const stop = () => {
        if (stopped) return
        stopped = true
        if (timer) clearTimeout(timer)
        timer = undefined
        const remove = removeDispose
        removeDispose = () => {}
        remove()
    }
    const onClose = () => {
        if (!replacing) stop()
    }
    const draw = () => {
        if (stopped) return
        scrollTop = scrollRef?.scrollTop ?? scrollTop
        replacing = true
        try {
            showDialog(
                api,
                () => (
                    <ProgressDialog
                        api={api}
                        job={snapshot}
                        now={Date.now()}
                        spinner={SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}
                        onScrollRef={(ref) => {
                            scrollRef = ref
                            const restore = scrollTop
                            setTimeout(() => {
                                if (!stopped && scrollRef === ref) ref.scrollTop = restore
                            }, 0)
                        }}
                        onBack={() => openPanelModal(api, config)}
                    />
                ),
                onClose,
            )
        } finally {
            replacing = false
        }
    }
    const schedule = () => {
        if (stopped || terminal()) return
        timer = setTimeout(() => void refresh(), options?.intervalMs ?? 100)
    }
    const refresh = async () => {
        if (stopped || refreshing || terminal()) return
        refreshing = true
        try {
            const next = await (options?.loadJob?.() ?? loadBoundaryJob(initialJob.sessionId))
            // The server enforces one compaction per session, so any job on
            // this session that started around our request IS our run — the
            // server may mint its own id (command-path triggers, protocol
            // drift across plugin versions). Only jobs that predate the
            // request are foreign (stale leftovers from an earlier run).
            const ours =
                !stopped &&
                next != null &&
                next.sessionId === initialJob.sessionId &&
                (next.id === initialJob.id || next.startedAt >= initialJob.startedAt - 10_000)
            if (ours && (next.id !== snapshot.id || next.updatedAt >= snapshot.updatedAt)) {
                snapshot = next
            } else if (!stopped && Date.now() - openedAt >= 5_000) {
                const now = Date.now()
                snapshot = {
                    ...snapshot,
                    status: "failed",
                    currentStage: "No matching server job started",
                    error: "Better Compact did not start this request. Another compaction may already be active.",
                    updatedAt: now,
                    completedAt: now,
                }
            }
            if (!stopped) {
                frame += 1
                draw()
            }
        } finally {
            refreshing = false
            if (terminal()) stop()
            else schedule()
        }
    }

    removeDispose = api.lifecycle.onDispose(stop)
    draw()
    void refresh()
}

export function openPanelModal(api: TuiApi, config: PluginConfig) {
    let settings = hasGlobalCompactionConfig()
        ? loadGlobalCompactionConfig()
        : loadTuiCompactionSettings(api, config)
    const efforts = availableSummaryEfforts(api, activeSessionID(api))
    let closed = false
    let replacing = false

    const onClose = () => {
        if (!replacing) closed = true
    }
    const draw = () => {
        if (closed) return
        replacing = true
        try {
            showDialog(
                api,
                () => (
                    <PanelDialog
                        api={api}
                        settings={settings}
                        availableEfforts={efforts}
                        onSettingsChange={(next) => {
                            settings = next
                            draw()
                        }}
                        onSave={() => {
                            const result = saveGlobalCompactionConfig(settings)
                            if (!result.ok) {
                                showError(api, "Save settings", result.error)
                                return
                            }
                            api.ui.toast({
                                title: "Better Compact",
                                message: "Global settings saved.",
                                variant: "success",
                            })
                            api.ui.dialog.clear()
                        }}
                        onCancel={() => api.ui.dialog.clear()}
                    />
                ),
                onClose,
            )
        } finally {
            replacing = false
        }
    }

    draw()
}

function runModal(api: TuiApi, title: string, task: () => Promise<void>) {
    showStatusDialog(api, title, "Better Compact", "Loading...")
    void task().catch((error) => showError(api, title, error))
}
