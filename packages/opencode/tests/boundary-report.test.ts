import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import { buildBoundaryContextPlan, formatBoundaryReport } from "../lib/boundary"

const sessionID = "ses_boundary_report"

function textPart(messageID: string, text: string) {
    return {
        id: `${messageID}-part`,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function reasoningPart(messageID: string, text: string) {
    return {
        id: `${messageID}-reasoning`,
        messageID,
        sessionID,
        type: "reasoning" as const,
        text,
        time: { start: 1 },
    }
}

function toolPart(messageID: string, tool: string, output: string) {
    return {
        id: `${messageID}-${tool}`,
        messageID,
        sessionID,
        type: "tool" as const,
        callID: `${messageID}-${tool}-call`,
        tool,
        state: {
            status: "completed" as const,
            input: tool === "skill" ? { name: "root-cause-debug" } : { filePath: "src/app.ts" },
            output,
            title: tool,
            metadata: {},
            time: { start: 1, end: 2 },
        },
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

test("boundary report shows visual context bars without internal threshold jargon", () => {
    const plan = buildBoundaryContextPlan(
        [
            message("msg-user-1", "user", [textPart("msg-user-1", "Please preserve this exact requirement.")], 1),
            message(
                "msg-assistant-1",
                "assistant",
                [
                    reasoningPart("msg-assistant-1", "private reasoning ".repeat(2_000)),
                    textPart("msg-assistant-1", "Investigated the OpenCode compaction path."),
                    toolPart("msg-assistant-1", "read", "tool-output ".repeat(4_000)),
                    toolPart("msg-assistant-1", "skill", "skill content ".repeat(2_000)),
                ],
                2,
            ),
            message("msg-user-2", "user", [textPart("msg-user-2", "Continue with the plugin-only design.")], 3),
            message("msg-assistant-2", "assistant", [textPart("msg-assistant-2", "Recent assistant tail should remain raw.")], 4),
            message("msg-user-3", "user", [textPart("msg-user-3", "Latest user tail should remain raw.")], 5),
        ],
        {
            contextLimit: 20_000,
            force: true,
            recentToolResultBudgetTokens: 0,
            providerReportedTokens: 18_000,
        },
    )
    assert.ok(plan)

    const report = formatBoundaryReport(plan, 18_000)

    assert.match(report, /Better Compact Complete/)
    assert.match(report, /Before\s+18K\s+\/\s+20K\s+\[/)
    assert.match(report, /Now\s+.+\[/)
    assert.match(report, /Actions/)
    assert.match(report, /Reference/)
    assert.doesNotMatch(report, /^\s*Target\s+/m)
    assert.doesNotMatch(report, /Projected after/i)
    assert.doesNotMatch(report, /Trigger threshold/i)
    assert.doesNotMatch(report, /Last-resort target/i)
})
