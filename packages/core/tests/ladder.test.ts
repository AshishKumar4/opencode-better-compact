import assert from "node:assert/strict"
import test from "node:test"
import {
    assistantRunsStage,
    buildPlan,
    countTokens,
    createEngine,
    reasoningStage,
    replayPlanSnapshot,
    purgeErrorInputsStage,
    skillsStage,
    supersedeReadsStage,
    toolsOldStage,
    toolsRemainingStage,
    toPlanSnapshot,
    transformTurns,
    type BuildPlanInputs,
    type CodecOps,
    type Conventions,
    type Item,
    type LadderSpec,
    type PlanSnapshot,
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
        return {
            type: `tool-${part.tool}`,
            state: "output-error",
            input: part.input,
            errorText: part.error,
        }
    }
    return {
        type: `tool-${part.tool}`,
        state: "output-available",
        input: part.input,
        output: part.output,
    }
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
    tool: (item) => {
        const tool = item.handle as TestToolPart
        return { name: tool.tool, input: tool.input, error: tool.error }
    },
    todo: {
        isTodoItem: (item) => toolHandle(item)?.tool === "todowrite",
        format: (item) => {
            const input = toolHandle(item)?.input as { todos: Array<Record<string, string>> }
            return input.todos
                .map(
                    (todo, index) =>
                        `${index + 1}. [${todo.status}/${todo.priority}] ${todo.content}`,
                )
                .join("; ")
        },
    },
}

const spec: LadderSpec = {
    codec,
    conventions,
    stages: [
        skillsStage,
        supersedeReadsStage,
        purgeErrorInputsStage,
        toolsOldStage,
        reasoningStage,
        toolsRemainingStage,
        assistantRunsStage,
    ],
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
    return {
        kind: "text",
        key: `${turnKey}-part`,
        text,
        handle: { type: "text", text } satisfies TestPart,
    }
}

function reasoningItem(turnKey: string, text: string): Item {
    return {
        kind: "reasoning",
        key: `${turnKey}-reasoning`,
        handle: { type: "reasoning", text } satisfies TestPart,
    }
}

function toolItem(
    turnKey: string,
    tool: string,
    output: string,
    input?: Record<string, unknown>,
): Item {
    const resolvedInput =
        input ?? (tool === "skill" ? { name: "root-cause-debug" } : { filePath: "src/app.ts" })
    return {
        kind: "tool",
        key: `${turnKey}-${tool}`,
        callId: `${turnKey}-${tool}-call-${output.length}-${JSON.stringify(resolvedInput).length}`,
        handle: { type: "tool", tool, input: resolvedInput, output } satisfies TestPart,
    }
}

function errorToolItem(
    turnKey: string,
    tool: string,
    error: string,
    input: Record<string, unknown>,
): Item {
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

function syntheticTextOf(target: Turn | undefined): string {
    assert.ok(target)
    return target.items
        .filter(
            (item): item is Extract<Item, { kind: "text" | "synthetic" }> =>
                item.kind === "text" || item.kind === "synthetic",
        )
        .map((item) => item.text)
        .join("\n")
}

function buildLargeConversation(): Turn[] {
    const bigToolOutput = "tool-output ".repeat(4_000)
    return [
        turn(
            "msg-user-1",
            "user",
            [textItem("msg-user-1", "Please preserve this exact requirement.")],
            1,
        ),
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
        turn(
            "msg-user-2",
            "user",
            [textItem("msg-user-2", "Continue with the plugin-only design.")],
            3,
        ),
        turn(
            "msg-assistant-2",
            "assistant",
            [textItem("msg-assistant-2", "Recent assistant tail should remain raw.")],
            4,
        ),
        turn(
            "msg-user-3",
            "user",
            [textItem("msg-user-3", "Latest user tail should remain raw.")],
            5,
        ),
    ]
}

function buildMultiRunConversation(): Turn[] {
    return [
        turn(
            "msg-user-1",
            "user",
            [textItem("msg-user-1", "First task, keep this requirement.")],
            1,
        ),
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
                toolItem("msg-assistant-small", "grep", "small tool output ".repeat(200), {
                    pattern: "needle",
                }),
            ],
            4,
        ),
        turn("msg-user-3", "user", [textItem("msg-user-3", "Third task stays raw.")], 5),
        turn(
            "msg-assistant-tail",
            "assistant",
            [textItem("msg-assistant-tail", "tail assistant")],
            6,
        ),
        turn("msg-user-4", "user", [textItem("msg-user-4", "Latest user stays raw.")], 7),
    ]
}

function buildReferenceIndexConversation(): Turn[] {
    const longTodo = "follow-up ".repeat(70).trim()
    return [
        turn("msg-user-1", "user", [textItem("msg-user-1", "Implement the parser change.")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [
                textItem(
                    "msg-assistant-1",
                    "Implemented the parser change. Follow-up narration.\nExtra details.",
                ),
                toolItem("msg-assistant-1", "read", "source", { filePath: "src/./parser.ts" }),
            ],
            2,
        ),
        turn(
            "msg-assistant-1b",
            "assistant",
            [toolItem("msg-assistant-1b", "bash", "passing", { command: "pnpm test" })],
            3,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "Verify the edge case.")], 4),
        turn(
            "msg-assistant-2",
            "assistant",
            [
                textItem("msg-assistant-2", "Verified the edge case."),
                toolItem("msg-assistant-2", "grep", "match", { pattern: "needle" }),
                toolItem("msg-assistant-2", "todowrite", "saved", {
                    todos: [
                        { content: "current task", status: "in_progress", priority: "high" },
                        { content: longTodo, status: "pending", priority: "medium" },
                    ],
                }),
            ],
            5,
        ),
        turn("msg-user-3", "user", [textItem("msg-user-3", "Keep this raw.")], 6),
        turn(
            "msg-assistant-tail",
            "assistant",
            [textItem("msg-assistant-tail", "Raw assistant tail.")],
            7,
        ),
        turn("msg-user-4", "user", [textItem("msg-user-4", "Latest user turn.")], 8),
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
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )

    assert.ok(plan)
    assert.ok(plan.afterPruneTokens < plan.beforeTokens)
    assert.ok(plan.stages.some((stage) => stage.name === "reasoning" && stage.clearedTokens > 0))
    assert.ok(plan.stages.some((stage) => stage.name === "skills" && stage.clearedTokens > 0))
    assert.ok(plan.stages.some((stage) => stage.name === "tools-old" && stage.clearedTokens > 0))
    assert.match(
        plan.transcript.relativePath,
        /^\.opencode\/better-compact\/sessions\/ses_boundary_context\//,
    )
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
    assert.match(
        referenceText,
        new RegExp(plan.transcript.relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    )
})

test("reference turn indexes every compacted assistant run and surfaces the latest todo", () => {
    const turns = buildReferenceIndexConversation()
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 1_000_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const referenceIndex = transformed.findIndex((item) =>
        item.key.startsWith("better_compact_context_"),
    )
    assert.ok(referenceIndex >= 0)
    assert.equal(transformed[referenceIndex + 1]?.key, "msg-user-3")

    const referenceText = syntheticTextOf(transformed[referenceIndex])
    const runLines = referenceText.split("\n").filter((line) => line.startsWith("- msg-assistant"))
    assert.deepEqual(runLines, [
        "- msg-assistant-1 through msg-assistant-1b — read src/parser.ts, bash pnpm test — Implemented the parser change.",
        "- msg-assistant-2 — grep needle, todowrite — Verified the edge case.",
    ])
    assert.equal(
        referenceText.split("\n").at(-1),
        `Latest todo state preserved: 1. [in_progress/high] current task; 2. [pending/medium] ${"follow-up ".repeat(70).trim()}`,
    )
})

test("reference index replays byte-stably", () => {
    const turns = buildReferenceIndexConversation()
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 1_000_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const replayed = replayPlanSnapshot(turns, toPlanSnapshot(plan), spec, { allowRegrown: true })

    assert.ok(replayed)
    assert.equal(JSON.stringify(replayed), JSON.stringify(transformed))
})

test("applied output matches the simulated plan when assistant runs are summarized", () => {
    const turns = buildMultiRunConversation()
    const options = inputs({ contextLimit: 40_000, recentToolResultBudgetTokens: 0 })
    const firstPass = buildPlan(turns, options, spec)
    assert.ok(firstPass)
    assert.ok(
        firstPass.stages.some(
            (stage) => stage.name === "assistant-runs" && stage.status === "applied",
        ),
    )
    assert.ok(firstPass.summaryJobs.length > 0)

    const assistantSummaries = Object.fromEntries(
        firstPass.assistantSummaryKeys.map((key) => [
            key,
            "Accepted summary: shipped the first task end to end.",
        ]),
    )
    const plan = buildPlan(turns, { ...options, assistantSummaries }, spec)
    assert.ok(plan)
    assert.equal(plan.summaryJobs.length, 0)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    assert.equal(plan.afterPruneTokens, codec.estimateTurns(transformed))
    assert.ok(!plan.stages.some((stage) => stage.name === "prefix-summary"))
    assert.ok(codec.estimateTurns(transformed) < plan.triggerTokens)

    const selectedRun = transformed.find((item) => item.key === "msg-assistant-big")
    assert.match(
        syntheticTextOf(selectedRun),
        /Accepted summary: shipped the first task end to end\./,
    )

    // The core drift bug: non-selected prefix runs must keep the stage 1-4
    // pruning (no tool/reasoning items) in the applied output.
    const nonSelectedRun = transformed.find((item) => item.key === "msg-assistant-small")
    assert.ok(nonSelectedRun)
    assert.ok(
        !nonSelectedRun.items.some((item) => item.kind === "tool" || item.kind === "reasoning"),
    )

    assert.ok(transformed.some((item) => item.key === "msg-assistant-tail"))
})

test("prefix summary fires when pruning cannot get the applied output below trigger", () => {
    const turns = buildMultiRunConversation()
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 500, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)
    assert.equal(plan.requiresCustomCompaction, true)
    assert.ok(plan.stages.some((stage) => stage.name === "prefix-summary"))

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const summary = syntheticTextOf(transformed[0])

    assert.equal(plan.afterPruneTokens, codec.estimateTurns(transformed))
    assert.ok(transformed[0]?.key.startsWith("better_compact_summary_"))
    assert.match(
        summary,
        /## Decisions[\s\S]*## Files & Symbols[\s\S]*## Errors \(verbatim\)[\s\S]*## What failed and why[\s\S]*## Constraints[\s\S]*## Next step/,
    )
    assert.equal(transformed.at(-1)?.key, "msg-user-4")
})

test("projection does not scale transformed context by raw provider ratio", () => {
    const turns = buildLargeConversation()
    const providerReportedTokens = 10_000
    const plan = buildPlan(
        turns,
        inputs({
            contextLimit: 100_000,
            force: true,
            providerReportedTokens,
            recentToolResultBudgetTokens: 0,
        }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const directAfter = codec.estimateTurns(transformed)
    const oldScaledAfter = Math.round(
        directAfter * (providerReportedTokens / codec.estimateTurns(turns)),
    )

    assert.equal(plan.beforeTokens, providerReportedTokens)
    assert.equal(plan.afterPruneTokens, directAfter + plan.overheadTokens)
    assert.ok(plan.afterPruneTokens > oldScaledAfter * 2)
})

function storedPlanFor(turns: Turn[]) {
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 40_000, recentToolResultBudgetTokens: 0 }),
        spec,
    )
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
            turn(
                `msg-user-new-${index}`,
                "user",
                [textItem(`msg-user-new-${index}`, "next task")],
                100 + index * 2,
            ),
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
        inputs({
            contextLimit: 120_000,
            force: true,
            recentToolResultBudgetTokens: 0,
            providerReportedTokens,
        }),
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
    const plan = buildPlan(
        buildLargeConversation(),
        inputs({ contextLimit: 200, recentToolResultBudgetTokens: 0 }),
        spec,
    )

    assert.ok(plan)
    assert.equal(plan.requiresCustomCompaction, true)
})

test("last-resort summary emits exactly one transcript reference section", () => {
    const turns = buildLargeConversation()
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 200, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const summary = syntheticTextOf(transformed[0])
    const referenceBlock = `## Reference Files\n- "${plan.transcript.relativePath}"`

    assert.equal(summary.match(/## Reference Files/g)?.length, 1)
    assert.equal(summary.split(referenceBlock).length - 1, 1)
})

test("legacy snapshot summary does not duplicate its persisted transcript reference section", () => {
    const turns = buildLargeConversation()
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 200, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)
    const snapshot = toPlanSnapshot(plan)
    const referenceBlock = `## Reference Files\n- "${snapshot.transcriptRelativePath}"`
    snapshot.prefixSummary = `${snapshot.prefixSummary}\n\n${referenceBlock}`

    const replayed = replayPlanSnapshot(turns, snapshot, spec, { allowRegrown: true })
    assert.ok(replayed)
    const summary = syntheticTextOf(replayed[0])

    assert.equal(summary.match(/## Reference Files/g)?.length, 1)
    assert.equal(summary.split(referenceBlock).length - 1, 1)
})

test("replacement plan replaces a legacy transcript reference from its prior plan", () => {
    const turns = buildLargeConversation()
    const first = buildPlan(
        turns,
        inputs({ contextLimit: 200, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(first)
    const prior = toPlanSnapshot(first)
    const priorReferenceBlock = `## Reference Files\n- "${prior.transcriptRelativePath}"`
    prior.prefixSummary = `${prior.prefixSummary}\n\n${priorReferenceBlock}`

    const replacement = buildPlan(
        turns,
        inputs({
            sessionKey: "forked-session",
            contextLimit: 200,
            recentToolResultBudgetTokens: 0,
            priorPlan: prior,
        }),
        spec,
    )
    assert.ok(replacement)
    assert.notEqual(replacement.transcript.relativePath, prior.transcriptRelativePath)

    const transformed = transformTurns(turns, replacement.rawTailStartIndex, replacement, spec)
    const summary = syntheticTextOf(transformed[0])
    const replacementReferenceBlock = `## Reference Files\n- "${replacement.transcript.relativePath}"`

    assert.equal(summary.match(/## Reference Files/g)?.length, 1)
    assert.equal(summary.includes(priorReferenceBlock), false)
    assert.equal(summary.split(replacementReferenceBlock).length - 1, 1)
})

test("planner preserves the latest two user turns as raw tail", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old user")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [toolItem("msg-assistant-1", "read", "old output ".repeat(4_000))],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user must stay raw")], 3),
        turn(
            "msg-assistant-2",
            "assistant",
            [textItem("msg-assistant-2", "middle assistant must stay raw")],
            4,
        ),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user must stay raw")], 5),
        turn(
            "msg-assistant-3",
            "assistant",
            [textItem("msg-assistant-3", "latest assistant must stay raw")],
            6,
        ),
    ]
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    assert.ok(transformed.some((item) => item.key === "msg-user-2"))
    assert.ok(transformed.some((item) => item.key === "msg-assistant-2"))
    assert.ok(transformed.some((item) => item.key === "msg-user-3"))
    assert.ok(transformed.some((item) => item.key === "msg-assistant-3"))
    const oldAssistantText = syntheticTextOf(
        transformed.find((item) => item.key === "msg-assistant-1"),
    )
    assert.match(oldAssistantText, /\[tool:read\] src\/app\.ts — ok|Assistant turn summary/)
    assert.doesNotMatch(oldAssistantText, /old output/)
})

test("planner preserves the active prompt during a single-user tool loop", () => {
    const activePrompt = "Read the lockfile completely and report its architecture."
    const turns = [
        turn(
            "msg-user-active",
            "user",
            [
                textItem("msg-user-reminder", "global system reminder ".repeat(2_000)),
                textItem("msg-user-prompt", activePrompt),
            ],
            1,
        ),
        turn(
            "msg-assistant-1",
            "assistant",
            [toolItem("msg-assistant-1", "read", "first tool output ".repeat(4_000))],
            2,
        ),
        turn(
            "msg-assistant-2",
            "assistant",
            [toolItem("msg-assistant-2", "read", "second tool output ".repeat(4_000))],
            3,
        ),
        turn(
            "msg-assistant-3",
            "assistant",
            [toolItem("msg-assistant-3", "read", "third tool output ".repeat(4_000))],
            4,
        ),
    ]
    const plan = buildPlan(
        turns,
        inputs({
            contextLimit: 10_000,
            triggerRatio: 0.03,
            targetRatio: 0.01,
            recentToolResultBudgetTokens: 0,
            force: true,
        }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    assert.ok(plan.afterPruneTokens < plan.beforeTokens)
    assert.ok(
        plan.stages.some(
            (stage) =>
                (stage.name === "supersede-reads" ||
                    stage.name === "tools-old" ||
                    stage.name === "tools-remaining") &&
                stage.clearedTokens > 0,
        ),
    )
    const transformedText = transformed.map(syntheticTextOf).join("\n")
    assert.match(transformedText, new RegExp(activePrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.doesNotMatch(transformedText, /first tool output|second tool output|third tool output/)
})

test("planner compactifies contiguous assistant turns within an old turn", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [textItem("msg-assistant-1", "first assistant detail ".repeat(4_000))],
            2,
        ),
        turn(
            "msg-assistant-2",
            "assistant",
            [
                toolItem("msg-assistant-2", "bash", "build output ".repeat(4_000), {
                    command: "npm test",
                }),
            ],
            3,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 4),
        turn("msg-assistant-3", "assistant", [textItem("msg-assistant-3", "middle assistant")], 5),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user")], 6),
    ]
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 5_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)
    assert.ok(plan.stages.some((stage) => stage.name === "assistant-runs"))
    assert.ok(plan.summaryJobs.length > 0)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    const oldAssistantTurns = transformed.filter(
        (item) => item.key === "msg-assistant-1" || item.key === "msg-assistant-2",
    )
    assert.equal(oldAssistantTurns.length, 1)
    const compactedText = syntheticTextOf(oldAssistantTurns[0])
    assert.match(compactedText, /first assistant detail/)
    assert.doesNotMatch(compactedText, /npm test/)
    assert.doesNotMatch(compactedText, /build output/)
})

test("planner ranks assistant turns and summarizes only enough to meet target", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old user")], 1),
        turn(
            "msg-assistant-big-old",
            "assistant",
            [textItem("msg-assistant-big-old", "big old detail ".repeat(8_000))],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn(
            "msg-assistant-small-old",
            "assistant",
            [textItem("msg-assistant-small-old", "small old detail ".repeat(200))],
            4,
        ),
        turn("msg-user-3", "user", [textItem("msg-user-3", "newer user")], 5),
        turn(
            "msg-assistant-big-newer",
            "assistant",
            [textItem("msg-assistant-big-newer", "big newer detail ".repeat(8_000))],
            6,
        ),
        turn("msg-user-4", "user", [textItem("msg-user-4", "tail user")], 7),
        turn(
            "msg-assistant-tail",
            "assistant",
            [textItem("msg-assistant-tail", "tail assistant")],
            8,
        ),
        turn("msg-user-5", "user", [textItem("msg-user-5", "latest user")], 9),
    ]

    const plan = buildPlan(
        turns,
        inputs({
            contextLimit: 50_000,
            force: true,
            targetRatio: 0.7,
            recentToolResultBudgetTokens: 0,
        }),
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
        turn(
            "msg-assistant-old",
            "assistant",
            [toolItem("msg-assistant-old", "read", "old output ".repeat(4_000))],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn(
            "msg-assistant-recent",
            "assistant",
            [toolItem("msg-assistant-recent", "read", "recent output ".repeat(200))],
            4,
        ),
        turn("msg-user-3", "user", [textItem("msg-user-3", "tail user")], 5),
        turn(
            "msg-assistant-tail",
            "assistant",
            [textItem("msg-assistant-tail", "tail assistant")],
            6,
        ),
        turn("msg-user-4", "user", [textItem("msg-user-4", "latest user")], 7),
    ]

    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 1_500 }),
        spec,
    )
    assert.ok(plan)
    assert.equal(plan.preservedToolCallIds.length, 1)
    assert.match(plan.preservedToolCallIds[0], /msg-assistant-recent-read-call/)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    const oldAssistantText = syntheticTextOf(
        transformed.find((item) => item.key === "msg-assistant-old"),
    )
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
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    const compactedText = syntheticTextOf(
        transformed.find((item) => item.key === "msg-assistant-1"),
    )
    assert.match(compactedText, /Latest todo state preserved/)
    assert.match(compactedText, /current task/)
    assert.doesNotMatch(compactedText, /obsolete task/)
})

test("pruned tools leave compact success and verbatim failure stubs", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [
                toolItem("msg-assistant-1", "read", "package contents", { filePath: "src/app.ts" }),
                errorToolItem("msg-assistant-1", "bash", "ENOENT: missing config\nstack detail", {
                    command: "npm run test",
                }),
            ],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn("msg-assistant-2", "assistant", [textItem("msg-assistant-2", "middle assistant")], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user")], 5),
    ]
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)
    assert.equal(plan.transcript.content, "")
    assert.deepEqual(plan.transcript.messageIds, ["msg-user-1", "msg-assistant-1"])

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)

    const compacted = transformed.find((item) => item.key === "msg-assistant-1")
    assert.ok(compacted)
    assert.deepEqual(
        compacted.items.map((item) => (item.kind === "synthetic" ? item.text : item.kind)),
        ["[tool:read] src/app.ts — ok", "[tool:bash] npm run test — error: ENOENT: missing config"],
    )
})

test("tool stubs replay byte-stably", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [
                errorToolItem("msg-assistant-1", "read", "EACCES: denied", {
                    filePath: "src/secret.ts",
                }),
            ],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn("msg-assistant-2", "assistant", [textItem("msg-assistant-2", "middle assistant")], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user")], 5),
    ]
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 1_000_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)

    const first = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const replayed = replayPlanSnapshot(turns, toPlanSnapshot(plan), spec, { allowRegrown: true })

    assert.ok(replayed)
    assert.equal(JSON.stringify(replayed), JSON.stringify(first))
    assert.match(JSON.stringify(replayed), /\[tool:read\] src\/secret\.ts — error: EACCES: denied/)
})

test("duplicate tool reads keep only the newest result and stub older failures", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [
                errorToolItem("msg-assistant-1", "read", "EACCES: denied\nstack", {
                    filePath: "src/./app.ts",
                }),
            ],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "next turn")], 3),
        turn(
            "msg-assistant-2",
            "assistant",
            [toolItem("msg-assistant-2", "read", "newest contents", { filePath: "src/app.ts" })],
            4,
        ),
        turn("msg-user-3", "user", [textItem("msg-user-3", "middle user")], 5),
        turn("msg-assistant-3", "assistant", [textItem("msg-assistant-3", "middle assistant")], 6),
        turn("msg-user-4", "user", [textItem("msg-user-4", "latest user")], 7),
    ]
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 1_000_000, force: true, recentToolResultBudgetTokens: 100_000 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const liveTools = transformed
        .flatMap((item) => item.items)
        .filter((item) => item.kind === "tool")
    const older = syntheticTextOf(transformed.find((item) => item.key === "msg-assistant-1"))
    const replayed = replayPlanSnapshot(turns, toPlanSnapshot(plan), spec, { allowRegrown: true })

    assert.equal(liveTools.length, 1)
    assert.match(String((liveTools[0].handle as TestToolPart).output), /newest contents/)
    assert.equal(
        older,
        "[tool:read] src/./app.ts — superseded by later read on src/app.ts; error: EACCES: denied",
    )
    assert.deepEqual(
        plan.stages.slice(0, 4).map((stage) => stage.name),
        ["skills", "supersede-reads", "purge-error-inputs", "tools-old"],
    )
    assert.ok(
        plan.stages.some((stage) => stage.name === "supersede-reads" && stage.status === "applied"),
    )
    assert.ok(replayed)
    assert.equal(JSON.stringify(replayed), JSON.stringify(transformed))
})

test("stale failed tools keep the error but lose their input payload", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [
                errorToolItem("msg-assistant-1", "bash", "ENOENT: missing config\nstack", {
                    command: "npm run test",
                    secret: "must-not-survive",
                }),
            ],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        turn("msg-assistant-2", "assistant", [textItem("msg-assistant-2", "middle assistant")], 4),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user")], 5),
    ]
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 1_000_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const text = syntheticTextOf(transformed.find((item) => item.key === "msg-assistant-1"))

    assert.equal(text, "[tool:bash] npm run test — error: ENOENT: missing config")
    assert.doesNotMatch(JSON.stringify(transformed), /must-not-survive/)
    assert.ok(
        plan.stages.some(
            (stage) => stage.name === "purge-error-inputs" && stage.status === "applied",
        ),
    )
})

test("purging stale failures preserves the newest failed tool inside the recent window", () => {
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old turn")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [
                errorToolItem("msg-assistant-1", "read", "ENOENT: old missing", {
                    filePath: "src/old.ts",
                    secret: "old-secret",
                }),
            ],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "next turn")], 3),
        turn(
            "msg-assistant-2",
            "assistant",
            [
                errorToolItem("msg-assistant-2", "read", "EACCES: newest denied", {
                    filePath: "src/new.ts",
                    secret: "new-secret",
                }),
            ],
            4,
        ),
        turn("msg-user-3", "user", [textItem("msg-user-3", "middle user")], 5),
        turn("msg-assistant-3", "assistant", [textItem("msg-assistant-3", "middle assistant")], 6),
        turn("msg-user-4", "user", [textItem("msg-user-4", "latest user")], 7),
    ]
    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 1_000_000, force: true, recentToolResultBudgetTokens: 1 }),
        spec,
    )
    assert.ok(plan)

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const liveTools = transformed
        .flatMap((item) => item.items)
        .filter((item) => item.kind === "tool")
    const serialized = JSON.stringify(transformed)

    assert.deepEqual(plan.preservedToolCallIds, ["msg-assistant-2-read-call"])
    assert.equal(liveTools.length, 1)
    assert.match(serialized, /new-secret/)
    assert.doesNotMatch(serialized, /old-secret/)
    assert.match(serialized, /\[tool:read\] src\/old\.ts — error: ENOENT: old missing/)
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

test("engine keeps the deterministic plan when summary scheduling rejects", async () => {
    const turns = buildMultiRunConversation()
    const planInputs = inputs({ contextLimit: 40_000, recentToolResultBudgetTokens: 0 })
    const expectedPlan = buildPlan(turns, planInputs, spec)
    assert.ok(expectedPlan)
    assert.ok(expectedPlan.summaryJobs.length > 0)
    const warnings: string[] = []
    let saved: PlanSnapshot | null = null
    const engine = createEngine(spec, {
        transcripts: {
            citablePath: planInputs.citablePath,
            write: async () => ({}),
        },
        plans: {
            load: () => null,
            save: (_key, snapshot) => {
                saved = snapshot
            },
        },
        logger: {
            info() {},
            debug() {},
            warn(message) {
                warnings.push(message)
            },
            error() {},
        },
    })

    const result = await engine.process({
        sessionKey,
        turns,
        contextLimit: 40_000,
        recentToolResultBudgetTokens: 0,
        summarize: async () => {
            throw new Error("scheduler failed")
        },
    })

    assert.equal(result.outcome, "planned")
    if (result.outcome !== "planned") return
    assert.equal(
        JSON.stringify(result.turns),
        JSON.stringify(transformTurns(turns, expectedPlan.rawTailStartIndex, expectedPlan, spec)),
    )
    assert.ok(saved)
    assert.ok(warnings.includes("Summary scheduling failed; using deterministic fallback"))
})

test("planner triggers when either the provider total or the raw estimate crosses the trigger", () => {
    const turns = buildLargeConversation()
    const estimate = codec.estimateTurns(turns)
    const contextLimit = Math.max(1, Math.floor(estimate / 0.9))
    assert.ok(estimate > Math.floor(contextLimit * 0.85))

    // Provider total lags behind fresh turns the estimate already sees.
    const plan = buildPlan(turns, inputs({ contextLimit, providerReportedTokens: 10 }), spec)
    assert.ok(plan)

    // Neither scale over the trigger: no plan.
    const calm = buildPlan(
        turns,
        inputs({ contextLimit: estimate * 4, providerReportedTokens: 10 }),
        spec,
    )
    assert.equal(calm, null)
})

test("replacement plans keep prior pruning stages and preserved tools as a monotonic floor", () => {
    const turns = buildLargeConversation()
    const first = buildPlan(
        turns,
        inputs({ contextLimit: 10_000, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(first)
    assert.ok(
        first.stages.some((stage) => stage.name === "reasoning" && stage.status !== "skipped"),
    )

    const replacement = buildPlan(
        turns,
        inputs({
            contextLimit: 1_000_000,
            force: true,
            recentToolResultBudgetTokens: 80_000,
            priorPlan: toPlanSnapshot(first),
        }),
        spec,
    )

    assert.ok(replacement)
    // A generous limit alone would skip reasoning; the prior plan already
    // pruned it, so the replacement must not resurrect it.
    assert.ok(
        replacement.stages.some(
            (stage) => stage.name === "reasoning" && stage.status !== "skipped",
        ),
    )
    // Tool results the model already lost inside the prior compacted prefix
    // stay lost even under a larger recent-tool budget.
    const priorPreserved = new Set(first.preservedToolCallIds)
    for (const callId of replacement.preservedToolCallIds) {
        if (priorPreserved.has(callId)) continue
        const previouslyCompacted = turns
            .slice(0, first.rawTailStartIndex)
            .some((item) =>
                item.items.some((part) => part.kind === "tool" && part.callId === callId),
            )
        assert.equal(previouslyCompacted, false)
    }
})

test("replacement plans reuse prior assistant summaries without new summary jobs", () => {
    const turns = buildMultiRunConversation()
    const first = buildPlan(
        turns,
        inputs({ contextLimit: 9_000, recentToolResultBudgetTokens: 0, force: true }),
        spec,
    )
    assert.ok(first)
    assert.ok(first.summaryJobs.length > 0)
    const summaries = Object.fromEntries(
        first.summaryJobs.map((job) => [job.key, "Accepted summary."]),
    )
    const settled = buildPlan(
        turns,
        inputs({
            contextLimit: 9_000,
            recentToolResultBudgetTokens: 0,
            force: true,
            assistantSummaries: summaries,
        }),
        spec,
    )
    assert.ok(settled)
    assert.equal(settled.summaryJobs.length, 0)

    const replacement = buildPlan(
        turns,
        inputs({
            contextLimit: 9_000,
            recentToolResultBudgetTokens: 0,
            force: true,
            priorPlan: toPlanSnapshot(settled),
        }),
        spec,
    )

    assert.ok(replacement)
    assert.equal(replacement.summaryJobs.length, 0)
    assert.deepEqual(replacement.assistantSummaries, settled.assistantSummaries)
})

test("expanded prefix summaries include newly compacted user context", () => {
    const firstTurns = [
        turn("u1", "user", [textItem("u1", "old user")], 1),
        turn("a1", "assistant", [textItem("a1", "old detail ".repeat(2_000))], 2),
        turn("u2", "user", [textItem("u2", "middle user")], 3),
        turn("a2", "assistant", [textItem("a2", "middle detail ".repeat(2_000))], 4),
        turn("u3", "user", [textItem("u3", "newly crossed requirement")], 5),
    ]
    const first = buildPlan(
        firstTurns,
        inputs({ contextLimit: 100, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(first?.requiresCustomCompaction)
    const grown = [
        ...firstTurns,
        turn("a3", "assistant", [textItem("a3", "later detail ".repeat(2_000))], 6),
        turn("u4", "user", [textItem("u4", "later user")], 7),
        turn("a4", "assistant", [textItem("a4", "latest assistant")], 8),
        turn("u5", "user", [textItem("u5", "latest user")], 9),
    ]

    const prior = toPlanSnapshot(first)
    prior.prefixSummary = "PRIOR CHECKPOINT ONLY"
    const replacement = buildPlan(
        grown,
        inputs({
            contextLimit: 100,
            force: true,
            recentToolResultBudgetTokens: 0,
            priorPlan: prior,
        }),
        spec,
    )

    assert.ok(replacement?.requiresCustomCompaction)
    assert.match(replacement.prefixSummary ?? "", /newly crossed requirement/)
    assert.doesNotMatch(replacement.prefixSummary ?? "", /PRIOR CHECKPOINT ONLY/)

    const repeated = buildPlan(
        grown,
        inputs({
            contextLimit: 100,
            force: true,
            recentToolResultBudgetTokens: 0,
            priorPlan: prior,
        }),
        spec,
    )
    assert.ok(repeated)
    assert.equal(repeated.prefixSummary, replacement.prefixSummary)
    assert.equal(
        JSON.stringify(transformTurns(grown, repeated.rawTailStartIndex, repeated, spec)),
        JSON.stringify(transformTurns(grown, replacement.rawTailStartIndex, replacement, spec)),
    )
})

test("available summarizer rolls a prior prefix summary over only the newly compacted delta", async () => {
    const firstTurns = [
        turn("u1", "user", [textItem("u1", "old user")], 1),
        turn("a1", "assistant", [textItem("a1", "old detail ".repeat(2_000))], 2),
        turn("u2", "user", [textItem("u2", "middle user")], 3),
        turn("a2", "assistant", [textItem("a2", "middle detail ".repeat(2_000))], 4),
        turn("u3", "user", [textItem("u3", "newly crossed requirement")], 5),
    ]
    const first = buildPlan(
        firstTurns,
        inputs({ contextLimit: 100, force: true, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(first?.requiresCustomCompaction)

    const priorSummary = [
        "## Decisions",
        "- PRIOR CHECKPOINT DECISION",
        "",
        "## Files & Symbols",
        "- src/prior.ts",
        "",
        "## Errors (verbatim)",
        "- (none)",
        "",
        "## What failed and why",
        "- (none)",
        "",
        "## Constraints",
        "- Preserve the prior checkpoint.",
        "",
        "## Next step",
        "- Continue from the delta.",
    ].join("\n")
    const rolledSummary = priorSummary.replace(
        "- PRIOR CHECKPOINT DECISION",
        "- ROLLED CHECKPOINT WITH NEW DELTA",
    )
    let stored: PlanSnapshot = { ...toPlanSnapshot(first), prefixSummary: priorSummary }
    const capturedJobs: Array<{
        key: string
        prompt: string
        rangeStartMessageId: string
        rangeEndMessageId: string
    }> = []
    const engine = createEngine(spec, {
        transcripts: {
            citablePath: (key, hash) => `transcripts/${key}/${hash}.md`,
            write: async () => ({}),
        },
        plans: {
            load: () => stored,
            save: (_key, snapshot) => {
                if (snapshot) stored = snapshot
            },
        },
        logger: { info() {}, debug() {}, warn() {}, error() {} },
    })
    const grown = [
        ...firstTurns,
        turn("a3", "assistant", [textItem("a3", "later detail ".repeat(2_000))], 6),
        turn("u4", "user", [textItem("u4", "still raw later user")], 7),
        turn("a4", "assistant", [textItem("a4", "still raw latest assistant")], 8),
        turn("u5", "user", [textItem("u5", "still raw latest user")], 9),
    ]

    const result = await engine.process({
        sessionKey,
        turns: grown,
        contextLimit: 100,
        recentToolResultBudgetTokens: 0,
        summarize: async (jobs) => {
            capturedJobs.push(...jobs)
            return Object.fromEntries(
                jobs.map((job) => [
                    job.key,
                    job.key.startsWith("prefix-summary:") ? rolledSummary : priorSummary,
                ]),
            )
        },
    })

    assert.equal(result.outcome, "planned")
    if (result.outcome !== "planned") return
    const rollingJobs = capturedJobs.filter((job) => job.key.startsWith("prefix-summary:"))
    assert.equal(rollingJobs.length, 1)
    assert.equal(rollingJobs[0].rangeStartMessageId, "u2")
    assert.equal(rollingJobs[0].rangeEndMessageId, "a3")
    assert.match(rollingJobs[0].prompt, /PRIOR CHECKPOINT DECISION/)
    assert.match(rollingJobs[0].prompt, /newly crossed requirement/)
    for (const header of [
        "## Decisions",
        "## Files & Symbols",
        "## Errors (verbatim)",
        "## What failed and why",
        "## Constraints",
        "## Next step",
    ]) {
        assert.match(rollingJobs[0].prompt, new RegExp(header.replace(/[()]/g, "\\$&")))
    }
    assert.match(rollingJobs[0].prompt, /Preserve exact paths, symbols, error strings, and IDs verbatim/)
    assert.doesNotMatch(rollingJobs[0].prompt, /still raw later user/)
    assert.doesNotMatch(rollingJobs[0].prompt, /still raw latest user/)
    assert.equal(result.plan.prefixSummary, rolledSummary)
    assert.equal(result.plan.requiresCustomCompaction, true)
    assert.equal(result.plan.summaryJobs.length, 0)
    assert.equal(Object.hasOwn(result.plan.assistantSummaries, rollingJobs[0].key), false)
})

test("custom compaction stays sticky for replacement plans", () => {
    const turns = buildMultiRunConversation()
    const first = buildPlan(
        turns,
        inputs({ contextLimit: 500, recentToolResultBudgetTokens: 0 }),
        spec,
    )
    assert.ok(first?.requiresCustomCompaction)

    // A huge limit would normally clear custom compaction entirely, but the
    // model already saw a summarized prefix; reverting would resurrect it.
    const replacement = buildPlan(
        turns,
        inputs({ contextLimit: 1_000_000, force: true, priorPlan: toPlanSnapshot(first) }),
        spec,
    )

    assert.ok(replacement)
    assert.equal(replacement.requiresCustomCompaction, true)
    assert.equal(replacement.prefixSummary, first.prefixSummary)
})

test("ephemeral turns do not count as protected user turns", () => {
    const ignored = turn(
        "msg-ignored",
        "user",
        [textItem("msg-ignored", "Better Compact report")],
        4,
    )
    ignored.ephemeral = true
    const turns = [
        turn("msg-user-1", "user", [textItem("msg-user-1", "old user")], 1),
        turn(
            "msg-assistant-1",
            "assistant",
            [textItem("msg-assistant-1", "old detail ".repeat(2_000))],
            2,
        ),
        turn("msg-user-2", "user", [textItem("msg-user-2", "middle user")], 3),
        ignored,
        turn("msg-assistant-2", "assistant", [textItem("msg-assistant-2", "middle assistant")], 5),
        turn("msg-user-3", "user", [textItem("msg-user-3", "latest user")], 6),
    ]

    const plan = buildPlan(turns, inputs({ contextLimit: 10_000, force: true }), spec)

    assert.ok(plan)
    assert.equal(plan.rawTailStartMessageId, "msg-user-2")
})

test("assistant summaries survive a fork that mints new turn keys", () => {
    const turns = buildMultiRunConversation()
    const first = buildPlan(
        turns,
        inputs({ contextLimit: 9_000, recentToolResultBudgetTokens: 0, force: true }),
        spec,
    )
    assert.ok(first)
    assert.ok(first.summaryJobs.length > 0)
    const summaries = Object.fromEntries(
        first.summaryJobs.map((job) => [job.key, "Accepted summary."]),
    )

    const forked = buildMultiRunConversation().map((item) => ({ ...item, key: `fork-${item.key}` }))
    const replay = buildPlan(
        forked,
        inputs({
            contextLimit: 9_000,
            recentToolResultBudgetTokens: 0,
            force: true,
            assistantSummaries: summaries,
        }),
        spec,
    )

    assert.ok(replay)
    assert.equal(replay.summaryJobs.length, 0)
    assert.deepEqual(Object.keys(replay.assistantSummaries).sort(), Object.keys(summaries).sort())
})

test("an oversized turn prunes older items while keeping its newest item raw", () => {
    const sourceTool = toolItem("msg-assistant-large", "read", "old output ".repeat(4_000))
    const newest = textItem("msg-assistant-large-newest", "newest assistant detail stays raw")
    const source = turn("msg-assistant-large", "assistant", [sourceTool, newest], 1)
    const turns = [
        source,
        turn("msg-user-new", "user", [textItem("msg-user-new", "latest request")], 2),
    ]

    const plan = buildPlan(turns, inputs({ contextLimit: 10_000 }), spec)

    assert.ok(plan)
    assert.equal(plan.rawTailStartMessageId, source.key)
    assert.deepEqual(plan.rawTailItemBoundary, { itemKey: newest.key, side: "before" })
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const transformedSource = transformed.find((candidate) => candidate.handle === source.handle)
    assert.ok(transformedSource)
    assert.equal(transformed.filter((candidate) => candidate.handle === source.handle).length, 1)
    assert.equal(transformedSource.items.at(-1), newest)
    assert.ok(
        transformedSource.items.some(
            (item) => item.kind === "synthetic" && item.text.startsWith("[tool:read]"),
        ),
    )

    const replayed = replayPlanSnapshot(turns, toPlanSnapshot(plan), spec)
    assert.ok(replayed)
    assert.equal(JSON.stringify(replayed), JSON.stringify(transformed))

    const missingBoundary = turns.map((candidate) =>
        candidate === source
            ? { ...candidate, items: candidate.items.filter((item) => item !== newest) }
            : candidate,
    )
    assert.equal(replayPlanSnapshot(missingBoundary, toPlanSnapshot(plan), spec), null)

    const editedPrefix = [
        {
            ...source,
            items: [{ ...sourceTool, key: `${sourceTool.key}-edited` }, newest],
        },
        turns[1],
    ]
    assert.equal(replayPlanSnapshot(editedPrefix, toPlanSnapshot(plan), spec), null)
})

test("an oversized assistant text prefix is summarized without rewriting its raw suffix", () => {
    const oldText = textItem("msg-assistant-text-old", "old assistant detail ".repeat(3_000))
    const newest = textItem("msg-assistant-text-new", "newest assistant conclusion")
    const source = turn("msg-assistant-text", "assistant", [oldText, newest], 1)
    const turns = [
        source,
        turn("msg-user-new", "user", [textItem("msg-user-new", "latest request")], 2),
    ]

    const plan = buildPlan(turns, inputs({ contextLimit: 10_000 }), spec)

    assert.ok(plan)
    assert.deepEqual(plan.rawTailItemBoundary, { itemKey: newest.key, side: "before" })
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const transformedSource = transformed.find((candidate) => candidate.handle === source.handle)
    assert.ok(transformedSource)
    assert.equal(transformedSource.items.at(-1), newest)
    assert.ok(
        transformedSource.items.some(
            (item) =>
                item.kind === "synthetic" && item.text.startsWith("[Assistant turn summary]"),
        ),
    )
    assert.equal(transformedSource.items.some((item) => item === oldText), false)
})

test("advancing a split boundary does not reuse a partial assistant summary", () => {
    const oldest = textItem("msg-assistant-oldest", "oldest detail ".repeat(3_000))
    const middle = textItem("msg-assistant-middle", "middle detail ".repeat(3_000))
    const newest = textItem("msg-assistant-newest", "newest detail stays raw")
    const source = turn("msg-assistant-growing", "assistant", [oldest, middle, newest], 1)
    const turns = [
        source,
        turn("msg-user-new", "user", [textItem("msg-user-new", "latest request")], 2),
    ]
    const first = buildPlan(
        turns,
        inputs({ contextLimit: 40_000, triggerRatio: 0.4, targetRatio: 0.3 }),
        spec,
    )
    assert.ok(first)
    assert.deepEqual(first.rawTailItemBoundary, { itemKey: middle.key, side: "before" })
    assert.equal(first.summaryJobs.length, 1)
    const firstSummaryKey = first.summaryJobs[0].key
    const prior = toPlanSnapshot(first)
    prior.assistantSummaries = { [firstSummaryKey]: "accepted partial summary" }
    prior.assistantSummaryKeys = [firstSummaryKey]

    const replacement = buildPlan(
        turns,
        inputs({
            contextLimit: 40_000,
            triggerRatio: 0.4,
            targetRatio: 0.1,
            priorPlan: prior,
        }),
        spec,
    )

    assert.ok(replacement)
    assert.deepEqual(replacement.rawTailItemBoundary, {
        itemKey: newest.key,
        side: "before",
    })
    assert.notEqual(replacement.rangeHash, first.rangeHash)
    assert.equal(replacement.summaryJobs.length, 1)
    assert.notEqual(replacement.summaryJobs[0].key, firstSummaryKey)
})

test("a lone giant tool item is stubbed atomically instead of split", () => {
    const giantTool = toolItem("msg-assistant-tool", "read", "giant output ".repeat(5_000))
    const source = turn("msg-assistant-tool", "assistant", [giantTool], 2)
    const turns = [
        turn("msg-user-old", "user", [textItem("msg-user-old", "old request")], 1),
        source,
        turn("msg-user-new", "user", [textItem("msg-user-new", "latest request")], 3),
    ]

    const plan = buildPlan(turns, inputs({ contextLimit: 10_000 }), spec)

    assert.ok(plan)
    assert.equal(plan.rawTailStartMessageId, source.key)
    assert.deepEqual(plan.rawTailItemBoundary, { itemKey: giantTool.key, side: "after" })
    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, spec)
    const transformedSource = transformed.find((candidate) => candidate.handle === source.handle)
    assert.ok(transformedSource)
    assert.equal(transformed.filter((candidate) => candidate.handle === source.handle).length, 1)
    assert.equal(transformedSource.items.filter((item) => item.kind === "tool").length, 0)
    assert.equal(
        transformedSource.items.filter(
            (item) => item.kind === "synthetic" && item.text.startsWith("[tool:read]"),
        ).length,
        1,
    )

    const replayed = replayPlanSnapshot(turns, toPlanSnapshot(plan), spec)
    assert.ok(replayed)
    assert.equal(JSON.stringify(replayed), JSON.stringify(transformed))

    const appended = textItem("msg-assistant-tool-new", "new same-turn detail stays raw")
    const grownSource = { ...source, items: [giantTool, appended] }
    const grown = [turns[0], grownSource, turns[2]]
    const replayedGrown = replayPlanSnapshot(grown, toPlanSnapshot(plan), spec)
    assert.ok(replayedGrown)
    const replayedGrownSource = replayedGrown.find(
        (candidate) => candidate.handle === source.handle,
    )
    assert.ok(replayedGrownSource)
    assert.equal(replayedGrownSource.items.at(-1), appended)

    const replacement = buildPlan(
        grown,
        inputs({ contextLimit: 10_000, priorPlan: toPlanSnapshot(plan) }),
        spec,
    )
    assert.ok(replacement)
    assert.deepEqual(replacement.rawTailItemBoundary, {
        itemKey: appended.key,
        side: "before",
    })
    const replaced = transformTurns(grown, replacement.rawTailStartIndex, replacement, spec)
    const replacedSource = replaced.find((candidate) => candidate.handle === source.handle)
    assert.ok(replacedSource)
    assert.equal(replacedSource.items.at(-1), appended)
})

test("a protected turn below the trigger stays whole even when it exceeds the target", () => {
    const turns = [
        turn("msg-user-old", "user", [textItem("msg-user-old", "old request")], 1),
        turn(
            "msg-assistant-old",
            "assistant",
            [toolItem("msg-assistant-old", "read", "old output ".repeat(5_000))],
            2,
        ),
        turn("msg-user-middle", "user", [textItem("msg-user-middle", "middle request")], 3),
        turn(
            "msg-assistant-tail",
            "assistant",
            [
                textItem("msg-assistant-tail-old", "tail detail ".repeat(1_000)),
                textItem("msg-assistant-tail-new", "newest tail detail"),
            ],
            4,
        ),
        turn("msg-user-new", "user", [textItem("msg-user-new", "latest request")], 5),
    ]

    const plan = buildPlan(
        turns,
        inputs({ contextLimit: 10_000, recentToolResultBudgetTokens: 0 }),
        spec,
    )

    assert.ok(plan)
    assert.equal(plan.rawTailStartMessageId, "msg-user-middle")
    assert.equal(plan.rawTailItemBoundary, undefined)
})
