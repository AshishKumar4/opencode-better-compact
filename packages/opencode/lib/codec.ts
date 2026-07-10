import {
    assistantRunsStage,
    reasoningStage,
    skillsStage,
    toolsOldStage,
    toolsRemainingStage,
    truncate,
    type Codec,
    type Conventions,
    type Item,
    type LadderSpec,
    type Turn,
} from "@better-compact/core"
import { estimateOpenCodeMessages, estimateOpenCodeToolPart } from "./context-estimate"
import type { WithParts } from "./state"

type MessagePart = WithParts["parts"][number]
type ToolPart = Extract<MessagePart, { type: "tool" }>

// The codec is the single trust boundary for handles: it created every
// handle during encode, so narrowing them back is sound by construction.
function partOf(item: Exclude<Item, { kind: "synthetic" }>): MessagePart {
    return item.handle as MessagePart
}

function toolPartOf(item: Extract<Item, { kind: "tool" }>): ToolPart {
    return item.handle as ToolPart
}

function messageOf(turn: Turn): WithParts {
    return turn.handle as WithParts
}

export const openCodeCodec: Codec<WithParts> = {
    encode(messages) {
        return messages.map((message) => ({
            key: message.info.id,
            stamp: message.info.time.created,
            role: message.info.role,
            ephemeral: isIgnoredNotification(message),
            handle: message,
            items: message.parts.map(encodePart),
        }))
    },

    decode(turns, messages) {
        return turns.map((turn) => (turn.handle ? decodeNativeTurn(turn) : decodeSyntheticTurn(turn, messages)))
    },

    estimateTurns(turns) {
        return estimateOpenCodeMessages(turns.map(estimableMessage))
    },

    estimateItem(item) {
        return estimateOpenCodeToolPart(toolPartOf(item))
    },

    transcriptLine(item) {
        if (item.kind === "synthetic") return item.text
        return formatPart(partOf(item))
    },

    // Raw JSON keeps the transcript lossless: previews truncate long tool
    // payloads, and the transcript exists precisely for exact recall.
    transcriptDocument(turns) {
        const messages = turns.filter((turn) => turn.handle).map(messageOf)
        return [
            "# Better Compact Raw Transcript",
            "",
            "```json",
            JSON.stringify(messages, null, 2),
            "```",
            "",
        ].join("\n")
    },
}

export const openCodeConventions: Conventions = {
    isSkillItem: (item) => item.kind === "tool" && toolPartOf(item).tool === "skill",
    todo: {
        isTodoItem: (item) => item.kind === "tool" && toolPartOf(item).tool === "todowrite",
        format: (item) =>
            item.kind === "tool" ? formatTodoInput(toolPartOf(item).state?.input) : "todo state unavailable",
    },
    itemNote: (item) => {
        if (item.kind !== "opaque") return null
        const part = partOf(item)
        if (part.type !== "patch") return null
        const files = Array.isArray((part as { files?: unknown }).files)
            ? ((part as { files: unknown[] }).files as string[]).join(", ")
            : "unknown files"
        return `Patch recorded: ${files}`
    },
}

export const openCodeSpec: LadderSpec = {
    codec: openCodeCodec,
    conventions: openCodeConventions,
    stages: [skillsStage, toolsOldStage, reasoningStage, toolsRemainingStage, assistantRunsStage],
}

export function sessionKeyOf(messages: WithParts[]): string {
    return messages[0]?.info.sessionID ?? "unknown-session"
}

// Better Compact's own reports and similar plugin notifications are user
// messages whose parts are all `ignored: true`; they carry no user intent.
function isIgnoredNotification(message: WithParts): boolean {
    return (
        message.info.role === "user" &&
        message.parts.length > 0 &&
        message.parts.every((part) => "ignored" in part && part.ignored === true)
    )
}

function encodePart(part: MessagePart): Item {
    switch (part.type) {
        case "text":
            return { kind: "text", key: part.id, text: part.text, handle: part }
        case "reasoning":
            return { kind: "reasoning", key: part.id, handle: part }
        case "tool":
            return { kind: "tool", key: part.id, callId: part.callID, handle: part }
        default:
            return { kind: "opaque", key: part.id, handle: part }
    }
}

function decodeNativeTurn(turn: Turn): WithParts {
    const message = messageOf(turn)
    return {
        info: message.info,
        parts: turn.items.map((item) =>
            item.kind === "synthetic" ? (syntheticTextPart(item, turn.key, message.info.sessionID) as MessagePart) : partOf(item),
        ),
    }
}

function decodeSyntheticTurn(turn: Turn, messages: WithParts[]): WithParts {
    const base = messages.find((message) => message.info.role === "user") ?? messages[0]
    if (!base) throw new Error("Cannot decode a synthetic turn without a base message")
    const item = turn.items[0]
    const text = item?.kind === "synthetic" ? item.text : ""
    return {
        info: {
            ...base.info,
            id: `msg_${turn.key}`,
            role: "user" as const,
        },
        parts: [
            {
                id: `prt_${turn.key}`,
                messageID: `msg_${turn.key}`,
                sessionID: base.info.sessionID,
                type: "text" as const,
                synthetic: true,
                text,
            },
        ],
    } as WithParts
}

function syntheticTextPart(item: Extract<Item, { kind: "synthetic" }>, messageId: string, sessionId: string) {
    return {
        id: item.key,
        messageID: messageId,
        sessionID: sessionId,
        type: "text" as const,
        text: item.text,
    }
}

// A WithParts view of a turn priced exactly as OpenCode would serialize it.
// Synthetic items become bare text parts; ladder-synthesized turns only need
// a role, which is all the model-shape mapping reads from info.
function estimableMessage(turn: Turn): WithParts {
    const info = turn.handle ? messageOf(turn).info : ({ role: turn.role } as WithParts["info"])
    return {
        info,
        parts: turn.items.map((item) =>
            item.kind === "synthetic" ? ({ type: "text", text: item.text } as MessagePart) : partOf(item),
        ),
    }
}

function formatPart(part: MessagePart): string {
    if (part.type === "text") return part.text
    if (part.type === "reasoning") return `[reasoning]\n${part.text}`
    if (part.type === "tool") {
        return [
            `[tool:${part.tool}] callID=${part.callID} status=${part.state?.status}`,
            `input=${previewJson(part.state?.input, 20_000)}`,
            part.state?.status === "completed" ? `output=${part.state.output}` : "",
            part.state?.status === "error" ? `error=${part.state.error}` : "",
        ]
            .filter(Boolean)
            .join("\n")
    }
    return `[${part.type}] ${previewJson(part, 20_000)}`
}

function formatTodoInput(input: unknown): string {
    if (!input || typeof input !== "object" || !Array.isArray((input as { todos?: unknown }).todos)) {
        return previewJson(input, 480) || "todo state unavailable"
    }
    const todos = (input as { todos: unknown[] }).todos
    if (todos.length === 0) return "no todos"
    return todos
        .map((todo, index) => {
            if (!todo || typeof todo !== "object") return `${index + 1}. ${String(todo)}`
            const item = todo as { content?: unknown; status?: unknown; priority?: unknown }
            const content = typeof item.content === "string" ? item.content : JSON.stringify(todo)
            const status = typeof item.status === "string" ? item.status : "unknown"
            const priority = typeof item.priority === "string" ? item.priority : "unknown"
            return `${index + 1}. [${status}/${priority}] ${content}`
        })
        .join("; ")
}

function previewJson(value: unknown, maxChars: number): string {
    if (value === undefined) return ""
    try {
        return truncate(typeof value === "string" ? value : JSON.stringify(value), maxChars)
    } catch {
        return truncate(String(value), maxChars)
    }
}
