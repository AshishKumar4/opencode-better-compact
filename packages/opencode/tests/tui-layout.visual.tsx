/** @jsxImportSource @opentui/solid */

import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { BOUNDARY_PROGRESS_STAGES } from "../lib/boundary/progress"
import { PanelDialog, ProgressDialog } from "../lib/tui/dialogs"
import { openProgressModal } from "../lib/tui/modals"
import type { BoundaryJobProgress } from "../lib/state"

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

const api = {
    theme: { current: theme },
    ui: { dialog: { clear: () => undefined } },
}

const settings = {
    automatic: true,
    preset: "light" as const,
    summaryEffort: "inherit" as const,
    custom: {
        triggerPercent: 85,
        targetPercent: 35,
        recentToolTokens: 40_000,
        summarizerConcurrency: 4,
    },
}

function HostDialog(props: { width: number; height: number; children: JSX.Element }) {
    return (
        <box
            width={props.width}
            height={props.height}
            alignItems="center"
            position="absolute"
            paddingTop={props.height / 4}
            left={0}
            top={0}
        >
            <box
                width={116}
                maxWidth={props.width - 2}
                backgroundColor={theme.backgroundPanel}
                paddingTop={1}
            >
                {props.children}
            </box>
        </box>
    )
}

async function renderHosted(node: () => JSX.Element, width: number, height: number) {
    const setup = await testRender(node, { width, height })
    await setup.flush()
    return setup
}

test("settings dialog is vertically centered, bounded, and keeps its footer visible", async () => {
    for (const [width, height] of [
        [80, 24],
        [120, 30],
        [120, 42],
    ]) {
        const setup = await renderHosted(
            () => (
                <HostDialog width={width} height={height}>
                    <PanelDialog
                        api={api as never}
                        settings={settings}
                        availableEfforts={new Set(["inherit", "low", "medium", "high", "max"])}
                        onSettingsChange={() => undefined}
                        onSave={() => undefined}
                        onCancel={() => undefined}
                    />
                </HostDialog>
            ),
            width,
            height,
        )

        try {
            const lines = setup.captureCharFrame().split("\n")
            const header = lines.findIndex((line) => line.includes("Better Compact"))
            const footer = lines.findIndex((line) => line.includes("save"))

            expect(header).toBeGreaterThanOrEqual(0)
            expect(footer).toBeGreaterThan(header)
            expect(footer).toBeLessThan(height)
            expect(Math.abs((header + footer) / 2 - (height - 1) / 2)).toBeLessThanOrEqual(1)
        } finally {
            setup.renderer.destroy()
        }
    }
})

test("settings exposes user-facing strength and effort without legacy controls", async () => {
    const setup = await testRender(
        () => (
            <PanelDialog
                api={api as never}
                settings={settings}
                availableEfforts={new Set(["inherit", "low", "medium", "high", "max"])}
                onSettingsChange={() => undefined}
                onSave={() => undefined}
                onCancel={() => undefined}
            />
        ),
        { width: 120, height: 100 },
    )

    try {
        await setup.flush()
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Automatic compaction")
        expect(frame).toContain("Run automatically")
        expect(frame).toContain("Compaction strength")
        expect(frame).toContain("gentle")
        expect(frame).toContain("balanced")
        expect(frame).toContain("aggressive")
        expect(frame).toContain("Summary effort")
        expect(frame).toContain("model default")
        expect(frame).not.toContain("Custom Sliders")
        expect(frame).not.toContain("Parallel jobs")
        expect(frame).not.toContain("Session State")
        expect(frame).not.toContain("Views")
    } finally {
        setup.renderer.destroy()
    }
})

test("custom strength reveals only meaningful tuning controls", async () => {
    const setup = await testRender(
        () => (
            <PanelDialog
                api={api as never}
                settings={{ ...settings, preset: "custom" }}
                availableEfforts={new Set(["inherit", "high"])}
                onSettingsChange={() => undefined}
                onSave={() => undefined}
                onCancel={() => undefined}
            />
        ),
        { width: 120, height: 100 },
    )

    try {
        await setup.flush()
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Custom compaction")
        expect(frame).toContain("Start at")
        expect(frame).toContain("Deep goal")
        expect(frame).toContain("Keep recent tool output")
        expect(frame).not.toContain("Parallel jobs")
    } finally {
        setup.renderer.destroy()
    }
})

test("progress first frame includes correlated stages and context meters", async () => {
    const initialJob: BoundaryJobProgress = {
        id: "bc_visual",
        sessionId: "session-1",
        status: "running",
        currentStage: "Starting Better Compact",
        percent: 0,
        stages: BOUNDARY_PROGRESS_STAGES.map((stage) => ({ ...stage, status: "pending" })),
        logs: ["Starting Better Compact."],
        counters: {
            beforeTokens: 854_367,
            currentTokens: 854_367,
            targetTokens: 95_200,
            contextLimit: 272_000,
            clearedTokens: 0,
        },
        startedAt: Date.now(),
        updatedAt: Date.now(),
    }
    const setup = await renderHosted(
        () => (
            <HostDialog width={120} height={60}>
                <ProgressDialog
                    api={api as never}
                    job={initialJob}
                    now={initialJob.startedAt}
                    spinner="◐"
                />
            </HostDialog>
        ),
        120,
        60,
    )

    try {
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Loaded session history")
        expect(frame).toContain("Scanned context and token budget")
        expect(frame).toContain("Wrote raw transcript reference")
        expect(frame).toContain("854.4K / 272K")
        expect(frame).not.toContain("Target:")
        expect(frame).not.toContain("█".repeat(60))
    } finally {
        setup.renderer.destroy()
    }

    const compactSetup = await renderHosted(
        () => (
            <HostDialog width={80} height={24}>
                <ProgressDialog
                    api={api as never}
                    job={initialJob}
                    now={initialJob.startedAt}
                    spinner="◐"
                />
            </HostDialog>
        ),
        80,
        24,
    )

    try {
        const frame = compactSetup.captureCharFrame()
        expect(frame).toContain("Starting Better Compact")
        expect(frame).toContain("close")
    } finally {
        compactSetup.renderer.destroy()
    }
})

test("normal-Bun progress controller renders matching completion and stops", async () => {
    const startedAt = Date.now()
    const initialJob: BoundaryJobProgress = {
        id: "bc_controller",
        sessionId: "session-1",
        status: "running",
        currentStage: "Starting Better Compact",
        percent: 0,
        stages: BOUNDARY_PROGRESS_STAGES.map((stage) => ({ ...stage, status: "pending" })),
        logs: ["Starting Better Compact."],
        counters: { beforeTokens: 100_000, currentTokens: 100_000, contextLimit: 200_000 },
        startedAt,
        updatedAt: startedAt,
    }
    const finalJob: BoundaryJobProgress = {
        ...initialJob,
        status: "completed",
        currentStage: "Complete",
        percent: 100,
        stages: initialJob.stages.map((stage) => ({ ...stage, status: "completed" })),
        counters: { ...initialJob.counters, currentTokens: 50_000, clearedTokens: 50_000 },
        updatedAt: startedAt + 20,
        completedAt: startedAt + 20,
    }
    // A leftover from an earlier run: predates this request, so the modal
    // must not adopt it (recent foreign-id jobs ARE adopted — the server
    // enforces one compaction per session, so a recent job is ours).
    const staleJob = {
        ...finalJob,
        id: "bc_stale",
        currentStage: "Stale completion",
        startedAt: startedAt - 60_000,
        updatedAt: startedAt - 59_000,
        completedAt: startedAt - 59_000,
    }
    const renders: Array<() => JSX.Element> = []
    let currentClose: (() => void) | undefined
    let dispose: (() => void) | undefined
    let polls = 0
    const controllerApi = {
        ...api,
        lifecycle: {
            onDispose: (handler: () => void) => {
                dispose = handler
                return () => {
                    if (dispose === handler) dispose = undefined
                }
            },
        },
        ui: {
            ...api.ui,
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

    openProgressModal(controllerApi as never, {} as never, initialJob, {
        intervalMs: 5,
        loadJob: async () => {
            polls += 1
            return polls === 1 ? staleJob : finalJob
        },
    })
    await Bun.sleep(30)
    const terminalPolls = polls
    await Bun.sleep(20)

    expect(terminalPolls).toBe(2)
    expect(polls).toBe(terminalPolls)
    expect(dispose).toBeUndefined()

    const render = renders.at(-1)
    expect(render).toBeDefined()
    const setup = await renderHosted(
        () => (
            <HostDialog width={120} height={60}>
                {render?.()}
            </HostDialog>
        ),
        120,
        60,
    )
    try {
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Complete")
        expect(frame).toContain("100.0%")
        expect(frame).not.toContain("Stale completion")
    } finally {
        setup.renderer.destroy()
        currentClose?.()
    }
})

test("progress controller adopts a recent same-session job with a foreign id", async () => {
    const startedAt = Date.now()
    const initialJob: BoundaryJobProgress = {
        id: "bc_modal_local",
        sessionId: "session-1",
        status: "running",
        currentStage: "Starting Better Compact",
        percent: 0,
        stages: BOUNDARY_PROGRESS_STAGES.map((stage) => ({ ...stage, status: "pending" })),
        logs: ["Starting Better Compact."],
        counters: { beforeTokens: 100_000, currentTokens: 100_000, contextLimit: 200_000 },
        startedAt,
        updatedAt: startedAt,
    }
    // The server minted its own id (command-path trigger or protocol drift),
    // but the job is recent and on our session: single-flight means it is ours.
    const serverJob: BoundaryJobProgress = {
        ...initialJob,
        id: "bc_server_minted",
        status: "completed",
        currentStage: "Complete",
        percent: 100,
        stages: initialJob.stages.map((stage) => ({ ...stage, status: "completed" })),
        startedAt: startedAt + 50,
        updatedAt: startedAt + 80,
        completedAt: startedAt + 80,
    }
    const renders: Array<() => JSX.Element> = []
    let currentClose: (() => void) | undefined
    const controllerApi = {
        ...api,
        lifecycle: { onDispose: () => () => undefined },
        ui: {
            ...api.ui,
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
    openProgressModal(controllerApi as never, {} as never, initialJob, {
        intervalMs: 5,
        loadJob: async () => serverJob,
    })
    await Bun.sleep(40)
    const render = renders.at(-1)
    expect(render).toBeDefined()
    const setup = await renderHosted(
        () => (
            <HostDialog width={120} height={60}>
                {render?.()}
            </HostDialog>
        ),
        120,
        60,
    )
    try {
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Complete")
        expect(frame).toContain("100.0%")
    } finally {
        setup.renderer.destroy()
        currentClose?.()
    }
})
