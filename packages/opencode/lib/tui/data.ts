import {
    getConfig,
    normalizeCompactionCustom,
    normalizePreset,
    normalizeSummaryEffort,
    type CompactionConfig,
    type PluginConfig,
    type SummaryEffort,
} from "../config"
import { Logger } from "../logger"
import { filterMessages } from "../messages/shape"
import { createSessionState, type BoundaryJobProgress, type SessionState, type WithParts } from "../state"
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
        automatic: stored?.automatic ?? config.compaction.automatic,
        preset: normalizePreset(stored?.preset ?? config.compaction.preset),
        summaryEffort: normalizeSummaryEffort(stored?.summaryEffort ?? config.compaction.summaryEffort),
        custom: normalizeCompactionCustom({
            ...config.compaction.custom,
            ...(stored?.custom ?? {}),
        }),
    }
}

export async function loadBoundaryJob(sessionID: string): Promise<BoundaryJobProgress | null> {
    const persisted = await loadSessionState(sessionID, logger)
    const job = persisted?.boundary?.job
    return job?.sessionId === sessionID ? job : null
}

export function currentContextUsage(api: TuiApi, sessionID: string): {
    tokens: number
    limit: number
    providerID?: string
    modelID?: string
    variant?: string
} {
    const messages = api.state.session.messages(sessionID)
    const last = [...messages].reverse().find((message: any) => message.role === "assistant" && message.tokens?.output > 0) as any
    if (!last) return { tokens: 0, limit: 0 }
    const tokens =
        typeof last.tokens?.total === "number" && Number.isFinite(last.tokens.total)
            ? last.tokens.total
            : (last.tokens?.input ?? 0) +
              (last.tokens?.output ?? 0) +
              (last.tokens?.reasoning ?? 0) +
              (last.tokens?.cache?.read ?? 0) +
              (last.tokens?.cache?.write ?? 0)
    const active = activeSessionModel(api, sessionID)
    const providerID = active?.providerID ?? last.providerID
    const modelID = active?.modelID ?? last.modelID
    const provider = api.state.provider.find((item) => item.id === providerID)
    const limit = provider?.models?.[modelID]?.limit?.context ?? 0
    return { tokens, limit, providerID, modelID, variant: active?.variant }
}

export function availableSummaryEfforts(api: TuiApi, sessionID: string | undefined): Set<SummaryEffort> {
    const available = new Set<SummaryEffort>(["inherit"])
    if (!sessionID) return available
    const active = activeSessionModel(api, sessionID)
    if (!active) return available
    const provider = api.state.provider.find((item) => item.id === active?.providerID)
    const model = provider?.models?.[active.modelID] as unknown as { variants?: Record<string, unknown> } | undefined
    const variants = new Set(Object.keys(model?.variants ?? {}))
    if (variants.has("low")) available.add("low")
    if (variants.has("medium")) available.add("medium")
    if (variants.has("high")) available.add("high")
    if (variants.has("max") || variants.has("xhigh")) available.add("max")
    return available
}

export function resolveSummaryVariant(
    api: TuiApi,
    sessionID: string,
    effort: SummaryEffort,
): string | undefined {
    if (effort === "inherit") return undefined
    const active = activeSessionModel(api, sessionID)
    if (!active) return undefined
    const provider = api.state.provider.find((item) => item.id === active?.providerID)
    const model = provider?.models?.[active.modelID] as unknown as { variants?: Record<string, unknown> } | undefined
    const variants = new Set(Object.keys(model?.variants ?? {}))
    const candidates = effort === "max" ? ["max", "xhigh"] : [effort]
    return candidates.find((candidate) => variants.has(candidate))
}

function activeSessionModel(
    api: TuiApi,
    sessionID: string,
): { providerID: string; modelID: string; variant?: string } | undefined {
    const session = api.state.session.get(sessionID) as unknown as {
        model?: { id?: string; modelID?: string; providerID?: string; variant?: string }
    } | undefined
    const providerID = session?.model?.providerID
    const modelID = session?.model?.id ?? session?.model?.modelID
    if (typeof providerID === "string" && typeof modelID === "string") {
        return {
            providerID,
            modelID,
            variant: typeof session?.model?.variant === "string" ? session.model.variant : undefined,
        }
    }

    const messages = api.state.session.messages(sessionID)
    const last = [...messages].reverse().find((message: any) => message.role === "assistant" && message.modelID) as any
    return last
        ? { providerID: last.providerID, modelID: last.modelID }
        : undefined
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
