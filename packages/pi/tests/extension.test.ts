import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { mkdtemp } from "node:fs/promises"
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
}

async function harness(): Promise<Harness> {
    const sessionDir = await mkdtemp(join(tmpdir(), "better-compact-pi-"))
    const entries: Harness["entries"] = []
    const commands: Harness["commands"] = new Map()
    const notifications: string[] = []
    let contextHandler: ContextHandler | undefined
    const sessionHandlers: Harness["sessionHandlers"] = []

    const pi = {
        on(event: string, handler: unknown) {
            if (event === "context") contextHandler = handler as ContextHandler
            if (event === "session_start") sessionHandlers.push(handler as Harness["sessionHandlers"][number])
        },
        appendEntry(customType: string, data: unknown) {
            entries.push({ type: "custom", customType, data })
        },
        registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
            commands.set(name, options)
        },
    } as unknown as ExtensionAPI

    const ctx = {
        model: { contextWindow: 6_000 },
        modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no credentials in test" }) },
        getContextUsage: () => ({ tokens: null, contextWindow: 6_000, percent: null }),
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
    return { contextHandler: contextHandler!, sessionHandlers, entries, commands, notifications, ctx }
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
    assert.match(await readFile(snapshot.transcriptRelativePath, "utf-8"), /\[tool:bash\] callId=call_0/)

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
