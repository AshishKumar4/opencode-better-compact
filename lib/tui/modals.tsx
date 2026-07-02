/** @jsxImportSource @opentui/solid */

import { buildStatsReport } from "../commands/stats"
import type { PluginConfig } from "../config"
import {
    buildSessionState,
    loadSessionData,
    loadTuiCompactionSettings,
    logger,
    saveTuiCompactionSettings,
    sessionMessages,
} from "./data"
import { ContextDialog, PanelDialog, ProgressDialog, StatsDialog, StatusDialog } from "./dialogs"
import type { TuiApi } from "./types"

export function showDialog(api: TuiApi, render: () => any) {
    api.ui.dialog.replace(render)
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
        const data = await loadSessionData(api, config)
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
        const data = await loadSessionData(api, config)
        if (!data) {
            showStatusDialog(api, "Stats", "No session", "Open a session first.")
            return
        }
        const report = await buildStatsReport(data.state, logger)
        showDialog(api, () => (
            <StatsDialog api={api} report={report} onBack={() => openPanelModal(api, config)} />
        ))
    })
}

export function openProgressModal(api: TuiApi, config: PluginConfig, sessionID?: string) {
    const loadJob = async () => {
        const data = sessionID ? await loadSessionDataForSession(api, config, sessionID) : await loadSessionData(api, config)
        return data?.state.boundary.job ?? null
    }
    showDialog(api, () => (
        <ProgressDialog
            api={api}
            initialJob={null}
            loadJob={loadJob}
            onBack={() => openPanelModal(api, config)}
        />
    ))
}

export function openPanelModal(api: TuiApi, config: PluginConfig) {
    runModal(api, "Better Compact", async () => {
        const data = await loadSessionData(api, config)
        if (!data) {
            showStatusDialog(api, "Better Compact", "No session", "Open a session first.")
            return
        }
        const settings = loadTuiCompactionSettings(api, config)
        showDialog(api, () => (
            <PanelDialog
                api={api}
                state={data.state}
                config={config}
                settings={settings}
                onSettingsChange={(next) => {
                    saveTuiCompactionSettings(api, next)
                    openPanelModal(api, config)
                }}
                onContext={() => openContextModal(api, config)}
                onStats={() => openStatsModal(api, config)}
            />
        ))
    })
}

async function loadSessionDataForSession(api: TuiApi, config: PluginConfig, sessionID: string) {
    const messages = sessionMessages(api, sessionID)
    const state = await buildSessionState(sessionID, messages, config)
    return { state, messages }
}

function runModal(api: TuiApi, title: string, task: () => Promise<void>) {
    showStatusDialog(api, title, "Better Compact", "Loading...")
    void task().catch((error) => showError(api, title, error))
}
