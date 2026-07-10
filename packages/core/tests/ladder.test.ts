import assert from "node:assert/strict"
import test from "node:test"
import {
    assistantRunsStage,
    buildPlan,
    countTokens,
    createEngine,
    reasoningStage,
    replayPlanSnapshot,
    skillsStage,
    toolsOldStage,
    toolsRemainingStage,
    toPlanSnapshot,
    transformTurns,
    type BuildPlanInputs,
    type CodecOps,
    type Conventions,
    type Item,
    type LadderSpec,
    type Turn,
} from "@better-compact/core"

// A minimal platform: handles carry simple part records and the codec prices
// turns as the JSON model shape a host would serialize, mirroring how real
// codecs price their own native forms.

interface TestTextPart {
    type: "text"
    text: string
}

interface TestReasoningPart {
    type: "reasoning"
    text: string
}

interface TestToolPart {
    type: "tool"
    tool: string
    input: unknown
    output?: string
    error?: string
}

type TestPart = TestTextPart | TestReasoningPart | TestToolPart

function modelLikeItem(item: Item): unknown[] {
    if (item.kind === "synthetic") return [{ type: "text", text: item.text }]
    const part = item.handle as TestPart
    if (part.type === "text") return [{ type: "text", text: part.text }]
    if (part.type === "reasoning") return [{ type: "reasoning", text: part.text }]
    if (part.type === "tool") return [toolShape(part)]
    return []
}

function toolShape(part: TestToolPart): unknown {
    if (part.error !== undefined) {
        return { type: `tool-${part.tool}`, state: "output-error", input: part.input, errorText: part.error }
    }
    return { type: `tool-${part.tool}`, state: "output-available", input: part.input, output: part.output }
}

const codec: CodecOps = {
    estimateTurns(turns) {
        const modelLike = turns
            .map((turn) => ({ role: turn.role, parts: turn.items.flatMap(modelLikeItem) }))
            .filter((entry) => entry.parts.length > 0)
        return countTokens(JSON.stringify(modelLike))
    },
    estimateItem(item) {
        return countTokens(JSON.stringify(toolShape(item.handle as TestToolPart)))
    },
    transcriptLine(item) {
        if (item.kind === "synthetic") return item.text
        const part = item.handle as TestPart
        if (part.type === "text") return part.text
        if (part.type === "reasoning") return `[reasoning]\n${part.text}`
        return `[tool:${part.tool}] input=${JSON.stringify(part.input)} output=${part.output ?? ""} error=${part.error ?? ""}`
    },
}

function toolHandle(item: Item): TestToolPart | null {
    return item.kind === "tool" ? (item.handle as TestToolPart) : null
}

const conventions: Conventions = {
    isSkillItem: (item) => toolHandle(item)?.tool === "skill",
    todo: {
        isTodoItem: (item) => toolHandle(item)?.tool === "todowrite",
        format: (item) => {
            const input = toolHandle(item)?.input as { todos: Array<Record<string, string>> }
            return input.todos
                .map((todo, index) => `${index + 1}. [${todo.status}/${todo.priority}] ${todo.content}`)
                .join("; ")
        },
    },
}

const spec: LadderSpec = {
    codec,
    conventions,
    stages: [skillsStage, toolsOldStage, reasoningStage, toolsRemainingStage, assistantRunsStage],
}

const sessionKey = "ses_boundary_context"

function inputs(options: Partial<BuildPlanInputs> = {}): BuildPlanInputs {
    return {
        sessionKey,
        citablePath: (key, hash) => `.opencode/better-compact/sessions/${key}/${hash}.md`,
        ...options,
    }
}

function textItem(turnKey: string, text: string): Item {
    return { kind: "text", key: `${turnKey}-part`, text, handle: { type: "text", text } satisfies TestPart }
}

function reasoningItem(turnKey: string, text: string): Item {
    return { kind: "reasoning", key: `${turnKey}-reasoning`, handle: { type: "reasoning", text } satisfies TestPart }
}

function toolItem(turnKey: string, tool: string, output: string, input?: Record<string, unknown>): Item {
    const resolvedInput = input ?? (tool === "skill" ? { name: "root-cause-debug" } : { filePath: "src/app.ts" })
    return {
        kind: "tool",
        key: `${turnKey}-${tool}`,
        callId: `${turnKey}-${tool}-call-${output.length}-${JSON.stringify(resolvedInput).length}`,
        handle: { type: "tool", tool, input: resolvedInput, output } satisfies TestPart,
    }
}

function errorToolItem(turnKey: string, tool: string, error: string, input: Record<string, unknown>): Item {
    return {
        kind: "tool",
        key: `${turnKey}-${tool}`,
        callId: `${turnKey}-${tool}-call`,
        handle: { type: "tool", tool, input, error } satisfies TestPart,
    }
}

function turn(key: string, role: "user" | "assistant", items: Item[], stamp: number): Turn {
    return { key, stamp, role, items, handle: { key } }
}

// The single text item a pruned turn collapses to, whether a surviving
// original text or ladder-synthesized replacement text.
function syntheticTextOf(target: Turn | undefined): string {
    assert.ok(target)
    assert.equal(target.items.length, 1)
    const item = target.items[0]
    assert.ok(item.kind === "text" || item.kind === "synthetic")
    return item.kind === "text" || item.kind === "synthetic" ? item.text : ""
}

function buildLargeConversation(): Turn[] {
    const bigToolOutput = "tool-output ".repeat(4_000)
    return [
        turn("msg-user-1", "user", [textItem("msg-user-1", "Please preserve this exact requirement.")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [
                reasoningItem("msg-assistant-1", "private reasoning ".repeat(2_000)),
                textItem("msg-assistant-1", "Investigated the OpenCode compaction path."),
                toolItem("msg-assistant-1", "read", bigToolOutput),
                toolItem("msg-assistant-1", "skill", "skill content ".repeat(2_000)),
            ],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "Continue with the plugin-only design.")], 3),
        turn("msg-assistant-2", "assistant", [textItem("msg-assistant-2", "Recent assistant tail should remain raw.")], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "Latest user tail should remain raw.")], 5),
    ]
}

function buildMultiRunConversation(): Turn[] {
    return [
        turn("msg-user-1", "user", [textItem("msg-user-1", "First task, keep this requirement.")], 1),
        turn(
            "msg-assistant-big",
            "assistant",
            [
                reasoningItem("msg-assistant-big", "big private reasoning ".repeat(500)),
                textItem("msg-assistant-big", "big assistant detail ".repeat(7_000)),
                toolItem("msg-assistant-big", "read", "big tool output ".repeat(500)),
            ],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "Second task.")], 3),
        turn(
            "msg-assistant-small",
            "assistant",
            [
                reasoningItem("msg-assistant-small", "small private reasoning ".repeat(200)),
                textItem("msg-assistant-small", "small assistant detail"),
                toolItem("msg-assistant-small", "grep", "small tool output ".repeat(200), { pattern: "needle" }),
            ],
            4,
        ),
        turn("msg-user-3", "user", [textItem("msg-user-3", "Third task stays raw.")], 5),
        turn("msg-assistant-tail", "assistant", [textItem("msg-assistant-tail", "tail assistant")], 6),
        turn("msg-user-4", "user", [textItem("msg-user-4", "Latest user stays raw.")], 7),
    ]
}

test("planner does nothing before 85 percent usage", () => {
    const plan = buildPlan(
        [turn("msg-user-small", "user", [textItem("msg-user-small", "small")], 1)],
        inputs({ contextLimit: 100_000 }),
        spec,
    )

    assert.equal(plan, null)
})

test("planner compactifies old assistant/tool context and preserves raw tail", () => {
    const turns = buildLargeConversation()
    const plan = buildPlan(turns, inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }), spec)

    assert.ok(plan)
    assert.ok(plan.afterPruneTokens < plan.beforeTokens)
    assert.ok(plan.stages.some((stage) => stage.name === "reasoning" && stage.clearedTokens > 0))
    assert.ok(plan.stages.some((stage) => stage.name === "skills" && stage.clearedTokens > 0))
    assert.ok(plan.stages.some((stage) => stage.name === "tools-old" && stage.clearedTokens > 0))
    assert.match(plan.transcript.relativePath, /^\.opencode\/better-compact\/sessions\/ses_boundary_context\//)
    assert.equal(plan.transcript.content, "")
    assert.deepEqual(plan.transcript.messageIds, ["msg-user-1", "msg-assistant-1"])

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    assert.equal(transformed.at(-1)?.key, "msg-user-3")
    assert.equal(transformed.at(-2)?.key, "msg-assistant-2")
    assert.equal(transformed.at(-3)?.key, "msg-user-2")

    const firstUserItem = transformed[0]?.items[0]
    assert.equal(firstUserItem?.kind, "text")
    if (firstUserItem?.kind === "text") {
        assert.equal(firstUserItem.text, "Please preserve this exact requirement.")
    }

    const compactedText = syntheticTextOf(transformed[1])
    assert.match(compactedText, /Investigated the OpenCode compaction path/)
    assert.doesNotMatch(compactedText, /private reasoning/)
    assert.doesNotMatch(compactedText, /skill content/)
    assert.doesNotMatch(compactedText, /tool-output/)

    const reference = transformed.find((item) => item.key.startsWith("better_compact_context_"))
    assert.ok(reference)
    const referenceText = syntheticTextOf(reference)
    assert.match(referenceText, /## Reference Files/)
    assert.match(referenceText, new RegExp(plan.transcript.relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
})

test("applied output matches the simulated plan when assistant runs are summarized", () => {
    const turns = buildMultiRunConversation()
    const options = inputs({ contextLimit: 40_000, recentToolResultBudgetTokens: 0 })
    const firstPass = buildPlan(turns, options, spec)
    assert.ok(firstPass)
    assert.ok(firstPass.stages.some((stage) => stage.name === "assistant-runs" && stage.status === "applied"))
    assert.ok(firstPass.summaryJobs.length > 0)

    const assistantSummaries = Object.fromEntries(
        firstPass.assistantSummaryKeys.map((key) => [key, "Accepted summary: shipped the first task end to end."]),
    )
    const plan = buildPlan(turns, { ...options, assistantSummaries }, spec)
    assert.ok(plan)
    assert.equal(plan.summaryJobs.length, 0)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    assert.equal(plan.afterPruneTokens, codec.estimateTurns(transformed))
    assert.ok(!plan.stages.some((stage) => stage.name === "prefix-summary"))
    assert.ok(codec.estimateTurns(transformed) < plan.triggerTokens)

    const selectedRun = transformed.find((item) => item.key === "msg-assistant-big")
    assert.match(syntheticTextOf(selectedRun), /Accepted summary: shipped the first task end to end\./)

    // The core drift bug: non-selected prefix runs must keep the stage 1-4
    // pruning (no tool/reasoning items) in the applied output.
    const nonSelectedRun = transformed.find((item) => item.key === "msg-assistant-small")
    assert.ok(nonSelectedRun)
    assert.ok(!nonSelectedRun.items.some((item) => item.kind === "tool" || item.kind === "reasoning"))

    assert.ok(transformed.some((item) => item.key === "msg-assistant-tail"))
})

test("prefix summary fires when pruning cannot get the applied output below trigger", () => {
    const turns = buildMultiRunConversation()
    const plan = buildPlan(turns, inputs({ contextLimit: 500, recentToolResultBudgetTokens: 0 }), spec)
    assert.ok(plan)
    assert.equal(plan.requiresCustomCompaction, true)
    assert.ok(plan.stages.some((stage) => stage.name === "prefix-summary"))

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    assert.equal(plan.afterPruneTokens, codec.estimateTurns(transformed))
    assert.ok(transformed[0]?.key.startsWith("better_compact_summary_"))
    assert.equal(transformed.at(-1)?.key, "msg-user-4")
})

test("projection does not scale transformed context by raw provider ratio", () => {
    const turns = buildLargeConversation()
    const providerReportedTokens = 10_000
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 100_000, force: true, providerReportedTokens, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const directAfter = codec.estimateTurns(transformed)
    const oldScaledAfter = Math.round(directAfter * (providerReportedTokens / codec.estimateTurns(turns)))

    assert.equal(plan.beforeTokens, providerReportedTokens)
    assert.equal(plan.afterPruneTokens, directAfter + plan.overheadTokens)
    assert.ok(plan.afterPruneTokens > oldScaledAfter * 2)
})

function storedPlanFor(turns: Turn[]) {
    const plan = buildPlan(turns, inputs({ contextLimit: 40_000, recentToolResultBudgetTokens: 0 }), spec)
    assert.ok(plan)
    return toPlanSnapshot(plan)
}

test("plan snapshot refuses to apply when the prefix was edited", () => {
    const snapshot = storedPlanFor(buildMultiRunConversation())

    const replayed = replayPlanSnapshot(buildMultiRunConversation(), snapshot, spec)
    assert.ok(replayed)
    assert.ok(replayed.some((item) => item.key.startsWith("better_compact_context_")))

    const edited = buildMultiRunConversation()
    edited[1].stamp = 999
    assert.equal(replayPlanSnapshot(edited, snapshot, spec), null)
})

test("plan snapshot refuses to apply once the transformed output regrows past trigger", () => {
    const snapshot = storedPlanFor(buildMultiRunConversation())

    const regrown = buildMultiRunConversation()
    for (let index = 0; index < 12; index++) {
        regrown.push(
            turn(`msg-user-new-${index}`, "user", [textItem(`msg-user-new-${index}`, "next task")], 100 + index * 2),
            turn(
                `msg-assistant-new-${index}`,
                "assistant",
                [textItem(`msg-assistant-new-${index}`, "fresh assistant output ".repeat(2_000))],
                101 + index * 2,
            ),
        )
    }
    assert.equal(replayPlanSnapshot(regrown, snapshot, spec), null)
})

test("provider-reported totals keep plan accounting on a single scale", () => {
    const turns = buildMultiRunConversation()
    const rawEstimate = codec.estimateTurns(turns)
    const providerReportedTokens = rawEstimate + 50_000
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 120_000, force: true, recentToolResultBudgetTokens: 0, providerReportedTokens }),
        spec,
    )
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

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    assert.equal(plan.afterPruneTokens, codec.estimateTurns(transformed) + plan.overheadTokens)
})

test("planner marks custom compaction as last resort only after pruning is still too large", () => {
    const plan = buildPlan(buildLargeConversation(), inputs({ contextLimit: 200, recentToolResultBudgetTokens: 0 }), spec)

    assert.ok(plan)
    assert.equal(plan.requiresCustomCompaction, true)
})

test("planner preserves the latest two user turns as raw tail", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old user")], 1),
        turn("msg-assistant-1", "assistant", [toolItem("msg-assistant-1", "read", "old output ".repeat(4_000))], 2),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user must stay raw")], 3),
        turn("msg-assistant-2", "assistant", [textItem("msg-assistant-2", "middle assistant must stay raw")], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user must stay raw")], 5),
        turn("msg-assistant-3", "assistant", [textItem("msg-assistant-3", "latest assistant must stay raw")], 6),
    ]
    const plan = buildPlan(turns, inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }), spec)
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    assert.ok(transformed.some((item) => item.key === "msg-user-2"))
    assert.ok(transformed.some((item) => item.key === "msg-assistant-2"))
    assert.ok(transformed.some((item) => item.key === "msg-user-3"))
    assert.ok(transformed.some((item) => item.key === "msg-assistant-3"))
    const oldAssistantText = syntheticTextOf(transformed.find((item) => item.key === "msg-assistant-1"))
    assert.match(oldAssistantText, /tool calls\/results cleared|Assistant turn summary/)
    assert.doesNotMatch(oldAssistantText, /old output/)
})

test("planner compactifies contiguous assistant turns within an old turn", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn("msg-assistant-1", "assistant", [textItem("msg-assistant-1", "first assistant detail ".repeat(4_000))], 2),
        turn(
            "msg-assistant-2",
            "assistant",
            [toolItem("msg-assistant-2", "bash", "build output ".repeat(4_000), { command: "npm test" })],
            3,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 4),
        turn("msg-assistant-3", "assistant", [textItem("msg-assistant-3", "middle assistant")], 5),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user")], 6),
    ]
    const plan = buildPlan(turns, inputs({ contextLimit: 5_000, force: true, recentToolResultBudgetTokens: 0 }), spec)
    assert.ok(plan)
    assert.ok(plan.stages.some((stage) => stage.name === "assistant-runs"))
    assert.ok(plan.summaryJobs.length > 0)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    const oldAssistantTurns = transformed.filter((item) => item.key === "msg-assistant-1" || item.key === "msg-assistant-2")
    assert.equal(oldAssistantTurns.length, 1)
    const compactedText = syntheticTextOf(oldAssistantTurns[0])
    assert.match(compactedText, /first assistant detail/)
    assert.doesNotMatch(compactedText, /npm test/)
    assert.doesNotMatch(compactedText, /build output/)
})

test("planner ranks assistant turns and summarizes only enough to meet target", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old user")], 1),
        turn("msg-assistant-big-old", "assistant", [textItem("msg-assistant-big-old", "big old detail ".repeat(8_000))], 2),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn("msg-assistant-small-old", "assistant", [textItem("msg-assistant-small-old", "small old detail ".repeat(200))], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "newer user")], 5),
        turn("msg-assistant-big-newer", "assistant", [textItem("msg-assistant-big-newer", "big newer detail ".repeat(8_000))], 6),
        turn("msg-user-4", "user", [textItem("msg-user-4", "tail user")], 7),
        turn("msg-assistant-tail", "assistant", [textItem("msg-assistant-tail", "tail assistant")], 8),
        turn("msg-user-5", "user", [textItem("msg-user-5", "latest user")], 9),
    ]

    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 50_000, force: true, targetRatio: 0.7, recentToolResultBudgetTokens: 0 }),
        spec,
    )

    assert.ok(plan)
    assert.ok(plan.summaryJobs.length > 0)
    assert.ok(plan.summaryJobs.length < 3)
    assert.match(plan.summaryJobs[0].rangeStartMessageId, /msg-assistant-big/)
})

test("planner preserves recent tool results under the tool-tail budget", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old user")], 1),
        turn("msg-assistant-old", "assistant", [toolItem("msg-assistant-old", "read", "old output ".repeat(4_000))], 2),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn("msg-assistant-recent", "assistant", [toolItem("msg-assistant-recent", "read", "recent output ".repeat(200))], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "tail user")], 5),
        turn("msg-assistant-tail", "assistant", [textItem("msg-assistant-tail", "tail assistant")], 6),
        turn("msg-user-4", "user", [textItem("msg-user-4", "latest user")], 7),
    ]

    const plan = buildPlan(turns, inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 1_500 }), spec)
    assert.ok(plan)
    assert.equal(plan.preservedToolCallIds.length, 1)
    assert.match(plan.preservedToolCallIds[0], /msg-assistant-recent-read-call/)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    const oldAssistantText = syntheticTextOf(transformed.find((item) => item.key === "msg-assistant-old"))
    assert.doesNotMatch(oldAssistantText, /old output/)

    const recentAssistant = transformed.find((item) => item.key === "msg-assistant-recent")
    const recentTool = recentAssistant?.items.find((item) => item.kind === "tool")
    assert.equal(recentTool?.kind, "tool")
    if (recentTool?.kind === "tool") {
        assert.match(String((recentTool.handle as TestToolPart).output), /recent output/)
    }
})

test("planner preserves only the latest compacted todo state", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [
                toolItem("msg-assistant-1", "todowrite", "old todos", {
                    todos: [{ content: "obsolete task", status: "pending", priority: "high" }],
                }),
                toolItem("msg-assistant-1", "todowrite", "latest todos", {
                    todos: [{ content: "current task", status: "in_progress", priority: "high" }],
                }),
            ],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn("msg-assistant-2", "assistant", [textItem("msg-assistant-2", "middle assistant")], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user")], 5),
    ]
    const plan = buildPlan(turns, inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }), spec)
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    const compactedText = syntheticTextOf(transformed.find((item) => item.key === "msg-assistant-1"))
    assert.match(compactedText, /Latest todo state preserved/)
    assert.match(compactedText, /current task/)
    assert.doesNotMatch(compactedText, /obsolete task/)
})

test("planner removes errored tool details from compactified turns", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [errorToolItem("msg-assistant-1", "bash", "ENOENT: missing config", { command: "npm run test" })],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn("msg-assistant-2", "assistant", [textItem("msg-assistant-2", "middle assistant")], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user")], 5),
    ]
    const plan = buildPlan(turns, inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }), spec)
    assert.ok(plan)
    assert.equal(plan.transcript.content, "")
    assert.deepEqual(plan.transcript.messageIds, ["msg-user-1", "msg-assistant-1"])

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    const compactedText = syntheticTextOf(transformed.find((item) => item.key === "msg-assistant-1"))
    assert.match(compactedText, /tool calls\/results cleared|Assistant turn summary/)
    assert.doesNotMatch(compactedText, /ENOENT: missing config/)
    assert.doesNotMatch(compactedText, /npm run test/)
})

test("engine prunes on provider-reported usage the raw estimate alone misses", async () => {
    const turns = buildMultiRunConversation()
    const contextLimit = codec.estimateTurns(turns) * 2
    const engine = createEngine(spec, {
        transcripts: {
            citablePath: (key, hash) => `transcripts/${key}/${hash}.md`,
            write: async () => ({}),
        },
        plans: { load: () => null, save: () => {} },
        logger: { info() {}, debug() {}, warn() {}, error() {} },
    })

    const withoutUsage = await engine.process({ sessionKey, turns, contextLimit })
    assert.equal(withoutUsage.outcome, "unchanged")

    const withUsage = await engine.process({
        sessionKey,
        turns,
        contextLimit,
        providerReportedTokens: Math.floor(contextLimit * 0.9),
    })
    assert.equal(withUsage.outcome, "planned")
})
