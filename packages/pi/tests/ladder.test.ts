import assert from "node:assert/strict"
import test from "node:test"
import { replayPlanSnapshot, createEngine, toPlanSnapshot } from "@better-compact/core"
import { piCodec, piSpec, type PiMessage } from "../src/codec"
import { assistantMessage, userMessage } from "./fixtures"
import { memoryPorts, overTriggerConversation } from "./helpers"

const engineRequest = (messages: PiMessage[]) => ({
    sessionKey: "session-1",
    turns: piCodec.encode(messages),
    contextLimit: 6_000,
})

test("ladder through the codec prunes old tools and reasoning, injects a reference, keeps the tail", async () => {
    const messages = overTriggerConversation()
    const ports = memoryPorts()
    const engine = createEngine(piSpec, ports)

    const result = await engine.process(engineRequest(messages))
    assert.equal(result.outcome, "planned")
    if (result.outcome !== "planned") return
    const decoded = piCodec.decode(result.turns, messages)

    // The raw tail (from the second-to-last user prompt) is untouched.
    const tailStart = messages.indexOf(messages.filter((m) => m.role === "user").at(-2)!)
    assert.deepEqual(decoded.slice(-(messages.length - tailStart)), messages.slice(tailStart))

    const prefix = decoded.slice(0, -(messages.length - tailStart))
    for (const message of prefix) {
        if (message.role === "assistant") {
            assert.ok(
                !message.content.some(
                    (block) => block.type === "toolCall" || block.type === "thinking",
                ),
            )
        }
        assert.notEqual(message.role, "toolResult")
    }

    // The reference message is a pi user message citing the transcript path.
    const reference = decoded.find(
        (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content[0]?.type === "text" &&
            message.content[0].text.startsWith("[Better Compact context pruning applied]"),
    )
    assert.ok(reference)
    const citedPath = [...ports.written.keys()][0]
    assert.ok(citedPath.startsWith("/sessions/session-1/better-compact/"))
    const referenceUser = reference as Extract<PiMessage, { role: "user" }>
    const referenceText = (referenceUser.content as Array<{ type: string; text: string }>)[0].text
    assert.ok(referenceText.includes(citedPath))
    assert.match(ports.written.get(citedPath)!, /\[tool:bash\] callId=call_0/)

    // Tokens shrank and every original user prompt survived somewhere.
    assert.ok(piCodec.estimateTurns(result.turns) < piCodec.estimateTurns(piCodec.encode(messages)))
    assert.ok(decoded.some((m) => m.role === "user" && m.content === "please do task 0"))
})

test("replay is deterministic: the second request decodes byte-identically", async () => {
    const messages = overTriggerConversation()
    const ports = memoryPorts()
    const engine = createEngine(piSpec, ports)

    const first = await engine.process(engineRequest(messages))
    assert.equal(first.outcome, "planned")
    const second = await engine.process(engineRequest(messages))
    assert.equal(second.outcome, "replayed")
    if (first.outcome !== "planned" || second.outcome !== "replayed") return
    assert.deepEqual(piCodec.decode(second.turns, messages), piCodec.decode(first.turns, messages))
})

test("regrowth past the trigger refuses the frozen plan and rebuilds", async () => {
    const messages = overTriggerConversation()
    const ports = memoryPorts()
    const engine = createEngine(piSpec, ports)

    const first = await engine.process(engineRequest(messages))
    assert.equal(first.outcome, "planned")
    if (first.outcome !== "planned") return
    const firstHash = first.plan.rangeHash

    const regrown = [...messages]
    let at = 50_000
    for (let round = 0; round < 12; round++) {
        regrown.push(userMessage(`more work ${round}`, at++))
        regrown.push(
            assistantMessage([{ type: "text", text: `regrowth ${"r".repeat(3_000)}` }], {
                timestamp: at++,
            }),
        )
    }
    assert.equal(
        replayPlanSnapshot(piCodec.encode(regrown), toPlanSnapshot(first.plan), piSpec),
        null,
    )

    const rebuilt = await engine.process(engineRequest(regrown))
    assert.equal(rebuilt.outcome, "planned")
    if (rebuilt.outcome !== "planned") return
    assert.notEqual(rebuilt.plan.rangeHash, firstHash)
})

test("an edited prefix fails the rangeHash check and the plan is refused", async () => {
    const messages = overTriggerConversation()
    const ports = memoryPorts()
    const engine = createEngine(piSpec, ports)

    const first = await engine.process(engineRequest(messages))
    assert.equal(first.outcome, "planned")
    if (first.outcome !== "planned") return

    const edited = messages.map((message, index) =>
        index === 0 ? userMessage("history was rewritten here", 1_000) : message,
    )
    assert.equal(
        replayPlanSnapshot(piCodec.encode(edited), toPlanSnapshot(first.plan), piSpec),
        null,
    )
})
