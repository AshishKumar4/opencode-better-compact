/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The persisted-state directory is resolved at import time, so the temp
// storage root has to be in place before any plugin module is loaded.
const storageHome = mkdtempSync(join(tmpdir(), "bc-progress-channel-"))
process.env.XDG_DATA_HOME = storageHome

const { createSessionState } = await import("../lib/state/state")
const { saveSessionState } = await import("../lib/state/persistence")
const {
    startBoundaryJob,
    setBoundaryStage,
    updateBoundaryPercent,
    completeBoundaryJob,
} = await import("../lib/boundary/progress")
const { openProgressModal } = await import("../lib/tui/modals")
const { PLUGIN_VERSION } = await import("../lib/version")

const theme = {
    primary: "#5f9fff",
    accent: "#5f9fff",
    text: "#ffffff",
    textMuted: "#999999",
    backgroundElement: "#202020",
    backgroundPanel: "#171717",
    borderSubtle: "#555555",
    selectedListItemText: "#000000",
    success: "#00ff88",
    warning: "#ffaa00",
    error: "#ff5555",
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

function HostDialog(props: { children: JSX.Element }) {
    return (
        <box width={120} height={60} alignItems="center" position="absolute" left={0} top={0}>
            <box width={116} backgroundColor={theme.backgroundPanel}>
                {props.children}
            </box>
        </box>
    )
}

async function frameOf(render: (() => JSX.Element) | undefined): Promise<string> {
    const setup = await testRender(() => <HostDialog>{render?.()}</HostDialog>, {
        width: 120,
        height: 60,
    })
    await setup.flush()
    try {
        return setup.captureCharFrame()
    } finally {
        setup.renderer.destroy()
    }
}

// Regression guard for the reported freeze: the modal showed "Overall 0.0%"
// for the whole run while the server completed and posted its report. This
// drives the real server-side mutators through the real persistence layer and
// the real loadBoundaryJob the modal uses — no stubbed loader — so a break
// anywhere in that channel fails here.
test("server progress reaches the modal through real persisted state", async () => {
    const sessionId = "ses_progress_channel"
    const state = createSessionState(sessionId)
    const job = startBoundaryJob(state, {
        sessionId,
        counters: {
            beforeTokens: 800_000,
            currentTokens: 800_000,
            targetTokens: 300_000,
            contextLimit: 1_000_000,
        },
    })
    await saveSessionState(state, logger)

    const renders: Array<() => JSX.Element> = []
    let currentClose: (() => void) | undefined
    const api = {
        theme: { current: theme },
        lifecycle: { onDispose: () => () => undefined },
        ui: {
            dialog: {
                replace: (render: () => JSX.Element, onClose?: () => void) => {
                    currentClose?.()
                    renders.push(render)
                    currentClose = onClose
                },
                setSize: () => undefined,
                clear: () => currentClose?.(),
            },
        },
    }

    try {
        // The modal gets its OWN copy, as it does in production (the TUI mints
        // the initial job in a separate process from the server). Sharing the
        // server's object would let in-place mutation masquerade as a working
        // channel. No loadJob override: disk is the only path in.
        openProgressModal(api as never, {} as never, structuredClone(job), {
            intervalMs: 10,
        })

        const first = await frameOf(renders.at(-1))
        expect(first).toContain("0.0%")
        // The running plugin version is always on screen, so a stale cached
        // bundle is visible at a glance instead of being debugged blind.
        expect(first).toContain(`v${PLUGIN_VERSION}`)

        // Server advances a few stages, as runBetterCompact does per stage.
        setBoundaryStage(state, "load", "completed", "1482 messages loaded")
        setBoundaryStage(state, "scan", "completed", "Projected 800K -> 300K")
        setBoundaryStage(state, "transcript", "completed", "1200 messages archived")
        setBoundaryStage(state, "skills", "running", "Pruning loaded skills")
        updateBoundaryPercent(state)
        await saveSessionState(state, logger)

        await Bun.sleep(120)
        const mid = await frameOf(renders.at(-1))
        expect(mid).not.toContain("0.0%")
        expect(mid).toContain("1482 messages loaded")
        expect(mid).toContain("Projected 800K -> 300K")

        completeBoundaryJob(state, "Complete")
        await saveSessionState(state, logger)

        await Bun.sleep(120)
        const done = await frameOf(renders.at(-1))
        expect(done).toContain("100.0%")
        expect(done).toContain("Complete")
    } finally {
        currentClose?.()
        rmSync(storageHome, { recursive: true, force: true })
    }
})
