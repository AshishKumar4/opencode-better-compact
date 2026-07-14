import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Logger } from "../lib/logger"
import type { WithParts } from "../lib/state"
import {
    buildBoundaryContextPlan,
    toBoundaryPlanSnapshot,
    writeBoundaryTranscript,
} from "../lib/boundary"

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

test("split plans omit whole-message fork identity", () => {
    const assistantId = "msg-assistant-large"
    const messages = [
        message("msg-user-old", "user", [textPart("msg-user-old", "old request")], 1),
        message(
            assistantId,
            "assistant",
            [
                {
                    id: `${assistantId}-tool`,
                    messageID: assistantId,
                    sessionID,
                    type: "tool" as const,
                    callID: `${assistantId}-call`,
                    tool: "read",
                    state: {
                        status: "completed" as const,
                        input: { filePath: "large.log" },
                        output: "giant output ".repeat(5_000),
                        title: "read",
                        metadata: {},
                        time: { start: 1, end: 2 },
                    },
                } as WithParts["parts"][number],
                textPart(assistantId, "newest assistant detail stays raw", { id: `${assistantId}-text` }),
            ],
            2,
        ),
        message("msg-user-new", "user", [textPart("msg-user-new", "latest request")], 3),
    ]
    const plan = buildBoundaryContextPlan(messages, { contextLimit: 10_000 })

    assert.ok(plan)
    assert.equal(plan.rawTailStartMessageId, assistantId)
    assert.deepEqual(plan.rawTailItemBoundary, {
        itemKey: `${assistantId}-text`,
        side: "before",
    })
    const snapshot = toBoundaryPlanSnapshot(plan, messages)
    assert.equal(snapshot.prefixFingerprint, undefined)
    assert.equal(snapshot.compactedMessageCount, undefined)
})

test("boundary transcript is lossless and private", async () => {
    const bigInput = { marker: `private-tool-input-${"x".repeat(25_000)}-end` }
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "old user")], 1),
        message(
            "msg-assistant-1",
            "assistant",
            [
                {
                    id: "msg-assistant-1-tool",
                    messageID: "msg-assistant-1",
                    sessionID,
                    type: "tool" as const,
                    callID: "msg-assistant-1-call",
                    tool: "read",
                    state: {
                        status: "completed" as const,
                        input: bigInput,
                        output: "old detail ".repeat(2_000),
                        title: "read",
                        metadata: {},
                        time: { start: 1, end: 2 },
                    },
                } as any,
            ],
            2,
        ),
        message("msg-user-2", "user", [textPart("msg-user-2", "middle user")], 3),
        message("msg-assistant-2", "assistant", [textPart("msg-assistant-2", "middle assistant")], 4),
        message("msg-user-3", "user", [textPart("msg-user-3", "latest user")], 5),
    ]
    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 10_000,
        force: true,
        recentToolResultBudgetTokens: 0,
    })
    assert.ok(plan)
    const directory = mkdtempSync(join(tmpdir(), "better-compact-private-transcript-"))

    await writeBoundaryTranscript(directory, plan, new Logger(false))

    const path = join(directory, plan.transcript.relativePath)
    const content = readFileSync(path, "utf8")
    assert.match(content, /private-tool-input-/)
    assert.match(content, /-end/)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700)
})
