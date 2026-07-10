import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import { buildBoundaryContextPlan } from "../lib/boundary"

const sessionID = "ses_boundary_context"

function textPart(messageID: string, text: string, extra: Record<string, unknown> = {}) {
    return {
        id: `${messageID}-part`,
        messageID,
        sessionID,
        type: "text" as const,
        text,
        ...extra,
    }
}

function message(id: string, role: "user" | "assistant", parts: WithParts["parts"], created: number): WithParts {
    return {
        info: {
            id,
            role,
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
        } as WithParts["info"],
        parts,
    }
}

test("ignored Better Compact messages do not count as protected user turns", () => {
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "old user")], 1),
        message("msg-assistant-1", "assistant", [textPart("msg-assistant-1", "old detail ".repeat(2_000))], 2),
        message("msg-user-2", "user", [textPart("msg-user-2", "middle user")], 3),
        message("msg-ignored", "user", [textPart("msg-ignored", "Better Compact report", { ignored: true })], 4),
        message("msg-assistant-2", "assistant", [textPart("msg-assistant-2", "middle assistant")], 5),
        message("msg-user-3", "user", [textPart("msg-user-3", "latest user")], 6),
    ]

    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 10_000,
        force: true,
    })

    assert.ok(plan)
    assert.equal(plan.rawTailStartMessageId, "msg-user-2")
})
