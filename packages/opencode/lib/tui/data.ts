import {
    getConfig,
    type CompactionConfig,
    type PluginConfig,
} from "../config"
import { normalizeCompactionCustom, normalizePreset } from "@better-compact/core"
import { Logger } from "../logger"
import { filterMessages } from "../messages/shape"
import { createSessionState, type SessionState, type WithParts } from "../state"
import { loadSessionState } from "../state/persistence"
import { findLastCompactionTimestamp } from "../state/utils"
import type { TuiApi } from "./types"

export const logger = new Logger(false)
const SETTINGS_KEY = "better-compact.settings"

export function loadConfig(api: TuiApi): PluginConfig {
    return getConfig({
        client: api.client,
        directory: api.state.path.directory,
        worktree: api.state.path.worktree,
    } as any)
}

export function activeSessionID(api: TuiApi): string | undefined {
    const current = api.route.current
    if (current.name !== "session") return undefined
    const sessionID = current.params?.sessionID
    return typeof sessionID === "string" ? sessionID : undefined
}

export function loadTuiCompactionSettings(api: TuiApi, config: PluginConfig): CompactionConfig {
    const stored = api.kv.get<Partial<CompactionConfig> | undefined>(SETTINGS_KEY, undefined)
    return {
        preset: normalizePreset(stored?.preset ?? config.compaction.preset),
        custom: normalizeCompactionCustom({
            ...config.compaction.custom,
            ...(stored?.custom ?? {}),
        }),
    }
}

export function saveTuiCompactionSettings(api: TuiApi, settings: CompactionConfig): void {
    api.kv.set(SETTINGS_KEY, {
        preset: normalizePreset(settings.preset),
        custom: normalizeCompactionCustom(settings.custom),
    })
}

export function currentContextUsage(api: TuiApi, sessionID: string): { tokens: number; limit: number } {
    const messages = api.state.session.messages(sessionID)
    const last = [...messages].reverse().find((message: any) => message.role === "assistant" && message.tokens?.output > 0) as any
    if (!last) return { tokens: 0, limit: 0 }
    const tokens =
        (last.tokens?.input ?? 0) +
        (last.tokens?.output ?? 0) +
        (last.tokens?.reasoning ?? 0) +
        (last.tokens?.cache?.read ?? 0) +
        (last.tokens?.cache?.write ?? 0)
    const provider = api.state.provider.find((item) => item.id === last.providerID)
    const limit = provider?.models?.[last.modelID]?.limit?.context ?? 0
    return { tokens, limit }
}

export function sessionMessages(api: TuiApi, sessionID: string): WithParts[] {
    const messages = api.state.session.messages(sessionID)
    return filterMessages(
        messages.map((info) => ({
            info,
            parts: api.state.part(info.id),
        })) as unknown as WithParts[],
    )
}

export async function buildSessionState(
    sessionID: string,
    messages: WithParts[],
    config: PluginConfig,
): Promise<SessionState> {
    const state = createSessionState()
    state.sessionId = sessionID
    state.manualMode = config.manualMode.enabled ? "active" : false
    state.lastCompaction = findLastCompactionTimestamp(messages)

    const persisted = await loadSessionState(sessionID, logger)
    if (persisted) {
        if (typeof persisted.manualMode === "boolean") {
            state.manualMode = persisted.manualMode ? "active" : false
        }

        state.boundary.activePlan = persisted.boundary?.activePlan ?? null
        state.boundary.job = persisted.boundary?.job ?? null
    }

    return state
}

export async function loadSessionData(api: TuiApi, config: PluginConfig) {
    const sessionID = activeSessionID(api)
    if (!sessionID) return undefined

    const messages = sessionMessages(api, sessionID)
    const state = await buildSessionState(sessionID, messages, config)
    return { state, messages }
}
