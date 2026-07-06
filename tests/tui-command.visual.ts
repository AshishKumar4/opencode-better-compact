import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "bun:test"

type RegisteredCommand = {
    slashName: string
    run: () => void | Promise<void>
}

test("confirmed below-trigger runs open progress after the host clears confirmation", async () => {
    const configHome = mkdtempSync(join(tmpdir(), "better-compact-tui-command-"))
    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = configHome
    const opencodeConfig = join(configHome, "opencode")
    process.env.OPENCODE_CONFIG_DIR = opencodeConfig
    mkdirSync(opencodeConfig, { recursive: true })
    writeFileSync(
        join(opencodeConfig, "better-compact.jsonc"),
        JSON.stringify({ compaction: { summaryEffort: "high" } }),
    )

    try {
        const { default: plugin } = await import(`../tui.tsx?test=${Date.now()}`)
        let commands: RegisteredCommand[] = []
        let confirm: (() => void) | undefined
        let promptCalls = 0
        let promptInput: any
        let promptFailure: Error | undefined
        let clearCalls = 0
        let dialogOnClose: (() => void) | undefined
        let disposeHandler: (() => void) | undefined
        const dialogRenders: Array<() => unknown> = []
        const api = {
            client: {
                session: {
                    prompt: async (input: any) => {
                        promptCalls += 1
                        promptInput = input
                        if (promptFailure) throw promptFailure
                    },
                },
            },
            state: {
                path: { directory: configHome, worktree: configHome },
                session: {
                    get: () => ({
                        model: {
                            id: "model-1",
                            providerID: "provider-1",
                            variant: "medium",
                        },
                    }),
                    messages: () => [
                        {
                            id: "message-1",
                            role: "assistant",
                            providerID: "provider-1",
                            modelID: "model-1",
                            tokens: {
                                input: 45,
                                output: 1,
                                reasoning: 0,
                                cache: { read: 0, write: 0 },
                            },
                        },
                    ],
                },
                provider: [
                    {
                        id: "provider-1",
                        models: {
                            "model-1": { limit: { context: 100 }, variants: { high: {} } },
                        },
                    },
                ],
            },
            route: { current: { name: "session", params: { sessionID: "session-1" } } },
            kv: {
                get: <T>(_key: string, fallback: T) => fallback,
                set: () => undefined,
            },
            keymap: {
                registerLayer: (layer: { commands: RegisteredCommand[] }) => {
                    commands = layer.commands
                },
            },
            lifecycle: {
                onDispose: (handler: () => void) => {
                    disposeHandler = handler
                    return () => {
                        if (disposeHandler === handler) disposeHandler = undefined
                    }
                },
            },
            ui: {
                dialog: {
                    replace: (render: () => unknown, onClose?: () => void) => {
                        dialogOnClose?.()
                        dialogRenders.push(render)
                        dialogOnClose = onClose
                    },
                    setSize: () => undefined,
                    clear: () => {
                        clearCalls += 1
                        const close = dialogOnClose
                        dialogOnClose = undefined
                        close?.()
                    },
                },
                DialogConfirm: (props: { onConfirm: () => void }) => {
                    confirm = props.onConfirm
                    return null
                },
                toast: () => undefined,
            },
            theme: { current: {} },
        }

        await plugin.tui(api as never)
        const command = commands.find((item) => item.slashName === "better-compact")
        assert.ok(command)

        await command.run()
        assert.equal(dialogRenders.length, 1)
        dialogRenders[0]()
        assert.ok(confirm)

        confirm()
        api.ui.dialog.clear()
        assert.equal(dialogRenders.length, 1)
        assert.equal(promptCalls, 0)

        await new Promise<void>((resolve) => queueMicrotask(resolve))
        assert.equal(clearCalls, 1)
        assert.ok(dialogRenders.length >= 2)
        assert.equal(promptCalls, 1)
        const metadata = promptInput.parts[0].metadata
        assert.match(metadata.jobId, /^bc_/)
        assert.equal(typeof metadata.jobStartedAt, "number")
        assert.equal(metadata.contextLimit, 100)
        assert.equal(metadata.currentTokens, 46)
        assert.equal(metadata.targetTokens, 35)
        assert.equal(metadata.summaryProviderID, "provider-1")
        assert.equal(metadata.summaryModelID, "model-1")
        assert.equal(metadata.summaryVariant, "high")
        assert.deepEqual(promptInput.model, { providerID: "provider-1", modelID: "model-1" })
        assert.equal(promptInput.variant, "high")

        api.ui.dialog.clear()
        const beforeFailure = dialogRenders.length
        promptFailure = new Error("prompt rejected")
        await command.run()
        dialogRenders[beforeFailure]()
        assert.ok(confirm)
        confirm()
        api.ui.dialog.clear()
        await new Promise<void>((resolve) => setImmediate(resolve))

        assert.equal(promptCalls, 2)
        assert.ok(dialogRenders.length >= beforeFailure + 3)
        disposeHandler?.()
    } finally {
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousConfigHome
        if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
        rmSync(configHome, { recursive: true, force: true })
    }
})
