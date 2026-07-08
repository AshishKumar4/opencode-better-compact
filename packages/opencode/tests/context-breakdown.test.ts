import assert from "node:assert/strict"
import test from "node:test"
import { analyzeContextTokens, formatContextMessage } from "../lib/commands/context"
import { createSessionState, type WithParts } from "../lib/state"

const sessionID = "ses_context_breakdown"

function textPart(messageID: string, text: string, ignored = false) {
    return {
        id: `${messageID}-text`,
        messageID,
        sessionID,
        type: "text" as const,
        text,
        ignored,
    }
}

function toolPart(messageID: string, output: string) {
    return {
        id: `${messageID}-tool`,
        messageID,
        sessionID,
        type: "tool" as const,
        callID: `${messageID}-call`,
        tool: "read",
        state: {
            status: "completed" as const,
            input: { filePath: "src/app.ts" },
            output,
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
        },
    }
}

function message(id: string, role: "user" | "assistant", parts: WithParts["parts"], created: number, tokens?: any): WithParts {
    return {
        info: {
            id,
            role,
            sessionID,
            agent: "assistant",
            model: { providerID: "openai", modelID: "gpt-test" },
            providerID: "openai",
            modelID: "gpt-test",
            tokens,
            time: { created },
        } as WithParts["info"],
        parts,
    }
}

test("context breakdown keeps provider total separate from estimated history categories", () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "short user request")], 1),
        message(
            "msg-assistant-1",
            "assistant",
            [textPart("msg-assistant-1", "assistant response"), toolPart("msg-assistant-1", "tool output ".repeat(100))],
            2,
            {
                input: 650_000,
                output: 10_000,
                reasoning: 20_000,
                cache: { read: 150_000, write: 27_000 },
            },
        ),
    ]

    const breakdown = analyzeContextTokens(state, messages)

    assert.equal(breakdown.reportedTotal, 857_000)
    assert.ok(breakdown.unattributed > 800_000)
    assert.ok(breakdown.user > 0)
    assert.ok(breakdown.assistant > 0)
    assert.ok(breakdown.tools > 0)
    assert.equal(breakdown.references, 0)
})

test("context report does not claim a fake system percentage", () => {
    const state = createSessionState()
    state.sessionId = sessionID
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "hello")], 1),
        message("msg-assistant-1", "assistant", [textPart("msg-assistant-1", "hi")], 2, {
            input: 100_000,
            output: 100,
            reasoning: 0,
            cache: { read: 0, write: 0 },
        }),
    ]

    const report = formatContextMessage(analyzeContextTokens(state, messages))

    assert.match(report, /Reported by OpenCode/)
    assert.match(report, /Unattributed\/provider overhead\/cache\/system/)
    assert.doesNotMatch(report, /^System\s+/m)
})
