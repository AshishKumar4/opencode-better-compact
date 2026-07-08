import type { SessionState, WithParts } from "./types"
import { isMessageWithInfo } from "../messages/shape"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    if (!isMessageWithInfo(msg)) {
        return false
    }

    return msg.info.time.created < state.lastCompaction
}

export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "assistant" && msg.info.summary === true) {
            return msg.info.time.created
        }
    }
    return 0
}

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}

export function resetOnCompaction(state: SessionState): void {
    state.boundary = {
        scratchSessionIds: new Set<string>(),
        job: null,
        activePlan: null,
    }
}
