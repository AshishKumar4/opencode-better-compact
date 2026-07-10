import {
    assistantRunsStage,
    contentHashKey,
    keyDeduper,
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

// The /v1/messages wire shapes, structurally typed off the parsed JSON.
// Every field the codec does not model rides along via index signatures and
// re-emits verbatim: decode only rebuilds `content` arrays it changed.
export interface WireMessage {
    role: "user" | "assistant"
    content: string | WireBlock[]
    [key: string]: unknown
}

export interface WireBlock {
    type: string
    [key: string]: unknown
}

type ToolUseBlock = WireBlock & { type: "tool_use"; id: string; name: string; input: unknown }
type ToolResultBlock = WireBlock & { type: "tool_result"; tool_use_id: string }

// One IR tool item owns the tool_use block and its tool_result block from the
// carrier user message that follows: dropping the item removes both natives,
// and the carrier message collapses away entirely when nothing survives in it.
export interface ToolPair {
    use: ToolUseBlock
    result?: { block: ToolResultBlock; carrier: WireMessage }
}

// Marks items whose native block lives in a carrier user message folded into
// an assistant turn, so decode routes survivors back to the right message.
interface CarrierRef {
    carrier: WireMessage
    block: WireBlock
}

const ESTIMATED_IMAGE_CHARS = 4_800

// Anthropic wire messages carry no ids, so identity is a content hash with
// occurrence ordinals (§1.4). cache_control is stripped before hashing:
// clients move cache breakpoints between requests, and a moved marker must
// not read as an edited prefix.
export const anthropicCodec: Codec<WireMessage> = {
    encode(messages) {
        const claimKey = keyDeduper()
        return groupMessages(messages).map((group) => encodeGroup(group, claimKey))
    },

    decode(turns, messages) {
        const output = turns.flatMap(decodeTurn)
        migrateCacheControl(messages, output)
        return output
    },

    estimateTurns(turns) {
        const chars = turns.reduce((sum, turn) => sum + charsOfTurn(turn), 0)
        return Math.max(0, Math.round(chars / 4))
    },

    estimateItem(item) {
        return Math.max(0, Math.round(charsOfToolPair(pairOf(item)) / 4))
    },

    transcriptLine(item) {
        if (item.kind === "synthetic") return item.text
        if (item.kind === "text") return item.text
        if (item.kind === "reasoning") return `[reasoning]\n${reasoningText(item.handle as WireBlock)}`
        if (item.kind === "tool") return formatToolPair(pairOf(item))
        return formatOpaque(item.handle)
    },
}

// Claude Code semantics: skills load through a `Skill` tool_use; todo state is
// a `TodoWrite` tool_use whose input carries the full list. Both verified
// against real ~/.claude/projects transcripts (Skill directly; TodoWrite from
// stock Claude Code — newer builds using TaskCreate/TaskUpdate carry no full
// list in any single call, so there is nothing in-band to preserve for them).
export const claudeCodeConventions: Conventions = {
    isSkillItem: (item) => item.kind === "tool" && pairOf(item).use.name === "Skill",
    todo: {
        isTodoItem: (item) => item.kind === "tool" && pairOf(item).use.name === "TodoWrite",
        format: (item) => (item.kind === "tool" ? formatTodoInput(pairOf(item).use.input) : "todo state unavailable"),
    },
}

export const anthropicSpec: LadderSpec = {
    codec: anthropicCodec,
    conventions: claudeCodeConventions,
    stages: [skillsStage, toolsOldStage, reasoningStage, toolsRemainingStage, assistantRunsStage],
}

// A Turn is one plain user message, or one assistant message plus the user
// message that carries its tool_result blocks. A user message folds into the
// open assistant run only when a result actually answers one of the run's
// tool_use ids — Claude Code packs system-reminder text into the same
// carrier message alongside results, and that rides along; a tool_result
// answering nothing (orphan) stays an ordinary user turn.
function groupMessages(messages: WireMessage[]): WireMessage[][] {
    const groups: WireMessage[][] = []
    let run: WireMessage[] | null = null
    let runCallIds: Set<string> = new Set()
    for (const message of messages) {
        if (message.role === "assistant") {
            run = [message]
            runCallIds = toolUseIds(message)
            groups.push(run)
        } else if (message.role === "user") {
            if (run && answersRun(message, runCallIds)) {
                run.push(message)
            } else {
                groups.push([message])
                run = null
            }
        } else {
            throw new Error(`Unsupported message role: ${String(message.role)}`)
        }
    }
    return groups
}

function toolUseIds(message: WireMessage): Set<string> {
    const ids = new Set<string>()
    if (!Array.isArray(message.content)) return ids
    for (const block of message.content) {
        if (isToolUse(block)) ids.add(block.id)
    }
    return ids
}

function answersRun(message: WireMessage, runCallIds: Set<string>): boolean {
    return (
        Array.isArray(message.content) &&
        message.content.some((block) => isToolResult(block) && runCallIds.has(block.tool_use_id))
    )
}

function encodeGroup(group: WireMessage[], claimKey: (base: string) => string): Turn {
    const first = group[0]
    const key = claimKey(contentHashKey(stripCacheControl(group)))
    const items: Item[] = []
    const pendingCalls = new Map<string, ToolPair>()

    for (const message of group) {
        if (message === first && message.role === "assistant") {
            encodeAssistantContent(message, key, items, pendingCalls, claimKey)
        } else if (message === first) {
            encodeUserContent(message, key, items)
        } else {
            encodeCarrier(message, key, items, pendingCalls)
        }
    }

    return { key, stamp: 0, role: first.role, items, handle: group }
}

function encodeAssistantContent(
    message: WireMessage,
    turnKey: string,
    items: Item[],
    pendingCalls: Map<string, ToolPair>,
    claimKey: (base: string) => string,
): void {
    if (typeof message.content === "string") {
        items.push({ kind: "text", key: `${turnKey}#${items.length}`, text: message.content, handle: message })
        return
    }
    for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
            items.push({ kind: "text", key: `${turnKey}#${items.length}`, text: block.text, handle: block })
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            items.push({ kind: "reasoning", key: `${turnKey}#${items.length}`, handle: block })
        } else if (isToolUse(block)) {
            const pair: ToolPair = { use: block }
            pendingCalls.set(block.id, pair)
            items.push({ kind: "tool", key: claimKey(block.id), callId: block.id, handle: pair })
        } else {
            items.push({ kind: "opaque", key: `${turnKey}#${items.length}`, handle: block })
        }
    }
}

function encodeUserContent(message: WireMessage, turnKey: string, items: Item[]): void {
    if (typeof message.content === "string") {
        items.push({ kind: "text", key: `${turnKey}#${items.length}`, text: message.content, handle: message })
        return
    }
    for (const block of message.content) {
        items.push(
            block.type === "text" && typeof block.text === "string"
                ? { kind: "text", key: `${turnKey}#${items.length}`, text: block.text, handle: block }
                : { kind: "opaque", key: `${turnKey}#${items.length}`, handle: block },
        )
    }
}

// Carrier blocks: tool_result binds into its pending tool item; everything
// else (system-reminder text, orphan results, images) survives as opaque —
// never fed to summaries, always re-emitted verbatim while the turn lives.
function encodeCarrier(
    message: WireMessage,
    turnKey: string,
    items: Item[],
    pendingCalls: Map<string, ToolPair>,
): void {
    if (typeof message.content === "string") {
        items.push({
            kind: "opaque",
            key: `${turnKey}#${items.length}`,
            handle: { carrier: message, block: { type: "text", text: message.content } } satisfies CarrierRef,
        })
        return
    }
    for (const block of message.content) {
        if (isToolResult(block)) {
            const pair = pendingCalls.get(block.tool_use_id)
            if (pair && !pair.result) {
                pair.result = { block, carrier: message }
                continue
            }
        }
        items.push({
            kind: "opaque",
            key: `${turnKey}#${items.length}`,
            handle: { carrier: message, block } satisfies CarrierRef,
        })
    }
}

function decodeTurn(turn: Turn): WireMessage[] {
    const group = turn.handle as WireMessage[] | undefined
    if (!group) return [synthesizeUserMessage(turn)]

    const first = group[0]
    if (first.role === "user" && group.length === 1) return decodeUserMessage(first, turn.items)

    const out: WireMessage[] = []
    const assistant = rebuildAssistant(first, turn.items)
    if (assistant) out.push(assistant)
    for (const carrier of group.slice(1)) {
        const rebuilt = rebuildCarrier(carrier, turn.items)
        if (rebuilt) out.push(rebuilt)
    }
    // An assistant message emptied by pruning with no surviving carriers must
    // vanish entirely: the API rejects empty content arrays.
    return out
}

function decodeUserMessage(message: WireMessage, items: Item[]): WireMessage[] {
    if (typeof message.content === "string") {
        const survives = items.some((item) => item.kind !== "synthetic" && item.handle === message)
        return survives ? [message] : []
    }
    const blocks: WireBlock[] = []
    for (const item of items) {
        if (item.kind === "synthetic") blocks.push({ type: "text", text: item.text })
        else blocks.push(item.handle as WireBlock)
    }
    if (blocks.length === 0) return []
    if (sameBlocks(blocks, message.content)) return [message]
    return [{ ...message, content: blocks }]
}

function rebuildAssistant(message: WireMessage, items: Item[]): WireMessage | null {
    if (typeof message.content === "string") {
        const kept = items.some((item) => item.kind === "text" && item.handle === message)
        const synthetic = syntheticText(items)
        if (kept && !synthetic) return message
        const blocks: WireBlock[] = []
        if (kept) blocks.push({ type: "text", text: message.content })
        if (synthetic) blocks.push({ type: "text", text: synthetic })
        return blocks.length > 0 ? { ...message, content: blocks } : null
    }

    const blocks: WireBlock[] = []
    for (const item of items) {
        if (item.kind === "synthetic") blocks.push({ type: "text", text: item.text })
        else if (item.kind === "tool") blocks.push(pairOf(item).use)
        else if (!isCarrierRef(item.handle)) blocks.push(item.handle as WireBlock)
    }
    if (blocks.length === 0) return null
    if (sameBlocks(blocks, message.content)) return message
    return { ...message, content: blocks }
}

function rebuildCarrier(carrier: WireMessage, items: Item[]): WireMessage | null {
    const survivors = new Set<WireBlock>()
    for (const item of items) {
        if (item.kind === "tool") {
            const result = pairOf(item).result
            if (result && result.carrier === carrier) survivors.add(result.block)
        } else if (item.kind === "opaque" && isCarrierRef(item.handle) && item.handle.carrier === carrier) {
            survivors.add(item.handle.block)
        }
    }
    if (typeof carrier.content === "string") {
        return [...survivors].some((block) => block.type === "text" && block.text === carrier.content)
            ? carrier
            : null
    }
    const blocks = carrier.content.filter((block) => survivors.has(block))
    if (blocks.length === 0) return null
    if (blocks.length === carrier.content.length) return carrier
    return { ...carrier, content: blocks }
}

function synthesizeUserMessage(turn: Turn): WireMessage {
    return { role: "user", content: [{ type: "text", text: syntheticText(turn.items) }] }
}

function syntheticText(items: Item[]): string {
    return items
        .filter((item): item is Extract<Item, { kind: "synthetic" }> => item.kind === "synthetic")
        .map((item) => item.text)
        .filter(Boolean)
        .join("\n\n")
}

// --- cache_control migration ---

// A cache breakpoint on a pruned block migrates to the nearest surviving
// earlier block in output order (synthetic replacements included, priced at
// the position they replaced), so the client's cache-anchoring intent
// survives the rewrite. Targets that already carry a marker keep theirs.
function migrateCacheControl(original: WireMessage[], output: WireMessage[]): void {
    const seqOf = new Map<WireBlock, number>()
    const marked: Array<{ block: WireBlock; seq: number }> = []
    let seq = 0
    for (const message of original) {
        if (typeof message.content === "string") continue
        for (const block of message.content) {
            seqOf.set(block, seq)
            if (block.cache_control !== undefined) marked.push({ block, seq })
            seq++
        }
    }
    if (marked.length === 0) return

    const surviving = new Set<WireBlock>()
    const ordered: Array<{ message: number; index: number; block: WireBlock; effSeq: number }> = []
    let lastSeq = -1
    output.forEach((message, messageIndex) => {
        if (typeof message.content === "string") return
        message.content.forEach((block, blockIndex) => {
            const originalSeq = seqOf.get(block)
            const effSeq = originalSeq !== undefined ? originalSeq : lastSeq + 0.5
            if (originalSeq !== undefined) lastSeq = originalSeq
            surviving.add(block)
            ordered.push({ message: messageIndex, index: blockIndex, block, effSeq })
        })
    })
    if (ordered.length === 0) return

    for (const mark of marked) {
        if (surviving.has(mark.block)) continue
        let target = ordered[0]
        for (const candidate of ordered) {
            if (candidate.effSeq <= mark.seq) target = candidate
            else break
        }
        if (target.block.cache_control !== undefined) continue
        const patched: WireBlock = { ...target.block, cache_control: mark.block.cache_control }
        const message = output[target.message]
        const content = (message.content as WireBlock[]).map((block) => (block === target.block ? patched : block))
        output[target.message] = { ...message, content }
        target.block = patched
        surviving.add(patched)
    }
}

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl)
    if (value && typeof value === "object") {
        const source = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(source)) {
            if (key === "cache_control") continue
            out[key] = stripCacheControl(source[key])
        }
        return out
    }
    return value
}

// --- estimation: chars of content as Anthropic serializes it, /4 ---

function charsOfTurn(turn: Turn): number {
    return turn.items.reduce((sum, item) => sum + charsOfItem(item), 0)
}

function charsOfItem(item: Item): number {
    if (item.kind === "synthetic" || item.kind === "text") return item.text.length
    if (item.kind === "reasoning") {
        const block = item.handle as WireBlock
        if (typeof block.thinking === "string") return block.thinking.length
        if (typeof block.data === "string") return block.data.length
        return jsonLength(block)
    }
    if (item.kind === "tool") return charsOfToolPair(pairOf(item))
    return charsOfOpaque(item.handle)
}

function charsOfToolPair(pair: ToolPair): number {
    let chars = pair.use.name.length + jsonLength(pair.use.input)
    if (pair.result) chars += charsOfBlockContent(pair.result.block.content)
    return chars
}

function charsOfOpaque(handle: unknown): number {
    const block = isCarrierRef(handle) ? handle.block : (handle as WireBlock)
    if (block.type === "text" && typeof block.text === "string") return block.text.length
    if (block.type === "image") return ESTIMATED_IMAGE_CHARS
    if (block.type === "tool_result") return charsOfBlockContent(block.content)
    return jsonLength(block)
}

function charsOfBlockContent(content: unknown): number {
    if (typeof content === "string") return content.length
    if (!Array.isArray(content)) return jsonLength(content)
    return content.reduce<number>(
        (sum, block) =>
            sum +
            (block?.type === "text" && typeof block.text === "string"
                ? block.text.length
                : block?.type === "image"
                  ? ESTIMATED_IMAGE_CHARS
                  : jsonLength(block)),
        0,
    )
}

// --- transcript rendering ---

function formatToolPair(pair: ToolPair): string {
    const result = pair.result?.block
    return [
        `[tool:${pair.use.name}] callId=${pair.use.id}${result?.is_error ? " status=error" : ""}`,
        `input=${previewJson(pair.use.input, 20_000)}`,
        result ? `output=${truncate(blockContentText(result.content), 20_000)}` : "",
    ]
        .filter(Boolean)
        .join("\n")
}

function formatOpaque(handle: unknown): string {
    const block = isCarrierRef(handle) ? handle.block : (handle as WireBlock)
    if (block.type === "text" && typeof block.text === "string") return block.text
    if (block.type === "image") return "[image]"
    if (isToolResult(block)) {
        return `[orphaned tool result] callId=${block.tool_use_id}\n${truncate(blockContentText(block.content), 20_000)}`
    }
    return `[${block.type}] ${previewJson(block, 20_000)}`
}

function blockContentText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return previewJson(content, 20_000)
    return content
        .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : `[${block?.type}]`))
        .filter(Boolean)
        .join("\n")
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
            const entry = todo as { content?: unknown; status?: unknown }
            const content = typeof entry.content === "string" ? entry.content : JSON.stringify(todo)
            const status = typeof entry.status === "string" ? entry.status : "unknown"
            return `${index + 1}. [${status}] ${content}`
        })
        .join("; ")
}

// --- shared helpers ---

function reasoningText(block: WireBlock): string {
    if (typeof block.thinking === "string") return block.thinking
    if (typeof block.data === "string") return `[redacted thinking ${block.data.length} chars]`
    return previewJson(block, 20_000)
}

function isToolUse(block: WireBlock): block is ToolUseBlock {
    return block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
}

function isToolResult(block: WireBlock): block is ToolResultBlock {
    return block.type === "tool_result" && typeof block.tool_use_id === "string"
}

function isCarrierRef(handle: unknown): handle is CarrierRef {
    return typeof handle === "object" && handle !== null && "carrier" in handle && "block" in handle
}

function pairOf(item: Extract<Item, { kind: "tool" }>): ToolPair {
    return item.handle as ToolPair
}

function sameBlocks(blocks: WireBlock[], original: string | WireBlock[]): boolean {
    if (!Array.isArray(original) || blocks.length !== original.length) return false
    return blocks.every((block, index) => block === original[index])
}

function jsonLength(value: unknown): number {
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
