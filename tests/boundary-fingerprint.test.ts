import assert from "node:assert/strict"
import test from "node:test"
import { boundaryRangeHash } from "../lib/boundary/fingerprint"
import type { WithParts } from "../lib/state"

function toolMessage(messageID: string, sessionID: string, inputID: string): WithParts {
    return {
        info: {
            id: messageID,
            sessionID,
            role: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${messageID}-part`,
                messageID,
                sessionID,
                type: "tool",
                tool: "read",
                callID: "call-1",
                state: {
                    status: "completed",
                    input: { id: inputID },
                    output: "result",
                    title: "read",
                    metadata: {},
                    time: { start: 1, end: 2 },
                },
            } as WithParts["parts"][number],
        ],
    }
}

test("boundary fingerprint ignores transport IDs after a fork", () => {
    const source = toolMessage("source-message", "source-session", "customer-a")
    const fork = toolMessage("fork-message", "fork-session", "customer-a")

    assert.equal(boundaryRangeHash([source]), boundaryRangeHash([fork]))
})

test("boundary fingerprint retains semantic payload fields named id", () => {
    const first = toolMessage("message", "session", "customer-a")
    const second = toolMessage("message", "session", "customer-b")

    assert.notEqual(boundaryRangeHash([first]), boundaryRangeHash([second]))
})
