import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import {
    applyBoundaryContextPlan,
    applyBoundaryPlanSnapshot,
    buildBoundaryContextPlan,
    formatBoundaryReport,
    storeBoundaryPlan,
} from "../lib/boundary/context"
import { createSessionState } from "../lib/state"
import { estimateOpenCodeMessages } from "../lib/context-estimate"

const sessionID = "ses_boundary_context"

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

function toolPart(messageID: string, tool: string, output: string, input?: Record<string, unknown>) {
    return {
        id: `${messageID}-${tool}`,
        messageID,
        sessionID,
        type: "tool" as const,
        callID: `${messageID}-${tool}-call-${output.length}-${JSON.stringify(input ?? {}).length}`,
        tool,
        state: {
            status: "completed" as const,
            input: input ?? (tool === "skill" ? { name: "root-cause-debug" } : { filePath: "src/app.ts" }),
            output,
            title: tool,
            metadata: {},
            time: { start: 1, end: 2 },
        },
    }
}

function errorToolPart(messageID: string, tool: string, error: string, input?: Record<string, unknown>) {
    return {
        id: `${messageID}-${tool}`,
        messageID,
        sessionID,
        type: "tool" as const,
        callID: `${messageID}-${tool}-call`,
        tool,
        state: {
            status: "error" as const,
            input: input ?? {},
            error,
            metadata: {},
            time: { start: 1, end: 2 },
        },
    }
}

function message(
    id: string,
    role: "user" | "assistant",
    parts: WithParts["parts"],
    created: number,
): WithParts {
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

function buildLargeConversation(): WithParts[] {
    const bigToolOutput = "tool-output ".repeat(4_000)
    return [
        message("msg-user-1", "user", [textPart("msg-user-1", "Please preserve this exact requirement.")], 1),
        message(
            "msg-assistant-1",
            "assistant",
            [
                reasoningPart("msg-assistant-1", "private reasoning ".repeat(2_000)),
                textPart("msg-assistant-1", "Investigated the OpenCode compaction path."),
                toolPart("msg-assistant-1", "read", bigToolOutput),
                toolPart("msg-assistant-1", "skill", "skill content ".repeat(2_000)),
            ],
            2,
        ),
        message("msg-user-2", "user", [textPart("msg-user-2", "Continue with the plugin-only design.")], 3),
        message(
            "msg-assistant-2",
            "assistant",
            [textPart("msg-assistant-2", "Recent assistant tail should remain raw.")],
            4,
        ),
        message("msg-user-3", "user", [textPart("msg-user-3", "Latest user tail should remain raw.")], 5),
    ]
}

test("boundary planner does nothing before 85 percent usage", () => {
    const plan = buildBoundaryContextPlan(
        [message("msg-user-small", "user", [textPart("msg-user-small", "small")], 1)],
        { contextLimit: 100_000 },
    )

    assert.equal(plan, null)
})

test("boundary planner compactifies old assistant/tool context and preserves raw tail", () => {
    const messages = buildLargeConversation()
    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 10_000,
        force: true,
        recentToolResultBudgetTokens: 0,
    })

    assert.ok(plan)
    assert.ok(plan.afterPruneTokens < plan.beforeTokens)
    assert.ok(plan.stages.some((stage) => stage.name === "reasoning" && stage.clearedTokens > 0))
    assert.ok(plan.stages.some((stage) => stage.name === "skills" && stage.clearedTokens > 0))
    assert.ok(plan.stages.some((stage) => stage.name === "tools-old" && stage.clearedTokens > 0))
    assert.match(plan.transcript.relativePath, /^\.opencode\/better-compact\/sessions\/ses_boundary_context\//)
    assert.equal(plan.transcript.content, "")
    assert.deepEqual(plan.transcript.messageIds, ["msg-user-1", "msg-assistant-1"])

    applyBoundaryContextPlan(messages, plan)

    assert.equal(messages.at(-1)?.info.id, "msg-user-3")
    assert.equal(messages.at(-2)?.info.id, "msg-assistant-2")
    assert.equal(messages.at(-3)?.info.id, "msg-user-2")

    const firstUserText = messages[0]?.parts[0]
    assert.equal(firstUserText?.type, "text")
    if (firstUserText?.type === "text") {
        assert.equal(firstUserText.text, "Please preserve this exact requirement.")
    }

    const compactedAssistantText = messages[1]?.parts[0]
    assert.equal(compactedAssistantText?.type, "text")
    if (compactedAssistantText?.type === "text") {
        assert.match(compactedAssistantText.text, /Investigated the OpenCode compaction path/)
        assert.doesNotMatch(compactedAssistantText.text, /read/)
        assert.doesNotMatch(compactedAssistantText.text, /skill/)
        assert.doesNotMatch(compactedAssistantText.text, /private reasoning/)
        assert.doesNotMatch(compactedAssistantText.text, /skill content/)
        assert.doesNotMatch(compactedAssistantText.text, /tool-output/)
    }

    const referenceMessage = messages.find((item) => item.info.id.startsWith("msg_better_compact_context_"))
    assert.ok(referenceMessage)
    const referenceText = referenceMessage.parts[0]
    assert.equal(referenceText?.type, "text")
    if (referenceText?.type === "text") {
        assert.match(referenceText.text, /## Reference Files/)
        assert.match(referenceText.text, new RegExp(plan.transcript.relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    }
})

function buildMultiRunConversation(): WithParts[] {
    return [
        message("msg-user-1", "user", [textPart("msg-user-1", "First task, keep this requirement.")], 1),
        message(
            "msg-assistant-big",
            "assistant",
            [
                reasoningPart("msg-assistant-big", "big private reasoning ".repeat(500)),
                textPart("msg-assistant-big", "big assistant detail ".repeat(7_000)),
                toolPart("msg-assistant-big", "read", "big tool output ".repeat(500)),
            ],
            2,
        ),
        message("msg-user-2", "user", [textPart("msg-user-2", "Second task.")], 3),
        message(
            "msg-assistant-small",
            "assistant",
            [
                reasoningPart("msg-assistant-small", "small private reasoning ".repeat(200)),
                textPart("msg-assistant-small", "small assistant detail"),
                toolPart("msg-assistant-small", "grep", "small tool output ".repeat(200), { pattern: "needle" }),
            ],
            4,
        ),
        message("msg-user-3", "user", [textPart("msg-user-3", "Third task stays raw.")], 5),
        message("msg-assistant-tail", "assistant", [textPart("msg-assistant-tail", "tail assistant")], 6),
        message("msg-user-4", "user", [textPart("msg-user-4", "Latest user stays raw.")], 7),
    ]
}

test("applied output matches the simulated plan when assistant runs are summarized", () => {
    const messages = buildMultiRunConversation()
    const options = {
        contextLimit: 40_000,
        recentToolResultBudgetTokens: 0,
    }
    const firstPass = buildBoundaryContextPlan(messages, options)
    assert.ok(firstPass)
    assert.ok(firstPass.stages.some((stage) => stage.name === "assistant-runs" && stage.status === "applied"))
    assert.ok(firstPass.summaryJobs.length > 0)

    const assistantSummaries = Object.fromEntries(
        firstPass.assistantSummaryKeys.map((key) => [key, "Accepted summary: shipped the first task end to end."]),
    )
    const plan = buildBoundaryContextPlan(messages, { ...options, assistantSummaries })
    assert.ok(plan)
    assert.equal(plan.summaryJobs.length, 0)

    applyBoundaryContextPlan(messages, plan)

    assert.equal(plan.afterPruneTokens, estimateOpenCodeMessages(messages))
    assert.ok(!plan.stages.some((stage) => stage.name === "prefix-summary"))
    assert.ok(estimateOpenCodeMessages(messages) < plan.triggerTokens)

    const selectedRun = messages.find((item) => item.info.id === "msg-assistant-big")
    assert.equal(selectedRun?.parts.length, 1)
    assert.equal(selectedRun?.parts[0]?.type, "text")
    if (selectedRun?.parts[0]?.type === "text") {
        assert.match(selectedRun.parts[0].text, /Accepted summary: shipped the first task end to end\./)
    }

    // The core drift bug: non-selected prefix runs must keep the stage 1-4
    // pruning (no tool/reasoning parts) in the applied output.
    const nonSelectedRun = messages.find((item) => item.info.id === "msg-assistant-small")
    assert.ok(nonSelectedRun)
    assert.ok(!nonSelectedRun.parts.some((part) => part.type === "tool" || part.type === "reasoning"))

    const tailAssistant = messages.find((item) => item.info.id === "msg-assistant-tail")
    assert.ok(tailAssistant)
})

test("prefix summary fires when pruning cannot get the applied output below trigger", () => {
    const messages = buildMultiRunConversation()
    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 500,
        recentToolResultBudgetTokens: 0,
    })
    assert.ok(plan)
    assert.equal(plan.requiresCustomCompaction, true)
    assert.ok(plan.stages.some((stage) => stage.name === "prefix-summary"))

    applyBoundaryContextPlan(messages, plan)

    assert.equal(plan.afterPruneTokens, estimateOpenCodeMessages(messages))
    assert.ok(messages[0]?.info.id.startsWith("msg_better_compact_summary_"))
    assert.equal(messages.at(-1)?.info.id, "msg-user-4")
})

test("boundary report shows visual context bars without internal threshold jargon", () => {
    const plan = buildBoundaryContextPlan(buildLargeConversation(), {
        contextLimit: 20_000,
        force: true,
        recentToolResultBudgetTokens: 0,
        providerReportedTokens: 18_000,
    })
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

test("boundary projection does not scale transformed context by raw provider ratio", () => {
    const messages = buildLargeConversation()
    const providerReportedTokens = 10_000
    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 100_000,
        force: true,
        providerReportedTokens,
        recentToolResultBudgetTokens: 0,
    })
    assert.ok(plan)

    const transformed = messages.map((item) => ({ info: item.info, parts: [...item.parts] }))
    applyBoundaryContextPlan(transformed, plan)
    const directAfter = estimateOpenCodeMessages(transformed)
    const oldScaledAfter = Math.round(directAfter * (providerReportedTokens / estimateOpenCodeMessages(messages)))

    assert.equal(plan.beforeTokens, providerReportedTokens)
    assert.equal(plan.afterPruneTokens, directAfter)
    assert.ok(plan.afterPruneTokens > oldScaledAfter * 2)
})

function storedPlanFor(messages: WithParts[]) {
    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 40_000,
        recentToolResultBudgetTokens: 0,
    })
    assert.ok(plan)
    const state = createSessionState()
    state.sessionId = sessionID
    storeBoundaryPlan(state, plan)
    assert.ok(state.boundary.activePlan)
    return state.boundary.activePlan
}

test("plan snapshot refuses to apply when the prefix was edited", () => {
    const activePlan = storedPlanFor(buildMultiRunConversation())

    const replayMessages = buildMultiRunConversation()
    assert.equal(applyBoundaryPlanSnapshot(replayMessages, activePlan), true)
    assert.ok(replayMessages.some((item) => item.info.id.startsWith("msg_better_compact_context_")))

    const editedMessages = buildMultiRunConversation()
    editedMessages[1].info.time.created = 999
    const before = JSON.stringify(editedMessages)
    assert.equal(applyBoundaryPlanSnapshot(editedMessages, activePlan), false)
    assert.equal(JSON.stringify(editedMessages), before)
})

test("plan snapshot refuses to apply once the transformed output regrows past trigger", () => {
    const activePlan = storedPlanFor(buildMultiRunConversation())

    const regrown = buildMultiRunConversation()
    for (let index = 0; index < 12; index++) {
        regrown.push(
            message(`msg-user-new-${index}`, "user", [textPart(`msg-user-new-${index}`, "next task")], 100 + index * 2),
            message(
                `msg-assistant-new-${index}`,
                "assistant",
                [textPart(`msg-assistant-new-${index}`, "fresh assistant output ".repeat(2_000))],
                101 + index * 2,
            ),
        )
    }
    const before = JSON.stringify(regrown)
    assert.equal(applyBoundaryPlanSnapshot(regrown, activePlan), false)
    assert.equal(JSON.stringify(regrown), before)
})

test("provider-reported totals keep plan accounting on a single scale", () => {
    const messages = buildMultiRunConversation()
    const rawEstimate = estimateOpenCodeMessages(messages)
    const providerReportedTokens = rawEstimate + 50_000
    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 120_000,
        force: true,
        recentToolResultBudgetTokens: 0,
        providerReportedTokens,
    })
    assert.ok(plan)

    assert.equal(plan.beforeTokens, providerReportedTokens)
    assert.equal(plan.overheadTokens, providerReportedTokens - rawEstimate)
    assert.ok(plan.afterPruneTokens >= plan.overheadTokens)
    assert.ok(plan.beforeTokens - plan.afterPruneTokens >= 0)
    for (const stage of plan.stages) {
        assert.ok(stage.beforeTokens >= plan.overheadTokens)
        assert.ok(stage.afterTokens >= plan.overheadTokens)
        assert.ok(stage.clearedTokens <= plan.beforeTokens)
    }

    applyBoundaryContextPlan(messages, plan)
    assert.equal(plan.afterPruneTokens, estimateOpenCodeMessages(messages) + plan.overheadTokens)
})

test("boundary planner marks custom compaction as last resort only after pruning is still too large", () => {
    const messages = buildLargeConversation()
    const plan = buildBoundaryContextPlan(messages, { contextLimit: 200, recentToolResultBudgetTokens: 0 })

    assert.ok(plan)
    assert.equal(plan.requiresCustomCompaction, true)
})

test("boundary planner preserves the latest two user turns as raw tail", () => {
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "old user")], 1),
        message("msg-assistant-1", "assistant", [toolPart("msg-assistant-1", "read", "old output ".repeat(4_000))], 2),
        message("msg-user-2", "user", [textPart("msg-user-2", "middle user must stay raw")], 3),
        message("msg-assistant-2", "assistant", [textPart("msg-assistant-2", "middle assistant must stay raw")], 4),
        message("msg-user-3", "user", [textPart("msg-user-3", "latest user must stay raw")], 5),
        message("msg-assistant-3", "assistant", [textPart("msg-assistant-3", "latest assistant must stay raw")], 6),
    ]
    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 10_000,
        force: true,
        recentToolResultBudgetTokens: 0,
    })
    assert.ok(plan)

    applyBoundaryContextPlan(messages, plan)

    assert.ok(messages.some((item) => item.info.id === "msg-user-2"))
    assert.ok(messages.some((item) => item.info.id === "msg-assistant-2"))
    assert.ok(messages.some((item) => item.info.id === "msg-user-3"))
    assert.ok(messages.some((item) => item.info.id === "msg-assistant-3"))
    const oldAssistant = messages.find((item) => item.info.id === "msg-assistant-1")
    assert.equal(oldAssistant?.parts[0]?.type, "text")
    if (oldAssistant?.parts[0]?.type === "text") {
        assert.match(oldAssistant.parts[0].text, /tool calls\/results cleared|Assistant turn summary/)
        assert.doesNotMatch(oldAssistant.parts[0].text, /old output/)
    }
})

test("boundary planner compactifies contiguous assistant messages within an old turn", () => {
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "old turn")], 1),
        message("msg-assistant-1", "assistant", [textPart("msg-assistant-1", "first assistant detail ".repeat(4_000))], 2),
        message("msg-assistant-2", "assistant", [toolPart("msg-assistant-2", "bash", "build output ".repeat(4_000), { command: "npm test" })], 3),
        message("msg-user-2", "user", [textPart("msg-user-2", "middle user")], 4),
        message("msg-assistant-3", "assistant", [textPart("msg-assistant-3", "middle assistant")], 5),
        message("msg-user-3", "user", [textPart("msg-user-3", "latest user")], 6),
    ]
    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 5_000,
        force: true,
        recentToolResultBudgetTokens: 0,
    })
    assert.ok(plan)
    assert.ok(plan.stages.some((stage) => stage.name === "assistant-runs"))
    assert.ok(plan.summaryJobs.length > 0)

    applyBoundaryContextPlan(messages, plan)

    const oldAssistantMessages = messages.filter((item) => item.info.id === "msg-assistant-1" || item.info.id === "msg-assistant-2")
    assert.equal(oldAssistantMessages.length, 1)
    const compactedText = oldAssistantMessages[0]?.parts[0]
    assert.equal(compactedText?.type, "text")
    if (compactedText?.type === "text") {
        assert.match(compactedText.text, /first assistant detail/)
        assert.doesNotMatch(compactedText.text, /npm test/)
        assert.doesNotMatch(compactedText.text, /build output/)
    }
})

test("boundary planner ranks assistant turns and summarizes only enough to meet target", () => {
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "old user")], 1),
        message("msg-assistant-big-old", "assistant", [textPart("msg-assistant-big-old", "big old detail ".repeat(8_000))], 2),
        message("msg-user-2", "user", [textPart("msg-user-2", "middle user")], 3),
        message("msg-assistant-small-old", "assistant", [textPart("msg-assistant-small-old", "small old detail ".repeat(200))], 4),
        message("msg-user-3", "user", [textPart("msg-user-3", "newer user")], 5),
        message("msg-assistant-big-newer", "assistant", [textPart("msg-assistant-big-newer", "big newer detail ".repeat(8_000))], 6),
        message("msg-user-4", "user", [textPart("msg-user-4", "tail user")], 7),
        message("msg-assistant-tail", "assistant", [textPart("msg-assistant-tail", "tail assistant")], 8),
        message("msg-user-5", "user", [textPart("msg-user-5", "latest user")], 9),
    ]

    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 50_000,
        force: true,
        targetRatio: 0.7,
        recentToolResultBudgetTokens: 0,
    })

    assert.ok(plan)
    assert.ok(plan.summaryJobs.length > 0)
    assert.ok(plan.summaryJobs.length < 3)
    assert.match(plan.summaryJobs[0].rangeStartMessageId, /msg-assistant-big/)
})

test("boundary planner preserves recent tool results under the tool-tail budget", () => {
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "old user")], 1),
        message("msg-assistant-old", "assistant", [toolPart("msg-assistant-old", "read", "old output ".repeat(4_000))], 2),
        message("msg-user-2", "user", [textPart("msg-user-2", "middle user")], 3),
        message("msg-assistant-recent", "assistant", [toolPart("msg-assistant-recent", "read", "recent output ".repeat(200))], 4),
        message("msg-user-3", "user", [textPart("msg-user-3", "tail user")], 5),
        message("msg-assistant-tail", "assistant", [textPart("msg-assistant-tail", "tail assistant")], 6),
        message("msg-user-4", "user", [textPart("msg-user-4", "latest user")], 7),
    ]

    const plan = buildBoundaryContextPlan(messages, {
        contextLimit: 10_000,
        force: true,
        recentToolResultBudgetTokens: 1_500,
    })
    assert.ok(plan)
    assert.equal(plan.preservedToolCallIds.length, 1)
    assert.match(plan.preservedToolCallIds[0], /msg-assistant-recent-read-call/)

    applyBoundaryContextPlan(messages, plan)

    const oldAssistant = messages.find((item) => item.info.id === "msg-assistant-old")
    assert.equal(oldAssistant?.parts[0]?.type, "text")
    if (oldAssistant?.parts[0]?.type === "text") {
        assert.doesNotMatch(oldAssistant.parts[0].text, /old output/)
    }

    const recentAssistant = messages.find((item) => item.info.id === "msg-assistant-recent")
    const recentTool = recentAssistant?.parts.find((part) => part.type === "tool")
    assert.equal(recentTool?.type, "tool")
    if (recentTool?.type === "tool") {
        assert.match(String(recentTool.state.output), /recent output/)
    }
})

test("boundary planner preserves only the latest compacted todo state", () => {
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "old turn")], 1),
        message(
            "msg-assistant-1",
            "assistant",
            [
                toolPart("msg-assistant-1", "todowrite", "old todos", {
                    todos: [{ content: "obsolete task", status: "pending", priority: "high" }],
                }),
                toolPart("msg-assistant-1", "todowrite", "latest todos", {
                    todos: [{ content: "current task", status: "in_progress", priority: "high" }],
                }),
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

    applyBoundaryContextPlan(messages, plan)

    const compactedAssistantText = messages.find((item) => item.info.id === "msg-assistant-1")?.parts[0]
    assert.equal(compactedAssistantText?.type, "text")
    if (compactedAssistantText?.type === "text") {
        assert.match(compactedAssistantText.text, /Latest todo state preserved/)
        assert.match(compactedAssistantText.text, /current task/)
        assert.doesNotMatch(compactedAssistantText.text, /obsolete task/)
    }
})

test("boundary planner removes errored tool details from compactified turns", () => {
    const messages = [
        message("msg-user-1", "user", [textPart("msg-user-1", "old turn")], 1),
        message("msg-assistant-1", "assistant", [errorToolPart("msg-assistant-1", "bash", "ENOENT: missing config", { command: "npm run test" })], 2),
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
    assert.equal(plan.transcript.content, "")
    assert.deepEqual(plan.transcript.messageIds, ["msg-user-1", "msg-assistant-1"])

    applyBoundaryContextPlan(messages, plan)

    const compactedAssistantText = messages.find((item) => item.info.id === "msg-assistant-1")?.parts[0]
    assert.equal(compactedAssistantText?.type, "text")
    if (compactedAssistantText?.type === "text") {
        assert.match(compactedAssistantText.text, /tool calls\/results cleared|Assistant turn summary/)
        assert.doesNotMatch(compactedAssistantText.text, /ENOENT: missing config/)
        assert.doesNotMatch(compactedAssistantText.text, /npm run test/)
    }
})
