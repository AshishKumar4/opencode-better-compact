import assert from "node:assert/strict"
import test from "node:test"
import type { Item, Turn } from "@better-compact/core"
import { piCodec, type PiMessage, type ToolPair } from "../src/codec"
import {
    assistantMessage,
    kitchenSinkConversation,
    toolResultMessage,
    userMessage,
} from "./fixtures"

function roundTrip(messages: PiMessage[]): PiMessage[] {
    return piCodec.decode(piCodec.encode(messages), messages)
}

function toolItems(turn: Turn): Extract<Item, { kind: "tool" }>[] {
    return turn.items.filter(
        (item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool",
    )
}

test("round-trip is identity on every message kind", () => {
    const messages = kitchenSinkConversation()
    assert.deepEqual(roundTrip(messages), messages)
})

test("round-trip preserves string and block user content verbatim", () => {
    const messages: PiMessage[] = [
        userMessage("plain string"),
        userMessage([
            { type: "text", text: "with blocks" },
            { type: "image", data: "aWs=", mimeType: "image/png" },
        ]),
    ]
    const decoded = roundTrip(messages)
    assert.deepEqual(decoded, messages)
    assert.equal(decoded[0], messages[0])
    assert.equal(decoded[1], messages[1])
})

test("round-trip survives injected vendor junk fields", () => {
    const messages = kitchenSinkConversation().map(
        (message, index) =>
            ({ ...message, vendorJunk: { index, nested: [1, "two"] } }) as unknown as PiMessage,
    )
    assert.deepEqual(roundTrip(messages), messages)
})

test("tool call and its result message live in one IR item", () => {
    const messages: PiMessage[] = [
        userMessage("run it"),
        assistantMessage([
            { type: "toolCall", id: "call_9", name: "bash", arguments: { command: "make" } },
        ]),
        toolResultMessage("call_9", "built"),
    ]
    const turns = piCodec.encode(messages)
    assert.equal(turns.length, 2)
    const tools = toolItems(turns[1])
    assert.equal(tools.length, 1)
    assert.equal(tools[0].callId, "call_9")
    const pair = tools[0].handle as ToolPair
    assert.equal(pair.call, (messages[1] as Extract<PiMessage, { role: "assistant" }>).content[0])
    assert.equal(pair.result, messages[2])
})

test("dropping a tool item removes both the call block and the result message", () => {
    const messages: PiMessage[] = [
        userMessage("run it"),
        assistantMessage([
            { type: "text", text: "running" },
            { type: "toolCall", id: "call_9", name: "bash", arguments: { command: "make" } },
        ]),
        toolResultMessage("call_9", "built"),
    ]
    const turns = piCodec.encode(messages)
    turns[1].items = turns[1].items.filter((item) => item.kind !== "tool")
    const decoded = piCodec.decode(turns, messages)
    assert.equal(decoded.length, 2)
    const assistant = decoded[1] as Extract<PiMessage, { role: "assistant" }>
    assert.deepEqual(assistant.content, [{ type: "text", text: "running" }])
    assert.ok(!decoded.some((message) => message.role === "toolResult"))
})

test("an orphaned tool result survives as an opaque item", () => {
    const messages: PiMessage[] = [
        userMessage("hello"),
        assistantMessage([{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }]),
        toolResultMessage("call_1", "paired"),
        toolResultMessage("call_ghost", "orphan"),
    ]
    const turns = piCodec.encode(messages)
    assert.equal(toolItems(turns[1]).length, 1)
    assert.ok(turns[1].items.some((item) => item.kind === "opaque" && item.handle === messages[3]))

    // Stripping the paired tool item leaves the orphan untouched.
    turns[1].items = turns[1].items.filter((item) => item.kind !== "tool")
    const decoded = piCodec.decode(turns, messages)
    assert.deepEqual(decoded.at(-1), messages[3])
    assert.ok(
        !decoded.some(
            (message) => message.role === "toolResult" && message.toolCallId === "call_1",
        ),
    )
})

test("a call without a result drops cleanly with its tool item", () => {
    const messages: PiMessage[] = [
        userMessage("go"),
        assistantMessage([
            { type: "toolCall", id: "call_unfinished", name: "bash", arguments: {} },
        ]),
    ]
    assert.deepEqual(roundTrip(messages), messages)
    const turns = piCodec.encode(messages)
    turns[1].items = []
    const decoded = piCodec.decode(turns, messages)
    assert.deepEqual((decoded[1] as Extract<PiMessage, { role: "assistant" }>).content, [])
})

test("synthetic items decode into the assistant message content", () => {
    const messages: PiMessage[] = [
        userMessage("go"),
        assistantMessage([{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }]),
        toolResultMessage("call_1", "output"),
    ]
    const turns = piCodec.encode(messages)
    turns[1].items = [{ kind: "synthetic", key: "s1", text: "[tool calls/results cleared]" }]
    const decoded = piCodec.decode(turns, messages)
    assert.equal(decoded.length, 2)
    const assistant = decoded[1] as Extract<PiMessage, { role: "assistant" }>
    assert.deepEqual(assistant.content, [{ type: "text", text: "[tool calls/results cleared]" }])
})

test("a collapsed headless run re-emits its synthetic text as a user message", () => {
    const custom = {
        role: "custom",
        customType: "x",
        content: "note",
        display: false,
        timestamp: 4_000,
    } as PiMessage
    const messages: PiMessage[] = [userMessage("a"), custom, userMessage("b")]
    const turns = piCodec.encode(messages)
    assert.equal(turns[1].role, "assistant")
    turns[1].items = [{ kind: "synthetic", key: "s1", text: "[Assistant turn summary]\ncollapsed" }]
    const decoded = piCodec.decode(turns, messages)
    assert.deepEqual(decoded[1], {
        role: "user",
        content: [{ type: "text", text: "[Assistant turn summary]\ncollapsed" }],
        timestamp: 4_000,
    })
})

test("ladder-synthesized turns decode to pi user messages", () => {
    const messages: PiMessage[] = [userMessage("hello")]
    const turns = piCodec.encode(messages)
    turns.push({
        key: "better_compact_context_x",
        stamp: 0,
        role: "user",
        items: [
            {
                kind: "synthetic",
                key: "better_compact_context_x",
                text: "[Better Compact context pruning applied]",
            },
        ],
    })
    const decoded = piCodec.decode(turns, messages)
    assert.deepEqual(decoded[1], {
        role: "user",
        content: [{ type: "text", text: "[Better Compact context pruning applied]" }],
        timestamp: 0,
    })
})

test("keys are deterministic across encodes and unique for identical payloads", () => {
    const twin = () => userMessage("same text", 1_000)
    const messages: PiMessage[] = [twin(), twin()]
    const first = piCodec.encode(messages)
    const second = piCodec.encode(messages)
    assert.deepEqual(
        first.map((turn) => turn.key),
        second.map((turn) => turn.key),
    )
    assert.notEqual(first[0].key, first[1].key)
    assert.ok(first[1].key.startsWith(first[0].key))
})

test("estimate drops when a tool pair is stripped and prices the pair as one item", () => {
    const bigOutput = "x".repeat(8_000)
    const messages: PiMessage[] = [
        userMessage("go"),
        assistantMessage([
            { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "make" } },
        ]),
        toolResultMessage("call_1", bigOutput),
        userMessage("next"),
    ]
    const turns = piCodec.encode(messages)
    const before = piCodec.estimateTurns(turns)
    const pairEstimate = piCodec.estimateItem(toolItems(turns[1])[0])
    assert.ok(pairEstimate >= bigOutput.length / 4)
    turns[1].items = turns[1].items.filter((item) => item.kind !== "tool")
    const after = piCodec.estimateTurns(turns)
    assert.ok(before - after >= bigOutput.length / 4)
})

test("estimator prices bash executions and summaries as pi serializes them, and skips what pi drops", () => {
    const excluded = {
        role: "bashExecution",
        command: "secret",
        output: "y".repeat(4_000),
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 1,
    } as PiMessage
    const unknown = {
        role: "hologram",
        payload: "z".repeat(4_000),
        timestamp: 2,
    } as unknown as PiMessage
    const summary = {
        role: "compactionSummary",
        summary: "s".repeat(400),
        tokensBefore: 1,
        timestamp: 3,
    } as PiMessage
    const droppedOnly = piCodec.estimateTurns(piCodec.encode([excluded, unknown]))
    assert.equal(droppedOnly, 0)
    const withSummary = piCodec.estimateTurns(piCodec.encode([summary]))
    assert.ok(withSummary >= 100)
})

test("transcript lines render every item kind", () => {
    const turns = piCodec.encode(kitchenSinkConversation())
    const lines = turns.flatMap((turn) => turn.items.map((item) => piCodec.transcriptLine(item)))
    const transcript = lines.join("\n")
    assert.match(transcript, /\[reasoning\]\nplanning the setup/)
    assert.match(transcript, /\[tool:bash\] callId=call_1/)
    assert.match(transcript, /output=src\npackage\.json/)
    assert.match(transcript, /\[bash\]\nRan `git status`/)
    assert.match(transcript, /\[custom:some-extension\]/)
    assert.match(transcript, /\[branch summary\]\nexplored approach A/)
    assert.match(transcript, /\[compaction summary\]/)
    assert.match(transcript, /\[orphaned tool result:bash\] callId=call_missing/)
    assert.match(transcript, /\[hologram\]/)
    assert.match(transcript, /\[image image\/jpeg\]/)
})
