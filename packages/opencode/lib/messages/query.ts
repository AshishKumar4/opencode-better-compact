import type { WithParts } from "../state"
import { isMessageWithInfo } from "./shape"

export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const start = startIndex ?? messages.length - 1
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (!isMessageWithInfo(msg)) {
            continue
        }
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg
        }
    }
    return null
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    if (!isMessageWithInfo(message)) {
        return false
    }

    if (message.info.role !== "user") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if (!(part as any).ignored) {
            return false
        }
    }

    return true
}
