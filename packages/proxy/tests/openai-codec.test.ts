import assert from "node:assert/strict"
import test from "node:test"
import { buildPlan, transformTurns, type Item, type Turn } from "@better-compact/core"
import {
    codexConventions,
    openaiCodec,
    openaiSpec,
    type CallPair,
    type ResponseItemWire,
} from "../src/openai/codec"
import {
    assistantMessage,
    bigConversation,
    functionCall,
    functionCallOutput,
    kitchenSinkInput,
    reasoning,
    userMessage,
} from "./openai-fixtures"

function roundTrip(input: ResponseItemWire[]): ResponseItemWire[] {
    return openaiCodec.decode(openaiCodec.encode(input), input)
}

function toolItems(turn: Turn): Extract<Item, { kind: "tool" }>[] {
    return turn.items.filter(
        (item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool",
    )
}

test("round-trip is identity on every item kind", () => {
    const input = kitchenSinkInput()
    const decoded = roundTrip(input)
    assert.deepEqual(decoded, input)
    // Untouched items re-emit as the same objects, not copies.
    decoded.forEach((item, index) => assert.equal(item, input[index]))
})

test("round-trip survives injected vendor junk fields", () => {
    const input = kitchenSinkInput().map((item, index) => ({
        ...item,
        vendorJunk: { index, nested: [1, "two", null] },
    }))
    assert.deepEqual(roundTrip(input), input)
})

test("reasoning, function_call and function_call_output fold into one IR tool item", () => {
    const input = kitchenSinkInput()
    const turns = openaiCodec.encode(input)
    // user, assistant(everything up to the developer/orphan), user
    const assistant = turns[1]
    const tools = toolItems(assistant)
    assert.equal(tools.length, 3)
    const pair = tools[0].handle as CallPair
    assert.equal(pair.callId, "call_01")
    assert.equal(pair.call, input[2])
    assert.equal(pair.output, input[3])
    assert.equal(pair.reasoning[0], input[1])
})

test("dropping a tool item removes its call, output, and bound reasoning atomically", () => {
    const input = kitchenSinkInput()
    const turns = openaiCodec.encode(input)
    turns[1].items = turns[1].items.filter(
        (item) => !(item.kind === "tool" && item.callId === "call_01"),
    )
    const decoded = openaiCodec.decode(turns, input)
    // The bound reasoning (input[1]), the call (input[2]) and its output
    // (input[3]) are all gone; the surviving parallel calls remain paired.
    assert.ok(!decoded.includes(input[1]))
    assert.ok(!decoded.some((item) => item.type === "function_call" && item.call_id === "call_01"))
    assert.ok(
        !decoded.some((item) => item.type === "function_call_output" && item.call_id === "call_01"),
    )
    assert.ok(decoded.some((item) => item.type === "function_call" && item.call_id === "call_02"))
    assert.ok(
        decoded.some((item) => item.type === "function_call_output" && item.call_id === "call_02"),
    )
})

test("a preserved tool re-emits its bound reasoning immediately before the call", () => {
    const input = [
        userMessage("go"),
        reasoning("deciding", "enc_a"),
        functionCall("call_1", "shell", { cmd: "ls" }),
        functionCallOutput("call_1", "ok"),
        userMessage("next"),
    ]
    const decoded = roundTrip(input)
    const callIndex = decoded.findIndex((item) => item.type === "function_call")
    assert.equal(decoded[callIndex - 1].type, "reasoning")
    assert.deepEqual(decoded, input)
})

test("a standalone reasoning before an assistant message is a strippable reasoning item", () => {
    const input = [
        userMessage("go"),
        reasoning("private thought", "enc_x"),
        assistantMessage("here is my answer"),
        userMessage("next"),
    ]
    const turns = openaiCodec.encode(input)
    const reasoningItems = turns[1].items.filter((item) => item.kind === "reasoning")
    assert.equal(reasoningItems.length, 1)
    // Reasoning stage removes it; the assistant message survives with no orphan.
    turns[1].items = turns[1].items.filter((item) => item.kind !== "reasoning")
    const decoded = openaiCodec.decode(turns, input)
    assert.ok(!decoded.some((item) => item.type === "reasoning"))
    assert.deepEqual(
        decoded.map((item) => item.type),
        ["message", "message", "message"],
    )
})

test("an assistant turn emptied by pruning vanishes instead of emitting empty content", () => {
    const input = [
        userMessage("go"),
        reasoning("only thinking", "enc_only"),
        assistantMessage("answer"),
        userMessage("next"),
    ]
    const turns = openaiCodec.encode(input)
    turns[1].items = []
    const decoded = openaiCodec.decode(turns, input)
    assert.deepEqual(decoded, [input[0], input[3]])
})

test("an orphaned function_call_output survives as an opaque item", () => {
    const input = kitchenSinkInput()
    const turns = openaiCodec.encode(input)
    const orphan = turns[1].items.some(
        (item) =>
            item.kind === "opaque" &&
            (item.handle as ResponseItemWire).type === "function_call_output" &&
            (item.handle as { call_id?: string }).call_id === "call_ghost",
    )
    assert.ok(orphan)
    assert.deepEqual(roundTrip(input), input)
})

test("ladder-synthesized user turns decode to a user message with input_text", () => {
    const input = [userMessage("hello")]
    const turns = openaiCodec.encode(input)
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
    const decoded = openaiCodec.decode(turns, input)
    assert.deepEqual(decoded[1], {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "[Better Compact context pruning applied]" }],
    })
})

test("keys are deterministic and unique for identical payloads", () => {
    // Two identical user turns separated by an assistant turn: their content
    // hashes collide, so the deduper appends an occurrence ordinal.
    const input = [userMessage("same text"), assistantMessage("reply"), userMessage("same text")]
    const first = openaiCodec.encode(input)
    const second = openaiCodec.encode(input)
    assert.deepEqual(
        first.map((turn) => turn.key),
        second.map((turn) => turn.key),
    )
    assert.notEqual(first[0].key, first[2].key)
    assert.ok(first[2].key.startsWith(first[0].key))
})

test("estimates price a tool pair as one item and drop when it is stripped", () => {
    const big = "x".repeat(8_000)
    const input = [
        userMessage("go"),
        reasoning("thinking", "enc"),
        functionCall("call_1", "shell", { cmd: "make" }),
        functionCallOutput("call_1", big),
        userMessage("next"),
    ]
    const turns = openaiCodec.encode(input)
    const before = openaiCodec.estimateTurns(turns)
    assert.ok(before >= big.length / 4)
    assert.ok(openaiCodec.estimateItem(toolItems(turns[1])[0]) >= big.length / 4)
    turns[1].items = turns[1].items.filter((item) => item.kind !== "tool")
    assert.ok(openaiCodec.estimateTurns(turns) < before / 4)
})

test("Codex conventions preserve JSON-string command failures verbatim", () => {
    const input = [
        userMessage("go"),
        functionCall("call_1", "shell", { cmd: "missing-command" }),
        functionCallOutput(
            "call_1",
            JSON.stringify({
                output: "bash: missing-command: command not found\nsecond line",
                metadata: { exit_code: 127 },
            }),
        ),
        userMessage("next"),
    ]
    const item = toolItems(openaiCodec.encode(input)[1])[0]

    assert.deepEqual(codexConventions.tool?.(item), {
        name: "shell",
        input: JSON.stringify({ cmd: "missing-command" }),
        error: "bash: missing-command: command not found\nsecond line",
    })
})

test("full ladder output decodes to a valid Responses input history", () => {
    const input = bigConversation()
    const turns = openaiCodec.encode(input)
    const plan = buildPlan(
        turns,
        {
            contextLimit: 272_000,
            sessionKey: "sess_validity",
            citablePath: (key, hash) => `/tmp/${key}/${hash}.md`,
        },
        openaiSpec,
    )
    assert.ok(plan)
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, openaiSpec)
    const decoded = openaiCodec.decode(transformed, input)

    assert.ok(decoded.length < input.length)
    assert.ok(
        openaiCodec.estimateTurns(openaiCodec.encode(decoded)) < openaiCodec.estimateTurns(turns),
    )

    // No orphaned function_call_output: every output has its call earlier.
    const seenCalls = new Set<string>()
    for (const item of decoded) {
        if (item.type === "function_call") seenCalls.add(item.call_id as string)
        if (item.type === "function_call_output") {
            assert.ok(
                seenCalls.has(item.call_id as string),
                `orphan output ${String(item.call_id)}`,
            )
        }
    }
    // No reasoning item is orphaned: bound reasoning only survives alongside a
    // preserved tool, so every surviving reasoning is immediately followed by
    // its function_call.
    for (let index = 0; index < decoded.length; index++) {
        if (decoded[index].type !== "reasoning") continue
        assert.equal(decoded[index + 1]?.type, "function_call", "reasoning left without its call")
    }
    // No empty message content arrays.
    for (const item of decoded) {
        if (item.type !== "message") continue
        assert.ok(Array.isArray(item.content) && (item.content as unknown[]).length > 0)
    }
    // The raw tail survives byte-identical.
    assert.equal(decoded.at(-1), input.at(-1))
    assert.equal(decoded.at(-2), input.at(-2))
    assert.equal(decoded.at(-3), input.at(-3))
    // The reference message cites the transcript path.
    assert.ok(
        decoded.some(
            (item) =>
                item.type === "message" &&
                Array.isArray(item.content) &&
                (item.content as Array<{ text?: string }>).some((part) =>
                    String(part.text ?? "").includes("/tmp/sess_validity/"),
                ),
        ),
    )
})
