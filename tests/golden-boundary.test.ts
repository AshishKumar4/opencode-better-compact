import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { WithParts } from "../lib/state"
import { createSessionState } from "../lib/state"
import { Logger } from "../lib/logger"
import {
    applyBoundaryContextPlan,
    applyBoundaryPlanSnapshot,
    buildBoundaryContextPlan,
    formatBoundaryReport,
    storeBoundaryPlan,
    writeBoundaryTranscript,
    type BoundaryContextOptions,
    type BoundaryContextPlan,
} from "../lib/boundary/context"

// Golden pre/post-refactor harness: feeds representative conversations through
// the boundary transform surface and pins the exact outputs (plans, transformed
// arrays, snapshot replays, transcript content, reports) as JSON fixtures.
// Regenerate with GOLDEN_UPDATE=1 only when a behavior change is intentional.

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/golden-boundary.json", import.meta.url))
const sessionID = "ses_golden_boundary"

function textPart(messageID: string, text: string, extra: Record<string, unknown> = {}) {
    return {
        id: `${messageID}-text-${text.length}`,
        messageID,
        sessionID,
        type: "text" as const,
        text,
        ...extra,
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

function toolPart(
    messageID: string,
    tool: string,
    output: unknown,
    input: Record<string, unknown> = { filePath: "src/app.ts" },
    stateExtra: Record<string, unknown> = {},
) {
    return {
        id: `${messageID}-${tool}-${JSON.stringify(input).length}`,
        messageID,
        sessionID,
        type: "tool" as const,
        callID: `${messageID}-${tool}-call-${JSON.stringify(input).length}`,
        tool,
        state: {
            status: "completed" as const,
            input,
            output,
            title: tool,
            metadata: {},
            time: { start: 1, end: 2 },
            ...stateExtra,
        },
    }
}

function errorToolPart(messageID: string, tool: string, error: string, input: Record<string, unknown>) {
    return {
        id: `${messageID}-${tool}-error`,
        messageID,
        sessionID,
        type: "tool" as const,
        callID: `${messageID}-${tool}-error-call`,
        tool,
        state: {
            status: "error" as const,
            input,
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
    info: Record<string, unknown> = {},
): WithParts {
    const base =
        role === "user"
            ? {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  model: { providerID: "anthropic", modelID: "claude-test" },
                  time: { created },
              }
            : {
                  id,
                  role,
                  sessionID,
                  agent: "assistant",
                  providerID: "anthropic",
                  modelID: "claude-test",
                  time: { created },
              }
    return { info: { ...base, ...info } as WithParts["info"], parts }
}

function filler(word: string, count: number): string {
    return `${word} `.repeat(count).trimEnd()
}

function toolsHeavyConversation(): WithParts[] {
    return [
        message("msg-user-1", "user", [textPart("msg-user-1", "Keep this exact requirement intact.")], 1),
        message(
            "msg-assistant-1",
            "assistant",
            [
                reasoningPart("msg-assistant-1", filler("silent-thought", 40)),
                textPart("msg-assistant-1", "Investigated the compaction path end to end."),
                toolPart("msg-assistant-1", "read", filler("old-tool-output", 900)),
                toolPart("msg-assistant-1", "skill", filler("skill-body", 700), { name: "root-cause-debug" }),
                errorToolPart("msg-assistant-1", "bash", "ENOENT: missing config", { command: "npm run test" }),
            ],
            2,
        ),
        message("msg-user-2", "user", [textPart("msg-user-2", "Continue with the plugin-only design.")], 3),
        message(
            "msg-assistant-2",
            "assistant",
            [
                textPart("msg-assistant-2", "Recent assistant tail should remain raw."),
                toolPart("msg-assistant-2", "grep", filler("recent-tool-output", 120), { pattern: "needle" }),
            ],
            4,
        ),
        message("msg-user-3", "user", [textPart("msg-user-3", "Latest user tail should remain raw.")], 5),
    ]
}

function reasoningHeavyConversation(): WithParts[] {
    return [
        message("msg-user-1", "user", [textPart("msg-user-1", "First task with firm constraints.")], 1),
        message(
            "msg-assistant-1",
            "assistant",
            [
                reasoningPart("msg-assistant-1", filler("deep-reasoning", 1_400)),
                textPart("msg-assistant-1", filler("assistant-detail", 600)),
                toolPart("msg-assistant-1", "read", filler("modest-tool-output", 260)),
            ],
            2,
        ),
        message("msg-user-2", "user", [textPart("msg-user-2", "Second task.")], 3),
        message("msg-assistant-2", "assistant", [textPart("msg-assistant-2", "Middle assistant reply.")], 4),
        message("msg-user-3", "user", [textPart("msg-user-3", "Latest user message.")], 5),
    ]
}

function multiRunConversation(): WithParts[] {
    return [
        message("msg-user-1", "user", [textPart("msg-user-1", "First task, keep this requirement.")], 1),
        message(
            "msg-assistant-big",
            "assistant",
            [
                reasoningPart("msg-assistant-big", filler("big-private-reasoning", 120)),
                textPart("msg-assistant-big", filler("big-assistant-detail", 1_700)),
                toolPart("msg-assistant-big", "read", filler("big-tool-output", 130)),
            ],
            2,
        ),
        message(
            "msg-assistant-big-2",
            "assistant",
            [toolPart("msg-assistant-big-2", "bash", filler("build-output", 220), { command: "npm test" })],
            3,
        ),
        message("msg-user-2", "user", [textPart("msg-user-2", "Second task.")], 4),
        message(
            "msg-assistant-small",
            "assistant",
            [
                reasoningPart("msg-assistant-small", filler("small-private-reasoning", 60)),
                textPart("msg-assistant-small", "small assistant detail"),
                toolPart("msg-assistant-small", "grep", filler("small-tool-output", 60), { pattern: "needle" }),
            ],
            5,
        ),
        message("msg-user-3", "user", [textPart("msg-user-3", "Third task stays raw.")], 6),
        message("msg-assistant-tail", "assistant", [textPart("msg-assistant-tail", "tail assistant")], 7),
        message("msg-user-4", "user", [textPart("msg-user-4", "Latest user stays raw.")], 8),
    ]
}

function exoticPartsConversation(): WithParts[] {
    return [
        message(
            "msg-user-1",
            "user",
            [
                textPart("msg-user-1", "Original request with attachments."),
                {
                    id: "msg-user-1-file",
                    messageID: "msg-user-1",
                    sessionID,
                    type: "file" as const,
                    mime: "text/plain",
                    filename: "notes.txt",
                    url: "file:///notes.txt",
                } as any,
                {
                    id: "msg-user-1-compaction",
                    messageID: "msg-user-1",
                    sessionID,
                    type: "compaction" as const,
                } as any,
            ],
            1,
        ),
        message(
            "msg-assistant-1",
            "assistant",
            [
                { id: "msg-assistant-1-step", messageID: "msg-assistant-1", sessionID, type: "step-start" as const } as any,
                reasoningPart("msg-assistant-1", filler("openai-hidden-reasoning", 500)),
                textPart("msg-assistant-1", filler("assistant-progress", 40)),
                toolPart(
                    "msg-assistant-1",
                    "todowrite",
                    "todos recorded",
                    { todos: [{ content: "obsolete task", status: "pending", priority: "high" }] },
                ),
                toolPart(
                    "msg-assistant-1",
                    "todowrite",
                    "todos updated",
                    { todos: [{ content: "current task", status: "in_progress", priority: "high" }] },
                ),
                toolPart(
                    "msg-assistant-1",
                    "read",
                    "full original output that was later compacted upstream",
                    { filePath: "/tmp/big.log" },
                    { time: { start: 1, end: 2, compacted: 3 } },
                ),
            ],
            2,
            { providerID: "openai", modelID: "gpt-test", model: undefined },
        ),
        message(
            "msg-user-2",
            "user",
            [
                textPart("msg-user-2", "ignored notification text", { ignored: true }),
                {
                    id: "msg-user-2-subtask",
                    messageID: "msg-user-2",
                    sessionID,
                    type: "subtask" as const,
                    prompt: "sub agent prompt",
                } as any,
                textPart("msg-user-2", "Middle user request."),
            ],
            3,
        ),
        message(
            "msg-assistant-2",
            "assistant",
            [
                textPart("msg-assistant-2", filler("later-assistant-detail", 800)),
                {
                    id: "msg-assistant-2-patch",
                    messageID: "msg-assistant-2",
                    sessionID,
                    type: "patch" as const,
                    hash: "abc123",
                    files: ["src/app.ts", "src/util.ts"],
                } as any,
            ],
            4,
        ),
        message("msg-user-3", "user", [textPart("msg-user-3", "Tail user request.")], 5),
        message("msg-assistant-3", "assistant", [textPart("msg-assistant-3", "Tail assistant reply.")], 6),
        message("msg-user-4", "user", [textPart("msg-user-4", "Latest user request.")], 7),
    ]
}

function smallConversation(): WithParts[] {
    return [
        message("msg-user-1", "user", [textPart("msg-user-1", "Small request.")], 1),
        message("msg-assistant-1", "assistant", [textPart("msg-assistant-1", "Small answer.")], 2),
        message("msg-user-2", "user", [textPart("msg-user-2", "Follow-up.")], 3),
        message("msg-assistant-2", "assistant", [textPart("msg-assistant-2", "Done.")], 4),
        message("msg-user-3", "user", [textPart("msg-user-3", "Thanks.")], 5),
    ]
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

function normalize(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value))
}

interface ReplaySpec {
    name: string
    mutate?: (messages: WithParts[]) => void
}

interface Scenario {
    name: string
    messages: () => WithParts[]
    options: BoundaryContextOptions
    // Maps every first-pass assistantSummaryKey to a fixed summary and rebuilds.
    summariesText?: string
    replays?: ReplaySpec[]
    expect?: (plan: BoundaryContextPlan | null, record: Record<string, unknown>) => void
}

function regrow(messages: WithParts[]): void {
    for (let index = 0; index < 12; index++) {
        messages.push(
            message(`msg-user-new-${index}`, "user", [textPart(`msg-user-new-${index}`, "next task")], 100 + index * 2),
            message(
                `msg-assistant-new-${index}`,
                "assistant",
                [textPart(`msg-assistant-new-${index}`, filler("fresh-assistant-output", 900))],
                101 + index * 2,
            ),
        )
    }
}

const scenarios: Scenario[] = [
    {
        name: "below-trigger",
        messages: smallConversation,
        options: { contextLimit: 100_000 },
        expect: (plan) => assert.equal(plan, null),
    },
    {
        name: "force-below-trigger-estimate-only",
        messages: smallConversation,
        options: { contextLimit: 100_000, force: true },
        expect: (plan) => {
            assert.ok(plan)
            assert.equal(plan.overheadTokens, 0)
            assert.ok(!plan.requiresCustomCompaction)
        },
    },
    {
        name: "tools-old-only",
        messages: toolsHeavyConversation,
        options: { contextLimit: 5_000, recentToolResultBudgetTokens: 600 },
        replays: [{ name: "identical" }],
        expect: (plan) => {
            assert.ok(plan)
            const names = plan.stages.map((stage) => stage.name)
            assert.deepEqual(names, ["skills", "tools-old"])
            assert.equal(plan.stages.at(-1)?.status, "target-met")
            assert.equal(plan.preservedToolCallIds.length, 1)
        },
    },
    {
        name: "through-reasoning",
        messages: reasoningHeavyConversation,
        options: { contextLimit: 6_200, recentToolResultBudgetTokens: 0 },
        expect: (plan) => {
            assert.ok(plan)
            const names = plan.stages.map((stage) => stage.name)
            assert.ok(names.includes("reasoning"))
            assert.ok(!names.includes("assistant-runs"))
        },
    },
    {
        // A generous recent-tool budget carries the heavy tool results through
        // tools-old; only the preserved-set-free tools-remaining pass clears them.
        name: "through-tools-remaining",
        messages: toolsHeavyConversation,
        options: { contextLimit: 3_000, recentToolResultBudgetTokens: 5_000 },
        replays: [{ name: "identical" }],
        expect: (plan) => {
            assert.ok(plan)
            const names = plan.stages.map((stage) => stage.name)
            assert.ok(names.includes("reasoning"))
            assert.ok(names.includes("tools-remaining"))
            assert.equal(plan.preservedToolCallIds.length, 2)
        },
    },
    {
        name: "assistant-runs-pending-jobs",
        messages: multiRunConversation,
        options: { contextLimit: 9_000, recentToolResultBudgetTokens: 0 },
        replays: [
            { name: "identical" },
            {
                name: "edited-prefix",
                mutate: (messages) => {
                    messages[1].info.time.created = 999
                },
            },
            { name: "regrown", mutate: regrow },
        ],
        expect: (plan) => {
            assert.ok(plan)
            assert.ok(plan.stages.some((stage) => stage.name === "assistant-runs"))
            assert.ok(plan.summaryJobs.length > 0)
            assert.ok(!plan.requiresCustomCompaction)
        },
    },
    {
        name: "assistant-runs-with-summaries",
        messages: multiRunConversation,
        options: { contextLimit: 9_000, recentToolResultBudgetTokens: 0 },
        summariesText: "Accepted summary: shipped the first task end to end.",
        replays: [{ name: "identical" }],
        expect: (plan) => {
            assert.ok(plan)
            assert.equal(plan.summaryJobs.length, 0)
            assert.ok(plan.assistantSummaryKeys.length > 0)
        },
    },
    {
        name: "prefix-summary-custom-compaction",
        messages: multiRunConversation,
        options: { contextLimit: 500, recentToolResultBudgetTokens: 0 },
        replays: [{ name: "identical" }],
        expect: (plan) => {
            assert.ok(plan)
            assert.equal(plan.requiresCustomCompaction, true)
            assert.ok(plan.stages.some((stage) => stage.name === "prefix-summary"))
        },
    },
    {
        name: "prefix-summary-provided-text",
        messages: multiRunConversation,
        options: {
            contextLimit: 500,
            recentToolResultBudgetTokens: 0,
            prefixSummary: "Custom checkpoint: finished task one; task two pending review.",
        },
        replays: [{ name: "identical" }],
        expect: (plan) => {
            assert.ok(plan)
            assert.equal(plan.requiresCustomCompaction, true)
            assert.equal(plan.prefixSummary, "Custom checkpoint: finished task one; task two pending review.")
        },
    },
    {
        name: "provider-overhead",
        messages: multiRunConversation,
        options: {
            contextLimit: 120_000,
            force: true,
            recentToolResultBudgetTokens: 0,
            providerReportedTokens: 60_000,
        },
        replays: [{ name: "identical" }],
        expect: (plan) => {
            assert.ok(plan)
            assert.ok(plan.overheadTokens > 0)
            assert.equal(plan.beforeTokens, 60_000)
        },
    },
    {
        name: "exotic-parts",
        messages: exoticPartsConversation,
        options: { contextLimit: 4_000, recentToolResultBudgetTokens: 0 },
        replays: [{ name: "identical" }],
        expect: (plan, record) => {
            assert.ok(plan)
            assert.ok(plan.stages.some((stage) => stage.name === "assistant-runs"))
            if (!record.transformed) return
            const transformed = JSON.stringify(record.transformed)
            assert.match(transformed, /Latest todo state preserved/)
            assert.match(transformed, /current task/)
            assert.doesNotMatch(transformed, /obsolete task/)
            assert.match(transformed, /Patch recorded: src\/app.ts, src\/util.ts/)
        },
    },
]

async function captureScenario(scenario: Scenario, workDirectory: string): Promise<Record<string, unknown>> {
    const logger = new Logger(false)
    const input = scenario.messages()
    const record: Record<string, unknown> = {
        input: normalize(input),
        options: normalize(scenario.options),
    }

    let plan = buildBoundaryContextPlan(clone(input), scenario.options)
    if (plan && scenario.summariesText) {
        const summaries = Object.fromEntries(plan.assistantSummaryKeys.map((key) => [key, scenario.summariesText!]))
        record.firstPassSummaryKeys = normalize(plan.assistantSummaryKeys)
        plan = buildBoundaryContextPlan(clone(input), { ...scenario.options, assistantSummaries: summaries })
    }
    scenario.expect?.(plan, record)

    if (!plan) {
        record.plan = null
        return record
    }

    await writeBoundaryTranscript(workDirectory, plan, logger)
    const planJson = normalize(plan) as { transcript: Record<string, unknown> }
    delete planJson.transcript.absolutePath
    record.plan = planJson

    const transformed = clone(input)
    applyBoundaryContextPlan(transformed, plan)
    record.transformed = normalize(transformed)
    record.report = formatBoundaryReport(plan)
    scenario.expect?.(plan, record)

    if (scenario.replays) {
        const state = createSessionState()
        state.sessionId = sessionID
        storeBoundaryPlan(state, plan)
        const snapshot = state.boundary.activePlan!
        snapshot.createdAt = 0
        record.snapshot = normalize(snapshot)

        const replays: Record<string, unknown> = {}
        for (const replay of scenario.replays) {
            const replayMessages = clone(input)
            replay.mutate?.(replayMessages)
            const applied = applyBoundaryPlanSnapshot(replayMessages, snapshot)
            replays[replay.name] = { applied, messages: normalize(replayMessages) }
        }
        record.replays = replays
    }

    return record
}

async function captureAll(): Promise<Record<string, unknown>> {
    const workDirectory = mkdtempSync(join(tmpdir(), "better-compact-golden-"))
    const captured: Record<string, unknown> = {}
    for (const scenario of scenarios) {
        captured[scenario.name] = await captureScenario(scenario, workDirectory)
    }
    return captured
}

if (process.env.GOLDEN_UPDATE) {
    test("golden boundary fixtures regenerated", async () => {
        const captured = await captureAll()
        writeFileSync(FIXTURE_PATH, JSON.stringify(captured, null, 2) + "\n")
        assert.ok(Object.keys(captured).length === scenarios.length)
    })
} else {
    test("golden boundary fixtures match current behavior", async () => {
        const expected = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>
        const captured = await captureAll()
        assert.deepEqual(Object.keys(captured).sort(), Object.keys(expected).sort())
        for (const name of Object.keys(expected)) {
            assert.deepStrictEqual(captured[name], expected[name], `golden scenario drifted: ${name}`)
        }
    })
}
