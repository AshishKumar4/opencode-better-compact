import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import betterCompact from "../src/extension"
import type { PiMessage } from "../src/codec"
import { PLAN_ENTRY_TYPE } from "../src/plan-store"
import { overTriggerConversation } from "./helpers"

type ContextHandler = (
    event: ContextEvent,
    ctx: ExtensionContext,
) => Promise<{ messages?: PiMessage[] } | undefined | void>

interface Harness {
    contextHandler: ContextHandler
    sessionHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown>
    entries: Array<{ type: string; customType: string; data: unknown }>
    commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>
    notifications: string[]
    ctx: ExtensionContext
    agentDir: string
}

interface HarnessOptions {
    contextWindow?: number
    globalConfig?: unknown
    projectConfig?: unknown
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
    const sessionDir = await mkdtemp(join(tmpdir(), "better-compact-pi-"))
    const agentDir = await mkdtemp(join(tmpdir(), "better-compact-pi-agent-"))
    const projectDir = await mkdtemp(join(tmpdir(), "better-compact-pi-project-"))
    process.env.PI_CODING_AGENT_DIR = agentDir
    if (options.globalConfig !== undefined) {
        await writeFile(
            join(agentDir, "better-compact.json"),
            `${JSON.stringify(options.globalConfig)}\n`,
        )
    }
    if (options.projectConfig !== undefined) {
        await mkdir(join(projectDir, ".pi"), { recursive: true })
        await writeFile(
            join(projectDir, ".pi", "better-compact.json"),
            `${JSON.stringify(options.projectConfig)}\n`,
        )
    }
    const entries: Harness["entries"] = []
    const commands: Harness["commands"] = new Map()
    const notifications: string[] = []
    let contextHandler: ContextHandler | undefined
    const sessionHandlers: Harness["sessionHandlers"] = []

    const pi = {
        on(event: string, handler: unknown) {
            if (event === "context") contextHandler = handler as ContextHandler
            if (event === "session_start")
                sessionHandlers.push(handler as Harness["sessionHandlers"][number])
        },
        appendEntry(customType: string, data: unknown) {
            entries.push({ type: "custom", customType, data })
        },
        registerCommand(
            name: string,
            options: { handler: (args: string, ctx: unknown) => Promise<void> },
        ) {
            commands.set(name, options)
        },
    } as unknown as ExtensionAPI

    const ctx = {
        cwd: projectDir,
        isProjectTrusted: () => true,
        model: { contextWindow: options.contextWindow ?? 6_000 },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: false, error: "no credentials in test" }),
        },
        getContextUsage: () => ({
            tokens: null,
            contextWindow: options.contextWindow ?? 6_000,
            percent: null,
        }),
        sessionManager: {
            getSessionId: () => "session-ext",
            getSessionDir: () => sessionDir,
            getBranch: () => entries,
            buildContextEntries: () => [],
        },
        ui: {
            notify: (message: string) => notifications.push(message),
            setStatus: () => {},
        },
    } as unknown as ExtensionContext

    betterCompact(pi)
    assert.ok(contextHandler, "extension must subscribe to the context event")
    return {
        contextHandler: contextHandler!,
        sessionHandlers,
        entries,
        commands,
        notifications,
        ctx,
        agentDir,
    }
}

test("the context event prunes over-trigger sessions and persists the plan as a custom entry", async () => {
    const { contextHandler, sessionHandlers, entries, ctx } = await harness()
    const messages = overTriggerConversation()

    const result = await contextHandler({ type: "context", messages }, ctx)
    assert.ok(result?.messages)
    assert.ok(result!.messages!.length < messages.length)
    assert.ok(
        result!.messages!.some(
            (message) =>
                message.role === "user" &&
                Array.isArray(message.content) &&
                message.content[0]?.type === "text" &&
                message.content[0].text.startsWith("[Better Compact context pruning applied]"),
        ),
    )

    // The plan landed in the session as a custom entry and cites a transcript
    // that was really written under the session dir.
    const planEntry = entries.find((entry) => entry.customType === PLAN_ENTRY_TYPE)
    assert.ok(planEntry)
    const snapshot = (planEntry!.data as { snapshot: { transcriptRelativePath: string } }).snapshot
    assert.match(
        await readFile(snapshot.transcriptRelativePath, "utf-8"),
        /\[tool:bash\] callId=call_0/,
    )

    // A fresh extension instance restores the plan from the branch and replays.
    for (const handler of sessionHandlers) await handler({ reason: "resume" }, ctx)
    const replayed = await contextHandler({ type: "context", messages }, ctx)
    assert.deepEqual(replayed?.messages, result!.messages)
})

test("under-trigger sessions pass through untouched", async () => {
    const { contextHandler, entries, ctx } = await harness()
    const result = await contextHandler(
        { type: "context", messages: overTriggerConversation().slice(0, 4) },
        ctx,
    )
    assert.equal(result, undefined)
    assert.equal(entries.length, 0)
})

test("missing config uses the light preset", async () => {
    const { contextHandler, sessionHandlers, entries, ctx } = await harness({
        contextWindow: 12_000,
    })
    for (const handler of sessionHandlers) await handler({ reason: "startup" }, ctx)

    const result = await contextHandler({ type: "context", messages: overTriggerConversation() }, ctx)
    assert.equal(result, undefined)
    assert.equal(entries.length, 0)
})

test("global config selects the compaction preset", async () => {
    const { contextHandler, sessionHandlers, ctx } = await harness({
        contextWindow: 12_000,
        globalConfig: { preset: "moderate" },
    })
    for (const handler of sessionHandlers) await handler({ reason: "startup" }, ctx)

    const result = await contextHandler({ type: "context", messages: overTriggerConversation() }, ctx)
    assert.ok(result?.messages, "moderate must trigger where light stays below threshold")
})

test("project config overrides the global preset", async () => {
    const { contextHandler, sessionHandlers, ctx } = await harness({
        contextWindow: 12_000,
        globalConfig: { preset: "light" },
        projectConfig: { preset: "moderate" },
    })
    for (const handler of sessionHandlers) await handler({ reason: "startup" }, ctx)

    const result = await contextHandler({ type: "context", messages: overTriggerConversation() }, ctx)
    assert.ok(result?.messages, "moderate must trigger where light stays below threshold")
})

test("the preset command writes the agent-level config", async () => {
    const { commands, notifications, ctx, agentDir } = await harness({
        globalConfig: { automatic: false, preset: "light", extra: "preserve" },
    })
    const command = commands.get("better-compact-preset")
    assert.ok(command, "extension must register the better-compact-preset command")

    await command!.handler("max", ctx)

    const config = JSON.parse(
        await readFile(join(agentDir, "better-compact.json"), "utf-8"),
    ) as Record<string, unknown>
    assert.equal(config.preset, "max")
    assert.equal(config.automatic, false)
    assert.equal(config.extra, "preserve")
    assert.match(notifications.at(-1) ?? "", /preset set to max/i)
})

test("the better-compact command force-builds a plan and reports numbers", async () => {
    const { commands, entries, notifications, ctx } = await harness()
    const command = commands.get("better-compact")
    assert.ok(command, "extension must register the better-compact command")

    const messages = overTriggerConversation()
    const commandCtx = {
        ...(ctx as unknown as Record<string, unknown>),
        sessionManager: {
            ...(ctx.sessionManager as unknown as Record<string, unknown>),
            buildContextEntries: () =>
                messages.map((message, index) => ({
                    type: "message",
                    id: `e${index}`,
                    parentId: index === 0 ? null : `e${index - 1}`,
                    timestamp: new Date(2_000 + index).toISOString(),
                    message,
                })),
        },
    }
    await command!.handler("", commandCtx)
    assert.ok(entries.some((entry) => entry.customType === PLAN_ENTRY_TYPE))
    assert.match(notifications.at(-1) ?? "", /Better Compact: .+ -> .+ tokens/)
})
