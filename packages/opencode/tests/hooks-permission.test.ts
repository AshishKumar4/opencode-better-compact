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
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    ensureSessionInitialized,
    refreshManualMode,
    saveManualModeSetting,
    saveSessionState,
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
            preset: "light",
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

function buildUserMessage(id: string, text: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "session-1",
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
            time: { created },
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

function buildAssistantToolMessage(id: string, created: number): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session-1",
            agent: "assistant",
            time: { created },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-tool`,
                messageID: id,
                sessionID: "session-1",
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
    const state = createSessionState()
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("deny"))

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

    assert.equal(state.modelContextLimit, 200000)
})

test("chat message transform strips hallucinated tags even when compress is denied", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
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
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
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

    assert.equal(state.sessionId, null)
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

function stubClient() {
    return { session: { get: async () => ({ data: { parentID: null } }) } } as any
}

async function initializedTransformState(sessionId: string, messages: WithParts[]) {
    const state = createSessionState()
    await ensureSessionInitialized(stubClient(), state, sessionId, new Logger(false), messages, false)
    state.modelContextLimit = 10_000
    return state
}

test("auto transform path prunes over-trigger context when compress is allowed", async () => {
    const sessionId = `ses-transform-allow-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const state = await initializedTransformState(sessionId, messages)
    const handler = createChatMessageTransformHandler(
        stubClient(),
        state,
        new Logger(false),
        buildConfig("allow"),
        { global: undefined, agents: {} },
        mkdtempSync(join(tmpdir(), "better-compact-transform-")),
    )
    const output = { messages }

    await handler({}, output)

    assert.ok(state.boundary.activePlan)
    assert.ok(messages.some((item) => item.info.id.startsWith("msg_better_compact_context_")))
    assert.ok(!messages.some((item) => item.parts.some((part) => part.type === "tool")))
})

test("auto transform path never prunes when compress permission is deny", async () => {
    const sessionId = `ses-transform-deny-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const state = await initializedTransformState(sessionId, messages)
    const handler = createChatMessageTransformHandler(
        stubClient(),
        state,
        new Logger(false),
        buildConfig("deny"),
        { global: undefined, agents: {} },
        mkdtempSync(join(tmpdir(), "better-compact-transform-deny-")),
    )
    const before = JSON.stringify(messages)
    const output = { messages }

    await handler({}, output)

    assert.equal(state.boundary.activePlan, null)
    assert.equal(JSON.stringify(messages), before)
})

test("auto transform path degrades to an unpruned request when the transcript write fails", async () => {
    const sessionId = `ses-transform-guard-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const state = await initializedTransformState(sessionId, messages)
    const brokenDirectory = join(mkdtempSync(join(tmpdir(), "better-compact-broken-")), "not-a-directory")
    writeFileSync(brokenDirectory, "regular file blocking mkdir")
    const handler = createChatMessageTransformHandler(
        stubClient(),
        state,
        new Logger(false),
        buildConfig("allow"),
        { global: undefined, agents: {} },
        brokenDirectory,
    )
    const output = { messages }

    await handler({}, output)

    assert.ok(!messages.some((item) => item.info.id.startsWith("msg_better_compact_context_")))
    assert.ok(messages.some((item) => item.parts.some((part) => part.type === "tool")))
})

test("auto transform path clears a stale snapshot and rebuilds a fresh plan", async () => {
    const sessionId = `ses-transform-stale-${Date.now()}`
    const messages = buildOverTriggerConversation(sessionId)
    const state = await initializedTransformState(sessionId, messages)
    state.boundary.activePlan = {
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
    const handler = createChatMessageTransformHandler(
        stubClient(),
        state,
        new Logger(false),
        buildConfig("allow"),
        { global: undefined, agents: {} },
        mkdtempSync(join(tmpdir(), "better-compact-transform-stale-")),
    )
    const output = { messages }

    await handler({}, output)

    assert.ok(state.boundary.activePlan)
    assert.notEqual(state.boundary.activePlan?.rangeHash, "deadbeefdeadbeef")
    assert.ok(messages.some((item) => item.info.id.startsWith("msg_better_compact_context_")))
})

test("command execute exits after effective permission resolves to deny", async () => {
    let sessionMessagesCalls = 0
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(
        {
            session: {
                messages: async () => {
                    sessionMessagesCalls += 1
                    return { data: [] }
                },
            },
        } as any,
        createSessionState(),
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
    const state = createSessionState()
    const output = { parts: [{ type: "text", text: "/better-compact" }] as any[] }
    const handler = createCommandExecuteHandler(
        {
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
        } as any,
        state,
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
    const state = createSessionState()
    const handler = createCommandExecuteHandler(
        {
            session: {
                get: async () => ({ data: { parentID: null } }),
                messages: async () => ({ data: messages }),
                prompt: async (input: any) => {
                    prompts.push(input)
                    await new Promise<void>((resolve) => releases.push(resolve))
                    return { data: true }
                },
            },
        } as any,
        state,
        new Logger(false),
        buildConfig("allow"),
        mkdtempSync(join(tmpdir(), "better-compact-concurrent-")),
        { global: undefined, agents: {} },
    )

    const first = handler({ command: "better-compact", sessionID: "session-1", arguments: "" }, { parts: [] as any[] })
    const second = handler({ command: "better-compact", sessionID: "session-1", arguments: "" }, { parts: [] as any[] })
    await Promise.all([first, second])

    // First run blocks on its deferred final report; the second must have
    // been turned away without starting a job of its own.
    await waitFor(() => prompts.length === 2)
    releases.splice(0).forEach((release) => release())
    await waitFor(() => state.boundary.job?.status === "completed")
    releases.splice(0).forEach((release) => release())

    const texts = prompts.map((prompt) => prompt.body.parts[0].text)
    assert.equal(texts.filter((text) => /already running/.test(text)).length, 1)
    assert.equal(texts.filter((text) => /Better Compact Complete/.test(text)).length, 1)
    assert.equal(state.boundary.runningSessionIds.size, 0)
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
    const state = createSessionState()
    const handler = createChatMessageHandler(
        {
            session: {
                messages: async () => ({ data: messages }),
                prompt: async (input: any) => {
                    prompts.push(input)
                    return { data: true }
                },
            },
        } as any,
        state,
        new Logger(false),
        buildConfig("allow"),
        mkdtempSync(join(tmpdir(), "better-compact-sentinel-")),
        { global: undefined, agents: {} },
    )

    await handler(
        {
            sessionID: "session-1",
            agent: "assistant",
            model: { providerID: "anthropic", modelID: "claude-test" },
        },
        {
            message: {},
            parts: [
                {
                    type: "text",
                    text: "Better Compact requested.",
                    ignored: true,
                    metadata: { betterCompact: "run", contextLimit: 1_000_000, currentTokens: 857_703 },
                },
            ],
        },
    )
    await waitFor(() => state.boundary.job?.status === "completed")

    assert.ok(state.boundary.activePlan)
    assert.equal(state.boundary.activePlan?.sessionId, "session-1")
    assert.ok(prompts.length >= 1)
    assert.match(prompts.map((prompt) => prompt.body.parts[0].text).join("\n"), /Better Compact Complete/)
    assert.equal(state.boundary.job?.percent, 100)
    assert.equal(state.boundary.job?.counters.contextLimit, 1_000_000)
    assert.equal(state.boundary.job?.counters.beforeTokens, 857_703)
    assert.ok((state.boundary.job?.counters.currentTokens ?? 0) > 0)
    assert.ok(state.boundary.job?.stages.some((stage) => stage.id === "report" && stage.status === "completed"))
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
