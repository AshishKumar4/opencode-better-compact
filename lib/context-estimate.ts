import type { WithParts } from "./state"
import { COMPACTED_TOOL_OUTPUT_PLACEHOLDER, estimateOpenCodeTokens } from "./token-utils"

type MessagePart = WithParts["parts"][number]

export interface EstimatedContextBreakdown {
    total: number
    user: number
    assistant: number
    reasoning: number
    tools: number
    references: number
    other: number
    toolCount: number
}

export function estimateOpenCodeMessages(messages: WithParts[]): number {
    const modelLike = messages.map(toOpenCodeModelLikeMessage).filter((message) => message.parts.length > 0)
    return estimateOpenCodeTokens(JSON.stringify(modelLike))
}

export function estimateOpenCodeMessage(message: WithParts): number {
    return estimateOpenCodeMessages([message])
}

export function estimateOpenCodeToolPart(part: Extract<MessagePart, { type: "tool" }>): number {
    return estimateOpenCodeTokens(JSON.stringify(toOpenCodeToolPart(part)))
}

export function estimateContextBreakdown(messages: WithParts[]): EstimatedContextBreakdown {
    const breakdown: EstimatedContextBreakdown = {
        total: 0,
        user: 0,
        assistant: 0,
        reasoning: 0,
        tools: 0,
        references: 0,
        other: 0,
        toolCount: 0,
    }

    for (const message of messages) {
        const isReference = isBetterCompactReference(message)
        for (const part of message.parts) {
            const estimate = estimatePart(message, part)
            if (estimate <= 0) continue
            breakdown.total += estimate

            if (isReference) {
                breakdown.references += estimate
                continue
            }
            if (part.type === "tool") {
                breakdown.tools += estimate
                breakdown.toolCount++
                continue
            }
            if (part.type === "reasoning") {
                breakdown.reasoning += estimate
                continue
            }
            if (part.type === "text") {
                if (message.info.role === "user") breakdown.user += estimate
                else if (message.info.role === "assistant") breakdown.assistant += estimate
                else breakdown.other += estimate
                continue
            }
            breakdown.other += estimate
        }
    }

    return breakdown
}

export function toOpenCodeModelLikeMessage(message: WithParts): { id: string; role: string; parts: unknown[] } {
    if (message.info.role === "user") {
        return {
            id: message.info.id,
            role: "user",
            parts: message.parts.flatMap((part): unknown[] => {
                if (part.type === "text" && !(part as any).ignored && part.text !== "") return [{ type: "text", text: part.text }]
                if (part.type === "file") return [{ type: "file", mime: part.mime, filename: part.filename }]
                if (part.type === "compaction") return [{ type: "text", text: "What did we do so far?" }]
                if (part.type === "subtask") return [{ type: "text", text: "The following tool was executed by the user" }]
                return []
            }),
        }
    }

    return {
        id: message.info.id,
        role: message.info.role,
        parts: message.parts.flatMap((part): unknown[] => {
            if (part.type === "text") return [{ type: "text", text: part.text }]
            if (part.type === "reasoning") return [{ type: "reasoning", text: part.text }]
            if (part.type === "tool") return [toOpenCodeToolPart(part)]
            if (part.type === "patch") return [{ type: "patch", files: (part as any).files ?? [] }]
            return [{ type: part.type }]
        }),
    }
}

function estimatePart(message: WithParts, part: MessagePart): number {
    if (message.info.role === "user") {
        const modelLike = toOpenCodeModelLikeMessage({ ...message, parts: [part] })
        return modelLike.parts.length > 0 ? estimateOpenCodeTokens(JSON.stringify(modelLike.parts)) : 0
    }
    if (part.type === "tool") return estimateOpenCodeToolPart(part)
    if (part.type === "text") return estimateOpenCodeTokens(JSON.stringify({ type: "text", text: part.text }))
    if (part.type === "reasoning") return estimateOpenCodeTokens(JSON.stringify({ type: "reasoning", text: part.text }))
    if (part.type === "patch") return estimateOpenCodeTokens(JSON.stringify({ type: "patch", files: (part as any).files ?? [] }))
    return estimateOpenCodeTokens(JSON.stringify({ type: part.type }))
}

function toOpenCodeToolPart(part: Extract<MessagePart, { type: "tool" }>): unknown {
    if (part.state?.status === "completed") {
        return {
            type: `tool-${part.tool}`,
            state: "output-available",
            toolCallId: part.callID,
            input: part.state.input,
            output: part.state.time?.compacted ? COMPACTED_TOOL_OUTPUT_PLACEHOLDER : part.state.output,
        }
    }
    if (part.state?.status === "error") {
        return {
            type: `tool-${part.tool}`,
            state: "output-error",
            toolCallId: part.callID,
            input: part.state.input,
            errorText: part.state.error,
        }
    }
    return {
        type: `tool-${part.tool}`,
        state: part.state?.status ?? "unknown",
        toolCallId: part.callID,
        input: part.state?.input,
    }
}

function isBetterCompactReference(message: WithParts): boolean {
    if (message.info.id.startsWith("msg_better_compact_")) return true
    return message.parts.some(
        (part) => part.type === "text" && /^\[(?:Better Compact|Context Summary)/.test(part.text.trim()),
    )
}
