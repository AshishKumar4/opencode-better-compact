import {
    assistantRunsStage,
    contentHashKey,
    keyDeduper,
    purgeErrorInputsStage,
    reasoningStage,
    supersedeReadsStage,
    toolsOldStage,
    toolsRemainingStage,
    truncate,
    type Codec,
    type Conventions,
    type Item,
    type LadderSpec,
    type Turn,
} from "@better-compact/core"

// The Responses API `input` array is a flat Vec<ResponseItem>, each tagged by
// `type`. We structurally type off the parsed JSON: every field the codec does
// not model rides along on the index signature and re-emits verbatim, because
// decode emits surviving native items by reference and only synthesizes what
// the ladder changed.
export interface ResponseItemWire {
    type: string
    [key: string]: unknown
}

interface MessageItem extends ResponseItemWire {
    type: "message"
    role: string
    content: unknown
}
interface ReasoningItem extends ResponseItemWire {
    type: "reasoning"
}
interface FunctionCallItem extends ResponseItemWire {
    type: "function_call"
    call_id: string
    name?: string
}
interface FunctionCallOutputItem extends ResponseItemWire {
    type: "function_call_output"
    call_id: string
    output?: unknown
}

// One IR tool item owns a function_call, its paired function_call_output, and
// the reasoning items that immediately preceded the call. Dropping the item
// removes all of them, so the encrypted-reasoning-continuity invariant (a
// reasoning item's produced call must survive with it) holds structurally.
export interface CallPair {
    callId: string
    call: FunctionCallItem
    output?: FunctionCallOutputItem
    reasoning: ReasoningItem[]
}

const ESTIMATED_IMAGE_CHARS = 4_800

export const openaiCodec: Codec<ResponseItemWire> = {
    encode(input) {
        const claimKey = keyDeduper()
        return groupItems(input).map((group) => encodeGroup(group, claimKey))
    },

    decode(turns) {
        return turns.flatMap(decodeTurn)
    },

    estimateTurns(turns) {
        const chars = turns.reduce((sum, turn) => sum + charsOfTurn(turn), 0)
        return Math.max(0, Math.round(chars / 4))
    },

    estimateItem(item) {
        return Math.max(0, Math.round(charsOfCallPair(pairOf(item)) / 4))
    },

    transcriptLine(item) {
        if (item.kind === "synthetic" || item.kind === "text") return item.text
        if (item.kind === "reasoning")
            return `[reasoning]\n${reasoningText(item.handle as ReasoningItem)}`
        if (item.kind === "tool") return formatCallPair(pairOf(item))
        return formatOpaque(item.handle as ResponseItemWire)
    },
}

// Codex has neither a Skill tool nor an in-band todo list, so its ladder omits
// the skills stage and the todo convention (architecture §1.2, §5).
export const codexConventions: Conventions = {
    tool: (item) => {
        const pair = pairOf(item)
        return {
            name: pair.call.name ?? "function",
            input: pair.call.arguments,
            error: callError(pair.output),
        }
    },
}

export const openaiSpec: LadderSpec = {
    codec: openaiCodec,
    conventions: codexConventions,
    stages: [
        supersedeReadsStage,
        purgeErrorInputsStage,
        toolsOldStage,
        reasoningStage,
        toolsRemainingStage,
        assistantRunsStage,
    ],
}

export function stripOpenAIManualTrigger(input: ResponseItemWire[], marker: string): boolean {
    const message = input.findLast(isUserMessage)
    if (!message) return false
    if (typeof message.content === "string") {
        if (!message.content.includes(marker)) return false
        message.content = message.content.replaceAll(marker, "")
        return true
    }
    if (!Array.isArray(message.content)) return false
    const part = message.content.findLast(
        (candidate) => candidate?.type === "input_text" && typeof candidate.text === "string",
    )
    if (!part || !part.text.includes(marker)) return false
    part.text = part.text.replaceAll(marker, "")
    return true
}

// A Turn is a role-run over the flat item array: consecutive user `message`
// items form a user turn; everything else (reasoning, function calls and their
// outputs, assistant/developer messages, unknown items) forms an assistant
// turn. function_call_output carries no role and folds into the assistant turn
// that owns its call — the codec pairs them into one IR tool item.
function groupItems(input: ResponseItemWire[]): ResponseItemWire[][] {
    const groups: ResponseItemWire[][] = []
    let current: ResponseItemWire[] | null = null
    let currentRole: "user" | "assistant" | null = null
    for (const item of input) {
        const role = isUserMessage(item) ? "user" : "assistant"
        if (!current || role !== currentRole) {
            current = [item]
            currentRole = role
            groups.push(current)
        } else {
            current.push(item)
        }
    }
    return groups
}

function encodeGroup(group: ResponseItemWire[], claimKey: (base: string) => string): Turn {
    const role = isUserMessage(group[0]) ? "user" : "assistant"
    const key = claimKey(contentHashKey(group))
    const items: Item[] = []

    if (role === "user") {
        for (const message of group) {
            items.push(textItem(message, key, items.length))
        }
        return { key, stamp: 0, role, items, handle: group }
    }

    const pendingCalls = new Map<string, CallPair>()
    let pendingReasoning: ReasoningItem[] = []
    const flushReasoning = () => {
        for (const reasoning of pendingReasoning) {
            items.push({ kind: "reasoning", key: `${key}#${items.length}`, handle: reasoning })
        }
        pendingReasoning = []
    }

    for (const native of group) {
        if (isReasoning(native)) {
            pendingReasoning.push(native)
        } else if (isFunctionCall(native)) {
            const pair: CallPair = {
                callId: native.call_id,
                call: native,
                reasoning: pendingReasoning,
            }
            pendingReasoning = []
            pendingCalls.set(native.call_id, pair)
            items.push({
                kind: "tool",
                key: claimKey(native.call_id),
                callId: native.call_id,
                handle: pair,
            })
        } else if (isFunctionCallOutput(native)) {
            const pair = pendingCalls.get(native.call_id)
            if (pair && !pair.output) {
                pair.output = native
                continue
            }
            flushReasoning()
            items.push({ kind: "opaque", key: `${key}#${items.length}`, handle: native })
        } else if (isAssistantMessage(native)) {
            flushReasoning()
            items.push(textItem(native, key, items.length))
        } else {
            flushReasoning()
            items.push({ kind: "opaque", key: `${key}#${items.length}`, handle: native })
        }
    }
    flushReasoning()

    return { key, stamp: 0, role, items, handle: group }
}

function textItem(message: ResponseItemWire, turnKey: string, index: number): Item {
    return { kind: "text", key: `${turnKey}#${index}`, text: messageText(message), handle: message }
}

// Decode emits the turn's original native items in order, keeping only those
// whose IR item survived pruning, then appends any ladder-synthesized text as a
// native message. Native order is preserved verbatim on the empty plan, so
// decode(encode(x)) is value-identical to x (including batched parallel
// function_call/function_call_output ordering).
function decodeTurn(turn: Turn): ResponseItemWire[] {
    const natives = turn.handle as ResponseItemWire[] | undefined
    const synthetics = turn.items
        .filter((item): item is Extract<Item, { kind: "synthetic" }> => item.kind === "synthetic")
        .map((item) => syntheticMessage(turn.role, item.text))
    if (!natives) return synthetics

    const survivingCallIds = new Set<string>()
    const survivingReasoning = new Set<ReasoningItem>()
    const survivingHandles = new Set<ResponseItemWire>()
    for (const item of turn.items) {
        if (item.kind === "tool") {
            const pair = pairOf(item)
            survivingCallIds.add(pair.callId)
            for (const reasoning of pair.reasoning) survivingReasoning.add(reasoning)
        } else if (item.kind === "reasoning") {
            survivingReasoning.add(item.handle as ReasoningItem)
        } else if (item.kind === "text" || item.kind === "opaque") {
            survivingHandles.add(item.handle as ResponseItemWire)
        }
    }

    const out: ResponseItemWire[] = []
    for (const native of natives) {
        if (isFunctionCall(native)) {
            if (survivingCallIds.has(native.call_id)) out.push(native)
        } else if (isFunctionCallOutput(native)) {
            if (survivingCallIds.has(native.call_id) || survivingHandles.has(native))
                out.push(native)
        } else if (isReasoning(native)) {
            if (survivingReasoning.has(native)) out.push(native)
        } else if (survivingHandles.has(native)) {
            out.push(native)
        }
    }
    out.push(...synthetics)
    return out
}

// §1.3: a synthetic renders as the smallest valid native message — user-role
// injections (reference/summary turns) as input_text, in-turn assistant
// markers as output_text.
function syntheticMessage(role: "user" | "assistant", text: string): ResponseItemWire {
    return {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    }
}

// --- estimation: chars of the item as the Responses API serializes it, /4 ---

function charsOfTurn(turn: Turn): number {
    return turn.items.reduce((sum, item) => sum + charsOfItem(item), 0)
}

function charsOfItem(item: Item): number {
    if (item.kind === "synthetic") return item.text.length
    if (item.kind === "text") return messageChars(item.handle as ResponseItemWire)
    if (item.kind === "reasoning") return charsOfReasoning(item.handle as ReasoningItem)
    if (item.kind === "tool") return charsOfCallPair(pairOf(item))
    return charsOfOpaque(item.handle as ResponseItemWire)
}

function charsOfCallPair(pair: CallPair): number {
    let chars =
        (pair.call.name ? String(pair.call.name).length : 0) + jsonLength(pair.call.arguments)
    for (const reasoning of pair.reasoning) chars += charsOfReasoning(reasoning)
    if (pair.output) chars += outputChars(pair.output.output)
    return chars
}

function charsOfReasoning(item: ReasoningItem): number {
    const encrypted = item.encrypted_content
    if (typeof encrypted === "string") return encrypted.length
    return reasoningText(item).length
}

function charsOfOpaque(item: ResponseItemWire): number {
    if (isMessage(item)) return messageChars(item)
    if (isFunctionCallOutput(item)) return outputChars(item.output)
    return jsonLength(item)
}

function messageChars(message: ResponseItemWire): number {
    const content = (message as MessageItem).content
    if (typeof content === "string") return content.length
    if (!Array.isArray(content)) return jsonLength(content)
    return content.reduce<number>((sum, part) => {
        if (part?.type === "input_text" || part?.type === "output_text") {
            return sum + (typeof part.text === "string" ? part.text.length : 0)
        }
        if (part?.type === "input_image") return sum + ESTIMATED_IMAGE_CHARS
        return sum + jsonLength(part)
    }, 0)
}

// function_call_output.output is a bare string on the wire, or an array of
// structured content items (verified: FunctionCallOutputPayload serializes as
// str | content_items).
function outputChars(output: unknown): number {
    if (typeof output === "string") return output.length
    if (!Array.isArray(output)) return jsonLength(output)
    return output.reduce<number>(
        (sum, part) => sum + (typeof part?.text === "string" ? part.text.length : jsonLength(part)),
        0,
    )
}

// --- transcript rendering ---

function formatCallPair(pair: CallPair): string {
    const lines: string[] = []
    for (const reasoning of pair.reasoning) lines.push(`[reasoning]\n${reasoningText(reasoning)}`)
    lines.push(`[tool:${pair.call.name ?? "function"}] callId=${pair.callId}`)
    lines.push(`input=${previewJson(pair.call.arguments, 20_000)}`)
    if (pair.output) lines.push(`output=${truncate(outputText(pair.output.output), 20_000)}`)
    return lines.filter(Boolean).join("\n")
}

function formatOpaque(item: ResponseItemWire): string {
    if (isMessage(item)) return messageText(item)
    if (isFunctionCallOutput(item)) {
        return `[orphaned function_call_output] callId=${item.call_id}\n${truncate(outputText(item.output), 20_000)}`
    }
    return `[${item.type}] ${previewJson(item, 20_000)}`
}

function messageText(message: ResponseItemWire): string {
    const content = (message as MessageItem).content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    return content
        .map((part) =>
            part?.type === "input_text" || part?.type === "output_text"
                ? typeof part.text === "string"
                    ? part.text
                    : ""
                : part?.type === "input_image"
                  ? "[image]"
                  : "",
        )
        .filter(Boolean)
        .join("\n")
}

function reasoningText(item: ReasoningItem): string {
    const parts: string[] = []
    for (const field of [item.summary, item.content]) {
        if (!Array.isArray(field)) continue
        for (const entry of field) {
            if (entry && typeof entry.text === "string") parts.push(entry.text)
        }
    }
    if (parts.length > 0) return parts.join("\n")
    if (typeof item.encrypted_content === "string") {
        return `[encrypted reasoning ${item.encrypted_content.length} chars]`
    }
    return previewJson(item, 20_000)
}

function outputText(output: unknown): string {
    if (typeof output === "string") return output
    if (!Array.isArray(output)) return previewJson(output, 20_000)
    return output
        .map((part) => (typeof part?.text === "string" ? part.text : `[${part?.type}]`))
        .filter(Boolean)
        .join("\n")
}

function callError(output: FunctionCallOutputItem | undefined): string | undefined {
    if (!output) return undefined
    if (output.status === "failed" || output.status === "error") return outputText(output.output)
    const value = parseOutput(output.output)
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const error = (value as { error?: unknown }).error
    if (typeof error === "string") return error
    const metadata = (value as { metadata?: unknown }).metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
    const exitCode = (metadata as { exit_code?: unknown }).exit_code
    if (typeof exitCode !== "number" || exitCode === 0) return undefined
    const text = (value as { output?: unknown }).output
    return typeof text === "string" ? text : outputText(output.output)
}

function parseOutput(output: unknown): unknown {
    if (typeof output !== "string") return output
    try {
        return JSON.parse(output)
    } catch {
        return output
    }
}

// --- guards & helpers ---

function isMessage(item: ResponseItemWire): item is MessageItem {
    return item.type === "message"
}

function isUserMessage(item: ResponseItemWire): item is MessageItem {
    return isMessage(item) && (item as MessageItem).role === "user"
}

function isAssistantMessage(item: ResponseItemWire): boolean {
    return isMessage(item) && (item as MessageItem).role === "assistant"
}

function isReasoning(item: ResponseItemWire): item is ReasoningItem {
    return item.type === "reasoning"
}

function isFunctionCall(item: ResponseItemWire): item is FunctionCallItem {
    return item.type === "function_call" && typeof item.call_id === "string"
}

function isFunctionCallOutput(item: ResponseItemWire): item is FunctionCallOutputItem {
    return item.type === "function_call_output" && typeof item.call_id === "string"
}

function pairOf(item: Extract<Item, { kind: "tool" }>): CallPair {
    return item.handle as CallPair
}

function jsonLength(value: unknown): number {
    if (typeof value === "string") return value.length
    try {
        return JSON.stringify(value)?.length ?? 0
    } catch {
        return String(value).length
    }
}

function previewJson(value: unknown, maxChars: number): string {
    if (value === undefined) return ""
    try {
        return truncate(typeof value === "string" ? value : JSON.stringify(value), maxChars)
    } catch {
        return truncate(String(value), maxChars)
    }
}
