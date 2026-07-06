import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../lib/config"
import {
    createChatMessageHandler,
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    createRuntimeState,
    refreshManualMode,
    saveManualModeSetting,
    saveSessionState,
    type WithParts,
} from "../lib/state"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        compaction: {
            automatic: true,
            preset: "light",
            summaryEffort: "inherit",
            custom: {
                triggerPercent: 85,
                targetPercent: 35,
                recentToolTokens: 40_000,
                summarizerConcurrency: 4,
            },
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function buildMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

function buildUserMessage(
    id: string,
    text: string,
    created: number,
    sessionID = "session-1",
): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID,
                type: "text",
                text,
            },
        ],
    }
}

function buildAssistantToolMessage(
    id: string,
    created: number,
    reportedTokens?: number,
    sessionID = "session-1",
): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created },
            ...(reportedTokens
                ? {
                      tokens: {
                          total: reportedTokens,
                          input: reportedTokens - 1,
                          output: 1,
                          reasoning: 0,
                          cache: { read: 0, write: 0 },
                      },
                  }
                : {}),
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-tool`,
                messageID: id,
                sessionID,
                type: "tool",
                callID: `${id}-call`,
                tool: "read",
                state: {
                    status: "completed",
                    input: { filePath: "src/app.ts" },
                    output: "tool output ".repeat(500),
                    title: "read",
                    metadata: {},
                    time: { start: 1, end: 2 },
                },
            } as any,
        ],
    }
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const started = Date.now()
    while (!condition()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error("Timed out waiting for condition")
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

test("system prompt handler caches full model context for percentage thresholds", async () => {
    const logger = new Logger(false)
    const runtime = createRuntimeState({}, logger)
    const handler = createSystemPromptHandler(runtime, logger, buildConfig("deny"), {
        reload() {},
        getRuntimePrompts() {
            return {} as any
        },
    } as any)

    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: {
                    context: 200000,
                    output: 131072,
                },
            },
        } as any,
        { system: ["base system"] },
    )

    assert.equal(runtime.get("session-1").modelContextLimit, 200000)
})

test("chat message transform strips hallucinated tags even when compress is denied", async () => {
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const client = { session: { get: async () => ({}) }, provider: { list: async () => [] } }
    const runtime = createRuntimeState(client, logger)
    const handler = createChatMessageTransformHandler(
        client as any,
        runtime,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [buildMessage("assistant-1", "assistant", "alpha <dcp>beta</dcp> omega")],
    }

    await handler({}, output)

    assert.equal(output.messages[0]?.parts[0]?.type, "text")
    assert.equal((output.messages[0]?.parts[0] as any).text, "alpha  omega")
})

test("chat message transform drops messages without info instead of crashing", async () => {
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const client = { session: { get: async () => ({}) }, provider: { list: async () => [] } }
    const runtime = createRuntimeState(client, logger)
    const handler = createChatMessageTransformHandler(
        client as any,
        runtime,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [
            {
                role: "user",
                time: 1,
                parts: [
                    {
                        type: "text",
                        text: "Carica le skill di laravel",
                    },
                ],
            } as any,
        ],
    }

    await handler({}, output as any)

    assert.equal(runtime.peek("session-1"), undefined)
    assert.equal(output.messages.length, 0)
})

test("automatic compaction uses freshly loaded global settings", async () => {
    const client = {
        session: { get: async () => ({ data: { parentID: null } }) },
        provider: { list: async () => [] },
    }
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get("session-1")
    state.modelContextLimit = 1_000
    const startupConfig = buildConfig("allow")
    const currentConfig = buildConfig("allow")
    currentConfig.compaction.automatic = false
    const handler = createChatMessageTransformHandler(
        client as any,
        runtime,
        new Logger(false),
        startupConfig,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
        mkdtempSync(join(tmpdir(), "better-compact-automatic-")),
        () => currentConfig,
    )
    const output = {
        messages: [
            buildUserMessage("user-1", "old request", 1),
            buildAssistantToolMessage("assistant-1", 2),
            buildUserMessage("user-2", "middle request", 3),
            buildAssistantToolMessage("assistant-2", 4),
            buildUserMessage("user-3", "latest request", 5),
        ],
    }

    await handler({}, output)

    assert.equal(state.boundary.activePlan, null)
})

test("automatic compaction triggers from provider usage when the local estimate is lower", async () => {
    const sessionID = `session-provider-${process.pid}-${Date.now()}`
    const toasts: unknown[] = []
    const client = {
        session: { get: async () => ({ data: { parentID: null } }) },
        provider: {
            list: async () => [
                {
                    id: "anthropic",
                    models: { "claude-test": { limit: { context: 100_000 } } },
                },
            ],
        },
        tui: {
            showToast: async (input: unknown) => {
                toasts.push(input)
            },
        },
    }
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get(sessionID)
    const config = buildConfig("allow")
    const handler = createChatMessageTransformHandler(
        client as any,
        runtime,
        new Logger(false),
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
        mkdtempSync(join(tmpdir(), "better-compact-provider-trigger-")),
    )
    const output = {
        messages: [
            buildUserMessage("user-1", "old request", 1, sessionID),
            buildAssistantToolMessage("assistant-1", 2, undefined, sessionID),
            buildUserMessage("user-2", "middle request", 3, sessionID),
            buildAssistantToolMessage("assistant-2", 4, 90_000, sessionID),
            buildUserMessage("user-3", "latest request", 5, sessionID),
        ],
    }

    await handler({}, output)

    assert.ok(state.boundary.activePlan)
    assert.equal(state.boundary.activePlan.beforeTokens, 90_000)
    assert.equal(toasts.length, 1)
})

test("concurrent automatic transforms share one committed plan", async () => {
    const sessionID = `session-concurrent-${process.pid}-${Date.now()}`
    const toasts: unknown[] = []
    const client = {
        session: { get: async () => ({ data: { parentID: null } }) },
        provider: {
            list: async () => [
                {
                    id: "anthropic",
                    models: { "claude-test": { limit: { context: 100_000 } } },
                },
            ],
        },
        tui: {
            showToast: async (input: unknown) => {
                toasts.push(input)
            },
        },
    }
    const logger = new Logger(false)
    const runtime = createRuntimeState(client, logger)
    const handler = createChatMessageTransformHandler(
        client as any,
        runtime,
        logger,
        buildConfig("allow"),
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
        mkdtempSync(join(tmpdir(), "better-compact-concurrent-")),
    )
    const messages = [
        buildUserMessage("user-1", "old request", 1, sessionID),
        buildAssistantToolMessage("assistant-1", 2, undefined, sessionID),
        buildUserMessage("user-2", "middle request", 3, sessionID),
        buildAssistantToolMessage("assistant-2", 4, 90_000, sessionID),
        buildUserMessage("user-3", "latest request", 5, sessionID),
    ]
    const first = { messages: structuredClone(messages) }
    const second = { messages: structuredClone(messages) }

    await Promise.all([handler({}, first), handler({}, second)])

    assert.ok(runtime.get(sessionID).boundary.activePlan)
    assert.ok(first.messages.some((message) => message.info.id.startsWith("msg_better_compact_")))
    assert.ok(second.messages.some((message) => message.info.id.startsWith("msg_better_compact_")))
    assert.equal(toasts.length, 1)
})

test("message transform resolves the active model limit before automatic planning", async () => {
    const client = {
        session: { get: async () => ({ data: { parentID: null } }) },
        provider: {
            list: async () => [
                {
                    id: "anthropic",
                    models: {
                        "claude-test": { limit: { context: 1_000_000 } },
                        "claude-small": { limit: { context: 200_000 } },
                    },
                },
            ],
        },
    }
    const runtime = createRuntimeState(client, new Logger(false))
    const config = buildConfig("allow")
    config.compaction.automatic = false
    const handler = createChatMessageTransformHandler(
        client as any,
        runtime,
        new Logger(false),
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const largeModel = buildUserMessage("user-large", "first", 1)
    await handler({}, { messages: [largeModel] })
    assert.equal(runtime.get("session-1").modelContextLimit, 1_000_000)

    const smallModel = buildUserMessage("user-small", "second", 2)
    if (smallModel.info.role === "user") smallModel.info.model.modelID = "claude-small"
    await handler({}, { messages: [smallModel] })

    assert.equal(runtime.get("session-1").modelContextLimit, 200_000)
})

test("automatic compaction replaces an active plan after the raw tail grows over trigger", async () => {
    const sessionID = `session-replan-${process.pid}-${Date.now()}`
    const client = {
        session: { get: async () => ({ data: { parentID: null } }) },
        provider: {
            list: async () => [
                {
                    id: "anthropic",
                    models: { "claude-test": { limit: { context: 100_000 } } },
                },
            ],
        },
    }
    const logger = new Logger(false)
    const runtime = createRuntimeState(client, logger)
    const state = runtime.get(sessionID)
    const config = buildConfig("allow")
    const handler = createChatMessageTransformHandler(
        client as any,
        runtime,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
        mkdtempSync(join(tmpdir(), "better-compact-replan-")),
    )
    const initial = [
        buildUserMessage("user-1", "old request", 1, sessionID),
        buildAssistantToolMessage("assistant-1", 2, undefined, sessionID),
        buildUserMessage("user-2", "middle request", 3, sessionID),
        buildAssistantToolMessage("assistant-2", 4, 90_000, sessionID),
        buildUserMessage("user-3", "latest request", 5, sessionID),
    ]
    await handler({}, { messages: initial })
    const firstRangeHash = state.boundary.activePlan?.rangeHash
    assert.ok(firstRangeHash)
    assert.equal(runtime.activeCompaction(sessionID), undefined)

    const grown = [
        buildUserMessage("user-1", "old request", 1, sessionID),
        buildAssistantToolMessage("assistant-1", 2, undefined, sessionID),
        buildUserMessage("user-2", "middle request", 3, sessionID),
        buildAssistantToolMessage("assistant-2", 4, undefined, sessionID),
        buildUserMessage("user-3", "next request", 5, sessionID),
        buildAssistantToolMessage("assistant-3", 6, undefined, sessionID),
        buildUserMessage("user-4", "more work", 7, sessionID),
        buildAssistantToolMessage("assistant-4", 8, 95_000, sessionID),
        buildUserMessage("user-5", "latest request", 9, sessionID),
    ]
    await handler({}, { messages: grown })

    assert.notEqual(state.boundary.activePlan?.rangeHash, firstRangeHash)
    assert.equal(state.boundary.activePlan?.rawTailStartMessageId, "user-4")
})

test("command execute exits after effective permission resolves to deny", async () => {
    let sessionMessagesCalls = 0
    const output = { parts: [] as any[] }
    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
            messages: async () => {
                sessionMessagesCalls += 1
                return { data: [] }
            },
        },
    }
    const runtime = createRuntimeState(client, new Logger(false))
    const handler = createCommandExecuteHandler(
        client as any,
        runtime,
        new Logger(false),
        buildConfig("deny"),
        "/tmp",
        { global: undefined, agents: {} },
    )

    await handler(
        { command: "better-compact", sessionID: "session-1", arguments: "context" },
        output,
    )

    assert.equal(sessionMessagesCalls, 1)
    assert.deepEqual(output.parts, [])
})

test("better-compact stores virtual plan and reports progress without native summarize", async () => {
    const messages = [
        buildUserMessage("user-1", "old user request", 1),
        buildAssistantToolMessage("assistant-1", 2),
        buildUserMessage("user-2", "middle user request", 3),
        buildMessage("assistant-2", "assistant", "middle assistant response"),
        buildUserMessage("user-3", "latest user request", 5),
    ]
    const prompts: any[] = []
    let summarizeCalls = 0
    const output = { parts: [{ type: "text", text: "/better-compact" }] as any[] }
    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
            messages: async () => ({ data: messages }),
            prompt: async (input: any) => {
                prompts.push(input)
                return { data: true }
            },
            summarize: async () => {
                summarizeCalls += 1
                throw new Error("native compaction should not be called")
            },
        },
    }
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get("session-1")
    const handler = createCommandExecuteHandler(
        client as any,
        runtime,
        new Logger(false),
        buildConfig("allow"),
        mkdtempSync(join(tmpdir(), "better-compact-command-")),
        { global: undefined, agents: {} },
    )

    await handler({ command: "better-compact", sessionID: "session-1", arguments: "" }, output)
    await waitFor(() => state.boundary.job?.status === "completed")

    assert.equal(summarizeCalls, 0)
    assert.equal(output.parts.length, 0)
    assert.ok(state.boundary.activePlan)
    assert.equal(state.boundary.activePlan?.sessionId, "session-1")
    assert.ok(prompts.length >= 1)
    assert.equal(
        prompts.every((prompt) => prompt.body.noReply === true),
        true,
    )
    assert.equal(
        prompts.every((prompt) => prompt.body.parts[0].ignored === true),
        true,
    )
    assert.match(
        prompts.map((prompt) => prompt.body.parts[0].text).join("\n"),
        /Better Compact Complete/,
    )
    assert.equal(state.boundary.job?.percent, 100)
    assert.equal(state.boundary.job?.counters.contextLimit, 200_000)
    assert.ok((state.boundary.job?.counters.beforeTokens ?? 0) > 0)
    assert.ok((state.boundary.job?.counters.currentTokens ?? 0) > 0)
    assert.ok(state.boundary.job?.logs.some((line) => line.includes("Transcript written")))
})

test("chat message sentinel runs better-compact as no-reply TUI action", async () => {
    const messages = [
        buildUserMessage("user-1", "old user request", 1),
        buildAssistantToolMessage("assistant-1", 2),
        buildUserMessage("user-2", "middle user request", 3),
        buildMessage("assistant-2", "assistant", "middle assistant response"),
        buildUserMessage("user-3", "latest user request", 5),
    ]
    const prompts: any[] = []
    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
            messages: async () => ({ data: messages }),
            prompt: async (input: any) => {
                prompts.push(input)
                return { data: true }
            },
        },
    }
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get("session-1")
    const handler = createChatMessageHandler(
        client as any,
        runtime,
        new Logger(false),
        buildConfig("allow"),
        mkdtempSync(join(tmpdir(), "better-compact-sentinel-")),
        { global: undefined, agents: {} },
    )

    await handler(
        {
            sessionID: "session-1",
        },
        {
            message: {
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                variant: "high",
            },
            parts: [
                {
                    type: "text",
                    text: "Better Compact requested.",
                    ignored: true,
                    metadata: {
                        betterCompact: "run",
                        jobId: "bc_tuitest",
                        jobStartedAt: 123_456,
                        summaryVariant: "high",
                        summaryProviderID: "anthropic",
                        summaryModelID: "claude-test",
                        contextLimit: 1_000_000,
                        currentTokens: 857_703,
                    },
                },
            ],
        },
    )
    await waitFor(() => state.boundary.job?.status === "completed")

    assert.ok(state.boundary.activePlan)
    assert.equal(state.boundary.activePlan?.sessionId, "session-1")
    assert.ok(prompts.length >= 1)
    assert.equal(
        prompts.every(
            (prompt) =>
                prompt.body.model.providerID === "anthropic" &&
                prompt.body.model.modelID === "claude-test",
        ),
        true,
    )
    assert.match(
        prompts.map((prompt) => prompt.body.parts[0].text).join("\n"),
        /Better Compact Complete/,
    )
    assert.equal(state.boundary.job?.percent, 100)
    assert.equal(state.boundary.job?.id, "bc_tuitest")
    assert.equal(state.boundary.job?.startedAt, 123_456)
    assert.equal(state.boundary.job?.counters.contextLimit, 1_000_000)
    assert.equal(state.boundary.job?.counters.beforeTokens, 857_703)
    assert.ok((state.boundary.job?.counters.currentTokens ?? 0) > 0)
    assert.ok(
        state.boundary.job?.stages.some(
            (stage) => stage.id === "report" && stage.status === "completed",
        ),
    )
})

test("denied TUI compaction persists a correlated failed job", async () => {
    const sessionID = `session-denied-${Date.now()}`
    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
            messages: async () => ({ data: [] }),
        },
    }
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get(sessionID)
    const handler = createChatMessageHandler(
        client as any,
        runtime,
        new Logger(false),
        buildConfig("deny"),
        mkdtempSync(join(tmpdir(), "better-compact-denied-")),
        { global: undefined, agents: {} },
    )

    await handler(
        { sessionID },
        {
            message: {},
            parts: [
                {
                    type: "text",
                    text: "Better Compact requested.",
                    ignored: true,
                    metadata: {
                        betterCompact: "run",
                        jobId: "bc_denied",
                        jobStartedAt: 123_456,
                        contextLimit: 272_000,
                        currentTokens: 200_000,
                        targetTokens: 95_200,
                    },
                },
            ],
        },
    )

    assert.equal(state.boundary.job?.id, "bc_denied")
    assert.equal(state.boundary.job?.status, "failed")
    assert.match(state.boundary.job?.error ?? "", /denied/i)
    assert.equal(state.boundary.job?.counters.contextLimit, 272_000)
    assert.equal(state.boundary.job?.counters.targetTokens, 95_200)
})

test("text complete strips hallucinated metadata tags", async () => {
    const output = { text: "alpha <dcp>beta</dcp> omega" }
    const handler = createTextCompleteHandler()

    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

    assert.equal(output.text, "alpha  omega")
})

test("event hook attaches durations to matching blocks by message and call id", async () => {
    const logger = new Logger(false)
    const runtime = createRuntimeState({}, logger)
    const state = runtime.get("session-1")
    const handler = createEventHandler(runtime, logger)
    const originalNow = Date.now
    Date.now = () => 100

    try {
        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 325 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 410 },
                        },
                    },
                },
            },
        })
        state.prune.messages.blocksById.set(1, {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "one",
            batchTopic: "one",
            startId: "m0001",
            endId: "m0001",
            anchorMessageId: "msg-a",
            compressMessageId: "message-1",
            compressCallId: "call-1",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-a"],
            effectiveToolIds: [],
            createdAt: 1,
            summary: "a",
        })
        state.prune.messages.blocksById.set(2, {
            blockId: 2,
            runId: 2,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "two",
            batchTopic: "two",
            startId: "m0002",
            endId: "m0002",
            anchorMessageId: "msg-b",
            compressMessageId: "message-1",
            compressCallId: "call-2",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-b"],
            effectiveToolIds: [],
            createdAt: 2,
            summary: "b",
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 410, end: 500 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 325, end: 500 },
                        },
                    },
                },
            },
        })
    } finally {
        Date.now = originalNow
    }

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 225)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 310)
})

test("event hook falls back to completed runtime when running duration missing", async () => {
    const logger = new Logger(false)
    const runtime = createRuntimeState({}, logger)
    const state = runtime.get("session-1")
    const handler = createEventHandler(runtime, logger)

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-3",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-3",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 500, end: 940 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 440)
})

test("event hook queues duration updates until the matching session is loaded", async () => {
    const logger = new Logger(false)
    const targetSessionId = `session-target-${process.pid}-${Date.now()}`
    const otherSessionId = `session-other-${process.pid}-${Date.now()}`
    const persistedState = createSessionState()
    persistedState.sessionId = targetSessionId
    persistedState.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-remote",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    await saveSessionState(persistedState, logger)

    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
        },
    }
    const runtime = createRuntimeState(client, logger)
    const liveState = runtime.get(targetSessionId)
    const otherState = runtime.get(otherSessionId)
    const handler = createEventHandler(runtime, logger)

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    assert.equal(liveState.compressionTiming.pendingByCallId.has("message-1:call-remote"), true)
    assert.equal(liveState.compressionTiming.startsByCallId.has("message-1:call-remote"), false)

    await runtime.prepare(
        targetSessionId,
        [
            {
                info: {
                    id: "msg-user-1",
                    role: "user",
                    sessionID: targetSessionId,
                    agent: "assistant",
                    time: { created: 1 },
                } as WithParts["info"],
                parts: [],
            },
        ],
        false,
    )

    assert.equal(liveState.prune.messages.blocksById.get(1)?.durationMs, 250)
    assert.equal(liveState.compressionTiming.pendingByCallId.has("message-1:call-remote"), false)
    assert.equal(otherState.compressionTiming.pendingByCallId.size, 0)
})

test("event hook keeps same call id distinct across message ids", async () => {
    const logger = new Logger(false)
    const runtime = createRuntimeState({}, logger)
    const state = runtime.get("session-1")
    const handler = createEventHandler(runtime, logger)

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    state.prune.messages.blocksById.set(2, {
        blockId: 2,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "two",
        batchTopic: "two",
        startId: "m0002",
        endId: "m0002",
        anchorMessageId: "msg-b",
        compressMessageId: "message-2",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-b"],
        effectiveToolIds: [],
        createdAt: 2,
        summary: "b",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 200,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 450, end: 700 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 350)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 150)
})

test("manual mode persisted setting refreshes server session state", async () => {
    const logger = new Logger(false)
    const sessionId = `manual-mode-${Date.now()}-${Math.random().toString(16).slice(2)}`

    await saveManualModeSetting(sessionId, true, logger)

    const state = createSessionState()
    state.sessionId = sessionId
    state.manualMode = false

    await refreshManualMode(state, sessionId, logger, false)
    assert.equal(state.manualMode, "active")

    await saveManualModeSetting(sessionId, false, logger)
    await refreshManualMode(state, sessionId, logger, true)
    assert.equal(state.manualMode, false)
})
