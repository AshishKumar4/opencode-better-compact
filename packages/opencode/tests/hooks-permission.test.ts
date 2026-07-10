import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginConfig } from "../lib/config"
import {
    createChatMessageHandler,
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createRuntimeState,
    createSessionState,
    refreshManualMode,
    saveManualModeSetting,
    saveSessionState,
    type RuntimeState,
    type WithParts,
} from "../lib/state"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        commands: {
            enabled: true,
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
        experimental: {
            allowSubAgents: false,
        },
        compress: {
            permission,
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
    const handler = createSystemPromptHandler(runtime, logger, buildConfig("deny"))

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

function buildOverTriggerConversation(sessionId: string): WithParts[] {
    const withSession = (message: WithParts): WithParts => {
        message.info.sessionID = sessionId
        for (const part of message.parts) part.sessionID = sessionId
        return message
    }
    const big = buildAssistantToolMessage("assistant-big", 2)
    const tool = big.parts[0] as any
    tool.state.output = "huge tool output ".repeat(4_000)
    return [
        withSession(buildUserMessage("user-1", "old user request", 1)),
        withSession(big),
        withSession(buildUserMessage("user-2", "middle user request", 3)),
        withSession(buildMessage("assistant-2", "assistant", "middle assistant response")),
        withSession(buildUserMessage("user-3", "latest user request", 5)),
    ]
}

function transformClient(contextLimit: number, toasts: unknown[] = []) {
    return {
        session: { get: async () => ({ data: { parentID: null } }) },
        provider: {
            list: async () => [
                {
                    id: "anthropic",
                    models: { "claude-test": { limit: { context: contextLimit } } },
                },
            ],
        },
        tui: {
            showToast: async (input: unknown) => {
                toasts.push(input)
            },
        },
    }
}

function transformHandler(
    client: any,
    runtime: RuntimeState,
    config: PluginConfig,
    directory: string,
) {
    return createChatMessageTransformHandler(
        client,
        runtime,
        new Logger(false),
        config,
        { global: undefined, agents: {} },
        directory,
    )
}

test("auto transform path prunes over-trigger context when compress is allowed", async () => {
    const sessionId = `ses-transform-allow-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const toasts: unknown[] = []
    const client = transformClient(10_000, toasts)
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get(sessionId)
    const handler = transformHandler(
        client,
        runtime,
        buildConfig("allow"),
        mkdtempSync(join(tmpdir(), "better-compact-transform-")),
    )
    const output = { messages }

    await handler({}, output)

    assert.ok(state.boundary.activePlan)
    assert.ok(messages.some((item) => item.info.id.startsWith("msg_better_compact_")))
    assert.ok(!messages.some((item) => item.parts.some((part) => part.type === "tool")))
    assert.equal(toasts.length, 1)
})

test("auto transform path honors the configured compaction profile", async () => {
    const sessionId = `ses-transform-profile-${Date.now()}`
    // ~17K estimated tokens on a 200K limit: far below the default 85%
    // trigger, above a custom 5% one.
    const messages = buildOverTriggerConversation(sessionId)
    const client = transformClient(200_000)
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get(sessionId)
    const config = buildConfig("allow")
    config.compaction = {
        automatic: true,
        preset: "custom",
        summaryEffort: "inherit",
        custom: { triggerPercent: 5, targetPercent: 3, recentToolTokens: 0, summarizerConcurrency: 4 },
    }
    const handler = transformHandler(
        client,
        runtime,
        config,
        mkdtempSync(join(tmpdir(), "better-compact-transform-")),
    )

    await handler({}, { messages })

    assert.ok(state.boundary.activePlan, "custom low trigger must produce a plan where the default would not")
    assert.equal(state.boundary.activePlan.triggerTokens, Math.floor(200_000 * 0.05))

    const controlSessionId = `${sessionId}-control`
    const untouched = buildOverTriggerConversation(controlSessionId)
    const controlClient = transformClient(200_000)
    const controlRuntime = createRuntimeState(controlClient, new Logger(false))
    const defaultHandler = transformHandler(
        controlClient,
        controlRuntime,
        buildConfig("allow"),
        mkdtempSync(join(tmpdir(), "better-compact-transform-")),
    )

    await defaultHandler({}, { messages: untouched })

    assert.equal(
        controlRuntime.get(controlSessionId).boundary.activePlan,
        null,
        "default 85% trigger must not fire at ~8% usage",
    )
})

test("auto transform path never prunes when compress permission is deny", async () => {
    const sessionId = `ses-transform-deny-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const client = transformClient(10_000)
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get(sessionId)
    const handler = transformHandler(
        client,
        runtime,
        buildConfig("deny"),
        mkdtempSync(join(tmpdir(), "better-compact-transform-deny-")),
    )
    const before = JSON.stringify(messages)
    const output = { messages }

    await handler({}, output)

    assert.equal(state.boundary.activePlan, null)
    assert.equal(JSON.stringify(messages), before)
})

test("automatic compaction uses freshly loaded global settings", async () => {
    const client = transformClient(1_000)
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get("session-1")
    const startupConfig = buildConfig("allow")
    const currentConfig = buildConfig("allow")
    currentConfig.compaction.automatic = false
    const handler = createChatMessageTransformHandler(
        client as any,
        runtime,
        new Logger(false),
        startupConfig,
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
    const client = transformClient(100_000, toasts)
    const runtime = createRuntimeState(client, new Logger(false))
    const state = runtime.get(sessionID)
    const handler = transformHandler(
        client,
        runtime,
        buildConfig("allow"),
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
    const client = transformClient(100_000, toasts)
    const logger = new Logger(false)
    const runtime = createRuntimeState(client, logger)
    const handler = transformHandler(
        client,
        runtime,
        buildConfig("allow"),
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
        { global: undefined, agents: {} },
    )
    const largeModel = buildUserMessage("user-large", "first", 1)
    await handler({}, { messages: [largeModel] })
    assert.equal(runtime.get("session-1").modelContextLimit, 1_000_000)

    const smallModel = buildUserMessage("user-small", "second", 2)
    if (smallModel.info.role === "user") (smallModel.info as any).model.modelID = "claude-small"
    await handler({}, { messages: [smallModel] })

    assert.equal(runtime.get("session-1").modelContextLimit, 200_000)
})

test("automatic compaction replaces an active plan after the raw tail grows over trigger", async () => {
    const sessionID = `session-replan-${process.pid}-${Date.now()}`
    const client = transformClient(100_000)
    const logger = new Logger(false)
    const runtime = createRuntimeState(client, logger)
    const state = runtime.get(sessionID)
    const handler = transformHandler(
        client,
        runtime,
        buildConfig("allow"),
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

test("auto transform path degrades to an unpruned request when the transcript write fails", async () => {
    const sessionId = `ses-transform-guard-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const client = transformClient(10_000)
    const runtime = createRuntimeState(client, new Logger(false))
    const brokenDirectory = join(mkdtempSync(join(tmpdir(), "better-compact-broken-")), "not-a-directory")
    writeFileSync(brokenDirectory, "regular file blocking mkdir")
    const handler = transformHandler(client, runtime, buildConfig("allow"), brokenDirectory)
    const output = { messages }

    await handler({}, output)

    assert.ok(!messages.some((item) => item.info.id.startsWith("msg_better_compact_context_")))
    assert.ok(messages.some((item) => item.parts.some((part) => part.type === "tool")))
})

test("auto transform path clears a stale snapshot and rebuilds a fresh plan", async () => {
    const sessionId = `ses-transform-stale-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const logger = new Logger(false)
    const seeded = createSessionState(sessionId)
    seeded.boundary.activePlan = {
        sessionId,
        rangeHash: "deadbeefdeadbeef",
        contextLimit: 10_000,
        rawTailStartMessageId: "user-2",
        transcriptRelativePath: ".opencode/better-compact/sessions/stale/stale.md",
        beforeTokens: 9_000,
        afterPruneTokens: 1_000,
        overheadTokens: 0,
        triggerTokens: 8_500,
        targetTokens: 3_000,
        requiresCustomCompaction: false,
        stages: [],
        createdAt: Date.now(),
    }
    await saveSessionState(seeded, logger)
    const client = transformClient(10_000)
    const runtime = createRuntimeState(client, logger)
    const handler = transformHandler(
        client,
        runtime,
        buildConfig("allow"),
        mkdtempSync(join(tmpdir(), "better-compact-transform-stale-")),
    )
    const output = { messages }

    await handler({}, output)

    const state = runtime.get(sessionId)
    assert.ok(state.boundary.activePlan)
    assert.notEqual(state.boundary.activePlan?.rangeHash, "deadbeefdeadbeef")
    assert.ok(messages.some((item) => item.info.id.startsWith("msg_better_compact_context_")))
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

    await handler({ command: "better-compact", sessionID: "session-1", arguments: "context" }, output)

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
    assert.equal(prompts.every((prompt) => prompt.body.noReply === true), true)
    assert.equal(prompts.every((prompt) => prompt.body.parts[0].ignored === true), true)
    assert.match(prompts.map((prompt) => prompt.body.parts[0].text).join("\n"), /Better Compact Complete/)
    assert.equal(state.boundary.job?.percent, 100)
    assert.equal(state.boundary.job?.counters.contextLimit, 200_000)
    assert.ok((state.boundary.job?.counters.beforeTokens ?? 0) > 0)
    assert.ok((state.boundary.job?.counters.currentTokens ?? 0) > 0)
    assert.ok(state.boundary.job?.logs.some((line) => line.includes("Transcript written")))
})

test("concurrent better-compact runs for a session are rejected while one is in flight", async () => {
    const messages = [
        buildUserMessage("user-1", "old user request", 1),
        buildAssistantToolMessage("assistant-1", 2),
        buildUserMessage("user-2", "middle user request", 3),
        buildMessage("assistant-2", "assistant", "middle assistant response"),
        buildUserMessage("user-3", "latest user request", 5),
    ]
    const prompts: any[] = []
    const releases: Array<() => void> = []
    const client = {
        session: {
            get: async () => ({ data: { parentID: null } }),
            messages: async () => ({ data: messages }),
            prompt: async (input: any) => {
                prompts.push(input)
                await new Promise<void>((resolve) => releases.push(resolve))
                return { data: true }
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
        mkdtempSync(join(tmpdir(), "better-compact-concurrent-manual-")),
        { global: undefined, agents: {} },
    )

    // The first run blocks in its deferred final-report prompt; the second
    // must be turned away by the single-flight guard without starting a job.
    const first = handler({ command: "better-compact", sessionID: "session-1", arguments: "" }, { parts: [] as any[] })
    await first
    await waitFor(() => prompts.length === 1)
    const second = handler({ command: "better-compact", sessionID: "session-1", arguments: "" }, { parts: [] as any[] })
    await waitFor(() => prompts.length === 2)
    releases.splice(0).forEach((release) => release())
    await second
    await waitFor(() => state.boundary.job?.status === "completed")
    releases.splice(0).forEach((release) => release())
    await waitFor(() => runtime.activeCompaction("session-1") === undefined)

    const texts = prompts.map((prompt) => prompt.body.parts[0].text)
    assert.equal(texts.filter((text) => /already running/.test(text)).length, 1)
    assert.equal(texts.filter((text) => /Better Compact Complete/.test(text)).length, 1)
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
    assert.match(prompts.map((prompt) => prompt.body.parts[0].text).join("\n"), /Better Compact Complete/)
    assert.equal(state.boundary.job?.percent, 100)
    assert.equal(state.boundary.job?.id, "bc_tuitest")
    assert.equal(state.boundary.job?.startedAt, 123_456)
    assert.equal(state.boundary.job?.counters.contextLimit, 1_000_000)
    assert.equal(state.boundary.job?.counters.beforeTokens, 857_703)
    assert.ok((state.boundary.job?.counters.currentTokens ?? 0) > 0)
    assert.ok(state.boundary.job?.stages.some((stage) => stage.id === "report" && stage.status === "completed"))
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

function buildForkFixture(sessionID: string): { messages: WithParts[]; prefix: WithParts[] } {
    const messages = [
        buildUserMessage(`${sessionID}-user-1`, "shared fork prefix", 1, sessionID),
        buildMessage(`${sessionID}-assistant-1`, "assistant", "shared fork answer"),
        buildUserMessage(`${sessionID}-user-2`, "fork raw tail", 3, sessionID),
        buildUserMessage(`${sessionID}-user-3`, "fork latest", 5, sessionID),
    ]
    messages[1].info.sessionID = sessionID
    for (const part of messages[1].parts) part.sessionID = sessionID
    return { messages, prefix: messages.slice(0, 2) }
}

async function persistForkSourcePlan(directory: string, prefix: WithParts[]): Promise<void> {
    const { boundaryRangeHash } = await import("../lib/boundary/fingerprint")
    const { mkdirSync } = await import("node:fs")
    const transcriptRelativePath = ".opencode/better-compact/sessions/fork-source/plan.md"
    mkdirSync(join(directory, ".opencode/better-compact/sessions/fork-source"), { recursive: true })
    writeFileSync(join(directory, transcriptRelativePath), "source transcript")
    const source = createSessionState(`fork-source-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    source.boundary.activePlan = {
        sessionId: source.sessionId!,
        rangeHash: "0123456789abcdef",
        contextLimit: 100_000,
        rawTailStartMessageId: "source-raw-tail",
        prefixFingerprint: boundaryRangeHash(prefix),
        compactedMessageCount: prefix.length,
        transcriptRelativePath,
        beforeTokens: 90_000,
        afterPruneTokens: 20_000,
        overheadTokens: 0,
        triggerTokens: 85_000,
        targetTokens: 35_000,
        requiresCustomCompaction: false,
        stages: [],
        createdAt: 1,
    }
    await saveSessionState(source, new Logger(false))
}

test("fork plan inheritance is skipped when compress permission is deny", async () => {
    const directory = mkdtempSync(join(tmpdir(), "better-compact-inherit-deny-"))
    const stamp = `${process.pid}-${Date.now()}`
    const allowSession = `fork-child-allow-${stamp}`
    const denySession = `fork-child-deny-${stamp}`
    const allowFixture = buildForkFixture(allowSession)
    const denyFixture = buildForkFixture(denySession)
    await persistForkSourcePlan(directory, allowFixture.prefix)
    await persistForkSourcePlan(directory, denyFixture.prefix)

    // Same fixtures, permission allow: the plan is inherited.
    const allowClient = transformClient(100_000)
    const allowRuntime = createRuntimeState(allowClient, new Logger(false))
    await transformHandler(allowClient, allowRuntime, buildConfig("allow"), directory)(
        {},
        { messages: allowFixture.messages },
    )
    assert.ok(allowRuntime.get(allowSession).boundary.activePlan)

    // Same fixtures, permission deny: inheritance must not even happen.
    const denyClient = transformClient(100_000)
    const denyRuntime = createRuntimeState(denyClient, new Logger(false))
    await transformHandler(denyClient, denyRuntime, buildConfig("deny"), directory)(
        {},
        { messages: denyFixture.messages },
    )
    assert.equal(denyRuntime.get(denySession).boundary.activePlan, null)
})

test("a waiting transform is not rejected when the active compaction fails", async () => {
    const sessionId = `ses-loser-shield-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const toasts: unknown[] = []
    const client = transformClient(10_000, toasts)
    const runtime = createRuntimeState(client, new Logger(false))
    let rejectWinner!: (error: Error) => void
    runtime.startCompaction(sessionId, () => new Promise((_, reject) => {
        rejectWinner = reject
    }))
    const before = JSON.stringify(messages)
    const handler = transformHandler(
        client,
        runtime,
        buildConfig("allow"),
        mkdtempSync(join(tmpdir(), "better-compact-loser-shield-")),
    )

    const waiting = handler({}, { messages })
    await new Promise((resolve) => setTimeout(resolve, 25))
    rejectWinner(new Error("winner exploded"))
    await waiting

    // The waiting transform degrades quietly: no rejection, no failure toast
    // of its own, request continues unpruned.
    assert.equal(toasts.length, 0)
    assert.equal(JSON.stringify(messages), before)
    await waitFor(() => runtime.activeCompaction(sessionId) === undefined)
})
