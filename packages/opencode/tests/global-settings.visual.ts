import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "jsonc-parser/lib/esm/main.js"
import { availableSummaryEfforts, resolveSummaryVariant } from "../lib/tui/data"
import { boundaryRangeHash } from "../lib/boundary/fingerprint"
import { createSessionState, saveSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"

const previousConfigHome = process.env.XDG_CONFIG_HOME
const previousDataHome = process.env.XDG_DATA_HOME
const originalSetTimeout = globalThis.setTimeout
const roots: string[] = []

afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("global compaction save preserves JSONC comments and unrelated settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-global-settings-"))
    roots.push(root)
    process.env.XDG_CONFIG_HOME = root
    const dir = join(root, "opencode")
    const path = join(dir, "better-compact.jsonc")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
        path,
        `{
  // keep this comment
  "debug": true,
  "compaction": {
    // preserve profile notes
    "preset": "light"
  }
}
`,
    )

    const config = await import(`../lib/config.ts?global-settings=${Date.now()}`)
    const current = config.loadGlobalCompactionConfig()
    expect(current.automatic).toBe(true)
    expect(current.preset).toBe("light")
    expect(current.summaryEffort).toBe("inherit")

    const result = config.saveGlobalCompactionConfig({
        ...current,
        automatic: false,
        preset: "custom",
        summaryEffort: "high",
        custom: {
            ...current.custom,
            triggerPercent: 80,
            targetPercent: 30,
            recentToolTokens: 30_000,
        },
    })
    expect(result.ok).toBe(true)

    const saved = readFileSync(path, "utf-8")
    expect(saved).toContain("// keep this comment")
    expect(saved).toContain("// preserve profile notes")
    const parsed = parse(saved)
    expect(parsed.debug).toBe(true)
    expect(parsed.compaction).toEqual({
        automatic: false,
        preset: "custom",
        summaryEffort: "high",
        custom: {
            triggerPercent: 80,
            targetPercent: 30,
            recentToolTokens: 30_000,
            summarizerConcurrency: 4,
        },
    })
})

test("global compaction save refuses malformed JSONC", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-invalid-settings-"))
    roots.push(root)
    process.env.XDG_CONFIG_HOME = root
    const dir = join(root, "opencode")
    const path = join(dir, "better-compact.jsonc")
    mkdirSync(dir, { recursive: true })
    const malformed = `{ "compaction": { "preset": "light", } trailing }`
    writeFileSync(path, malformed)

    const config = await import(`../lib/config.ts?invalid-settings=${Date.now()}`)
    const result = config.saveGlobalCompactionConfig(config.loadGlobalCompactionConfig())

    expect(result.ok).toBe(false)
    expect(readFileSync(path, "utf-8")).toBe(malformed)
})

test("runtime config rejects malformed layers and disables automatic compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-invalid-runtime-"))
    roots.push(root)
    process.env.XDG_CONFIG_HOME = root
    const dir = join(root, "opencode")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
        join(dir, "better-compact.jsonc"),
        `{ "compaction": { "automatic": true, "preset": "max", } trailing }`,
    )

    const config = await import(`../lib/config.ts?invalid-runtime=${Date.now()}`)
    const loaded = config.getConfig(
        {
            directory: root,
            worktree: root,
            client: {},
        } as never,
        { warnings: false },
    )

    expect(loaded.compaction.automatic).toBe(false)
    expect(loaded.autoUpdate).toBe(false)
    expect(loaded.compaction.preset).toBe("light")
})

test("runtime config disables automatic compaction when a discovered layer is unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-unreadable-runtime-"))
    roots.push(root)
    process.env.XDG_CONFIG_HOME = root
    const dir = join(root, "opencode")
    const path = join(dir, "better-compact.jsonc")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `{ "compaction": { "automatic": true } }`)
    chmodSync(path, 0o000)

    const config = await import(`../lib/config.ts?unreadable-runtime=${Date.now()}`)
    const loaded = config.getConfig(
        { directory: root, worktree: root, client: {} } as never,
        { warnings: false },
    )

    chmodSync(path, 0o600)
    expect(loaded.compaction.automatic).toBe(false)
})

test("stale manualMode config warns and loads recognized settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-stale-config-"))
    roots.push(root)
    process.env.XDG_CONFIG_HOME = root
    const dir = join(root, "opencode")
    const toasts: unknown[] = []
    mkdirSync(dir, { recursive: true })
    writeFileSync(
        join(dir, "better-compact.jsonc"),
        JSON.stringify({
            debug: true,
            manualMode: {
                enabled: true,
                automaticStrategies: false,
            },
        }),
    )
    globalThis.setTimeout = ((callback: () => void) => {
        callback()
        return 0
    }) as typeof setTimeout

    const config = await import(`../lib/config.ts?stale-config=${Date.now()}`)
    const loaded = config.getConfig({
        directory: root,
        worktree: root,
        client: {
            tui: {
                showToast: (toast: unknown) => {
                    toasts.push(toast)
                },
            },
        },
    } as never)

    expect(config.getInvalidConfigKeys({ manualMode: { enabled: true } })).toEqual([
        "manualMode",
        "manualMode.enabled",
    ])
    expect(loaded.enabled).toBe(true)
    expect(loaded.debug).toBe(true)
    expect(toasts).toHaveLength(1)
    expect(JSON.stringify(toasts[0])).toContain("Unknown keys: manualMode")
    expect(JSON.stringify(toasts[0])).toContain('"variant":"warning"')
})

test("summary effort uses only variants supported by the active model", () => {
    const api = {
        state: {
            session: {
                get: () => ({
                    model: { id: "model-2", providerID: "provider-1", variant: "high" },
                }),
                messages: () => [
                    {
                        role: "assistant",
                        providerID: "provider-1",
                        modelID: "model-1",
                    },
                ],
            },
            provider: [
                {
                    id: "provider-1",
                    models: {
                        "model-1": {
                            variants: { low: {} },
                        },
                        "model-2": {
                            variants: { medium: {}, high: {}, xhigh: {} },
                        },
                    },
                },
            ],
        },
    }

    expect([...availableSummaryEfforts(api as never, "session-1")]).toEqual([
        "inherit",
        "medium",
        "high",
        "max",
    ])
    expect(resolveSummaryVariant(api as never, "session-1", "inherit")).toBeUndefined()
    expect(resolveSummaryVariant(api as never, "session-1", "low")).toBeUndefined()
    expect(resolveSummaryVariant(api as never, "session-1", "medium")).toBe("medium")
    expect(resolveSummaryVariant(api as never, "session-1", "max")).toBe("xhigh")
})

test("server entrypoint suppresses duplicate plugin instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-duplicate-plugin-"))
    roots.push(root)
    process.env.XDG_CONFIG_HOME = root
    const configDir = join(root, "opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "better-compact.jsonc"), `{ "autoUpdate": false }`)
    const toasts: unknown[] = []
    const client = {
        tui: {
            showToast: async (input: unknown) => {
                toasts.push(input)
            },
        },
    }
    const plugin = (await import(`../index.ts?duplicate=${Date.now()}`)).default
    const ctx = {
        client,
        directory: root,
        worktree: root,
    } as never

    const first = await plugin(ctx)
    const second = await plugin(ctx)

    expect(typeof first["experimental.chat.messages.transform"]).toBe("function")
    expect(Object.keys(second)).toEqual([])
    expect(toasts).toHaveLength(1)
})

test("forked sessions remap a matching semantic plan to new message IDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-fork-plan-"))
    roots.push(root)
    process.env.XDG_DATA_HOME = join(root, "data")
    const project = join(root, "project")
    const transcriptRelativePath = ".opencode/better-compact/sessions/source/plan.md"
    const transcriptPath = join(project, transcriptRelativePath)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, "source transcript")
    const message = (id: string, sessionID: string, text: string, created: number): WithParts => ({
        info: {
            id,
            sessionID,
            role: "user",
            agent: "assistant",
            model: { providerID: "test", modelID: "model" },
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
    })
    const sourceMessages = [
        message("source-1", "source", "shared prefix", 1),
        message("source-2", "source", "raw tail", 2),
    ]
    const sourceState = createSessionState("source")
    sourceState.boundary.activePlan = {
        sessionId: "source",
        rangeHash: "0123456789abcdef",
        contextLimit: 100_000,
        rawTailStartMessageId: "source-2",
        prefixFingerprint: boundaryRangeHash(sourceMessages.slice(0, 1)),
        compactedMessageCount: 1,
        transcriptRelativePath,
        beforeTokens: 90_000,
        afterPruneTokens: 20_000,
        overheadTokens: 0,
        triggerTokens: 85_000,
        targetTokens: 35_000,
        requiresCustomCompaction: false,
        createdAt: 1,
    }
    await saveSessionState(sourceState, new Logger(false))
    const childMessages = [
        message("child-1", "child", "shared prefix", 1),
        message("child-2", "child", "raw tail", 2),
    ]

    const boundary = await import(`../lib/boundary/context.ts?fork=${Date.now()}`)
    const inherited = await boundary.findMatchingBoundaryPlan(
        "child",
        childMessages,
        project,
        new Logger(false),
    )

    expect(inherited?.sessionId).toBe("child")
    expect(inherited?.rawTailStartMessageId).toBe("child-2")
    expect(inherited?.rangeHash).not.toBe("0123456789abcdef")
})
