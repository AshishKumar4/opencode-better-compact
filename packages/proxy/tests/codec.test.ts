import assert from "node:assert/strict"
import test from "node:test"
import { buildPlan, transformTurns, type Item, type Turn } from "@better-compact/core"
import {
    anthropicCodec,
    anthropicSpec,
    claudeCodeConventions,
    type ToolPair,
    type WireBlock,
    type WireMessage,
} from "../src/anthropic/codec"
import { assistantMessage, bigConversation, kitchenSinkMessages, thinking, toolResult, toolUse, userMessage } from "./fixtures"

function roundTrip(messages: WireMessage[]): WireMessage[] {
    return anthropicCodec.decode(anthropicCodec.encode(messages), messages)
}

function toolItems(turn: Turn): Extract<Item, { kind: "tool" }>[] {
    return turn.items.filter((item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool")
}

function blocksOf(message: WireMessage): WireBlock[] {
    assert.ok(Array.isArray(message.content))
    return message.content
}

test("round-trip is identity on every message kind", () => {
    const messages = kitchenSinkMessages()
    const decoded = roundTrip(messages)
    assert.deepEqual(decoded, messages)
    // Untouched messages re-emit as the same objects, not copies.
    decoded.forEach((message, index) => assert.equal(message, messages[index]))
})

test("round-trip survives injected vendor junk fields", () => {
    const messages = kitchenSinkMessages().map((message, index) => {
        const junked = { ...message, vendorJunk: { index, nested: [1, "two", null] } }
        if (Array.isArray(junked.content)) {
            junked.content = junked.content.map((block) => ({ ...block, junkField: `j${index}` }))
        }
        return junked as WireMessage
    })
    assert.deepEqual(roundTrip(messages), messages)
})

test("tool_use and its tool_result from the next user message form one IR item", () => {
    const messages = kitchenSinkMessages()
    const turns = anthropicCodec.encode(messages)
    // user, assistant(+carrier), assistant, user, assistant, user
    assert.equal(turns.length, 6)
    const tools = toolItems(turns[1])
    assert.equal(tools.length, 2)
    const pair = tools[0].handle as ToolPair
    assert.equal(pair.use, blocksOf(messages[1])[2])
    assert.equal(pair.result?.block, blocksOf(messages[2])[0])
    assert.equal(pair.result?.carrier, messages[2])
})

test("dropping a tool item removes the tool_use block and its tool_result block", () => {
    const messages = kitchenSinkMessages()
    const turns = anthropicCodec.encode(messages)
    turns[1].items = turns[1].items.filter((item) => !(item.kind === "tool" && item.callId === "toolu_01"))
    const decoded = anthropicCodec.decode(turns, messages)

    const assistant = decoded[1]
    assert.ok(!blocksOf(assistant).some((block) => block.type === "tool_use" && block.id === "toolu_01"))
    assert.ok(blocksOf(assistant).some((block) => block.type === "tool_use" && block.id === "toolu_02"))
    const carrier = decoded[2]
    assert.ok(!blocksOf(carrier).some((block) => block.tool_use_id === "toolu_01"))
    assert.ok(blocksOf(carrier).some((block) => block.tool_use_id === "toolu_02"))
})

test("an emptied carrier user message collapses away entirely", () => {
    const messages = [
        userMessage("go"),
        assistantMessage([toolUse("toolu_1", "Bash", { command: "ls" })]),
        userMessage([toolResult("toolu_1", "listing")]),
        userMessage("next"),
    ]
    const turns = anthropicCodec.encode(messages)
    turns[1].items = [{ kind: "synthetic", key: "s1", text: "[tool calls/results cleared]" }]
    const decoded = anthropicCodec.decode(turns, messages)
    assert.equal(decoded.length, 3)
    assert.deepEqual(decoded[1], { role: "assistant", content: [{ type: "text", text: "[tool calls/results cleared]" }] })
    assert.equal(decoded[2], messages[3])
})

test("a mixed carrier keeps its system-reminder text when results are pruned", () => {
    const messages = kitchenSinkMessages()
    const turns = anthropicCodec.encode(messages)
    turns[1].items = turns[1].items.filter((item) => item.kind !== "tool")
    const decoded = anthropicCodec.decode(turns, messages)
    const carrier = decoded[2]
    assert.deepEqual(blocksOf(carrier), [{ type: "text", text: "<system-reminder>stay focused</system-reminder>" }])
})

test("an orphaned tool_result survives as an opaque item", () => {
    const messages = kitchenSinkMessages()
    const turns = anthropicCodec.encode(messages)
    const orphanTurn = turns[3]
    assert.ok(
        orphanTurn.items.some(
            (item) =>
                item.kind === "opaque" &&
                (item.handle as { block?: WireBlock }).block === undefined &&
                (item.handle as WireBlock).type === "tool_result",
        ),
    )
    assert.deepEqual(roundTrip(messages), messages)
})

test("an assistant message emptied by pruning vanishes instead of sending empty content", () => {
    const messages = [
        userMessage("go"),
        assistantMessage([thinking("only thinking here")]),
        userMessage("next"),
    ]
    const turns = anthropicCodec.encode(messages)
    turns[1].items = []
    const decoded = anthropicCodec.decode(turns, messages)
    assert.deepEqual(decoded, [messages[0], messages[2]])
})

test("ladder-synthesized turns decode to user messages with one text block", () => {
    const messages = [userMessage("hello")]
    const turns = anthropicCodec.encode(messages)
    turns.push({
        key: "better_compact_context_x",
        stamp: 0,
        role: "user",
        items: [{ kind: "synthetic", key: "better_compact_context_x", text: "[Better Compact context pruning applied]" }],
    })
    const decoded = anthropicCodec.decode(turns, messages)
    assert.deepEqual(decoded[1], {
        role: "user",
        content: [{ type: "text", text: "[Better Compact context pruning applied]" }],
    })
})

test("keys are deterministic, unique for identical payloads, and blind to cache_control", () => {
    const twin = () => userMessage("same text")
    const messages = [twin(), twin()]
    const first = anthropicCodec.encode(messages)
    const second = anthropicCodec.encode(messages)
    assert.deepEqual(
        first.map((turn) => turn.key),
        second.map((turn) => turn.key),
    )
    assert.notEqual(first[0].key, first[1].key)
    assert.ok(first[1].key.startsWith(first[0].key))

    // A moved cache breakpoint must not read as an edited prefix.
    const marked = [
        userMessage([{ type: "text", text: "same text", cache_control: { type: "ephemeral" } }]),
    ]
    const plain = [userMessage([{ type: "text", text: "same text" }])]
    assert.equal(anthropicCodec.encode(marked)[0].key, anthropicCodec.encode(plain)[0].key)
})

test("cache_control on a pruned block migrates to the nearest surviving earlier block", () => {
    const messages = [
        userMessage([{ type: "text", text: "keep me" }]),
        assistantMessage([
            { type: "text", text: "surviving assistant text" },
            toolUse("toolu_1", "Bash", { command: "ls" }),
        ]),
        userMessage([toolResult("toolu_1", "big output", { cache_control: { type: "ephemeral" } })]),
        userMessage("next"),
    ]
    const turns = anthropicCodec.encode(messages)
    turns[1].items = turns[1].items.filter((item) => item.kind !== "tool")
    const decoded = anthropicCodec.decode(turns, messages)

    assert.equal(decoded.length, 3)
    const assistantBlocks = blocksOf(decoded[1])
    assert.deepEqual(assistantBlocks, [
        { type: "text", text: "surviving assistant text", cache_control: { type: "ephemeral" } },
    ])
    // The original handle objects are never mutated.
    assert.deepEqual(blocksOf(messages[1])[0], { type: "text", text: "surviving assistant text" })
})

test("a marker migrating onto an already-marked block leaves the existing marker", () => {
    const messages = [
        userMessage([{ type: "text", text: "anchor", cache_control: { type: "ephemeral", ttl: "1h" } }]),
        assistantMessage([toolUse("toolu_1", "Bash", { command: "ls" })]),
        userMessage([toolResult("toolu_1", "out", { cache_control: { type: "ephemeral" } })]),
        userMessage("next"),
    ]
    const turns = anthropicCodec.encode(messages)
    turns[1].items = [{ kind: "synthetic", key: "s1", text: "[cleared]" }]
    const decoded = anthropicCodec.decode(turns, messages)
    // The synthetic replacement sits later than the anchor, so it takes the
    // orphaned marker; the anchor keeps its own.
    assert.deepEqual(blocksOf(decoded[0])[0].cache_control, { type: "ephemeral", ttl: "1h" })
    assert.deepEqual(blocksOf(decoded[1]), [
        { type: "text", text: "[cleared]", cache_control: { type: "ephemeral" } },
    ])
})

test("estimates price a tool pair as one item and drop when it is stripped", () => {
    const big = "x".repeat(8_000)
    const messages = [
        userMessage("go"),
        assistantMessage([toolUse("toolu_1", "Bash", { command: "make" })]),
        userMessage([toolResult("toolu_1", big)]),
        userMessage("next"),
    ]
    const turns = anthropicCodec.encode(messages)
    const before = anthropicCodec.estimateTurns(turns)
    assert.ok(before >= big.length / 4)
    assert.ok(anthropicCodec.estimateItem(toolItems(turns[1])[0]) >= big.length / 4)
    turns[1].items = turns[1].items.filter((item) => item.kind !== "tool")
    assert.ok(anthropicCodec.estimateTurns(turns) < before / 4)
})

test("claude code conventions select Skill and TodoWrite tool calls", () => {
    const messages = [
        userMessage("go"),
        assistantMessage([
            toolUse("toolu_skill", "Skill", { skill: "root-cause-debug" }),
            toolUse("toolu_todo", "TodoWrite", {
                todos: [
                    { content: "fix bug", status: "completed", activeForm: "Fixing bug" },
                    { content: "add test", status: "in_progress", activeForm: "Adding test" },
                ],
            }),
            toolUse("toolu_bash", "Bash", { command: "ls" }),
        ]),
        userMessage([
            toolResult("toolu_skill", "skill loaded"),
            toolResult("toolu_todo", "ok"),
            toolResult("toolu_bash", "listing"),
        ]),
    ]
    const [, assistant] = anthropicCodec.encode(messages)
    const [skill, todo, bash] = toolItems(assistant)
    assert.equal(claudeCodeConventions.isSkillItem?.(skill), true)
    assert.equal(claudeCodeConventions.isSkillItem?.(bash), false)
    assert.equal(claudeCodeConventions.todo?.isTodoItem(todo), true)
    assert.equal(claudeCodeConventions.todo?.isTodoItem(bash), false)
    assert.equal(claudeCodeConventions.todo?.format(todo), "1. [completed] fix bug; 2. [in_progress] add test")
})

test("full ladder output decodes to a valid /v1/messages history", () => {
    const messages = bigConversation()
    const turns = anthropicCodec.encode(messages)
    const plan = buildPlan(
        turns,
        {
            contextLimit: 200_000,
            sessionKey: "ses_validity",
            citablePath: (key, hash) => `/tmp/${key}/${hash}.md`,
        },
        anthropicSpec,
    )
    assert.ok(plan)
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, anthropicSpec)
    const decoded = anthropicCodec.decode(transformed, messages)

    assert.ok(decoded.length < messages.length)
    assert.ok(anthropicCodec.estimateTurns(anthropicCodec.encode(decoded)) < anthropicCodec.estimateTurns(turns))
    for (let index = 0; index < decoded.length; index++) {
        const message = decoded[index]
        // No empty content.
        if (typeof message.content === "string") assert.ok(message.content.length > 0)
        else assert.ok(message.content.length > 0)
        // Every surviving tool_use keeps its tool_result in the next message.
        if (!Array.isArray(message.content)) continue
        for (const block of message.content) {
            if (block.type !== "tool_use") continue
            const next = decoded[index + 1]
            assert.ok(next && Array.isArray(next.content))
            assert.ok(
                (next.content as WireBlock[]).some(
                    (candidate) => candidate.type === "tool_result" && candidate.tool_use_id === block.id,
                ),
                `tool_use ${String(block.id)} lost its tool_result`,
            )
        }
    }
    // The raw tail survives byte-identical: the last three original messages
    // re-emit as the same objects.
    assert.equal(decoded.at(-1), messages.at(-1))
    assert.equal(decoded.at(-2), messages.at(-2))
    assert.equal(decoded.at(-3), messages.at(-3))
    // The reference message cites the transcript path.
    assert.ok(
        decoded.some(
            (message) =>
                Array.isArray(message.content) &&
                message.content.some(
                    (block) => block.type === "text" && String(block.text).includes("/tmp/ses_validity/"),
                ),
        ),
    )
})
