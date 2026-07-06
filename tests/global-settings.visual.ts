import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser/lib/esm/main.js"
import { availableSummaryEfforts, resolveSummaryVariant } from "../lib/tui/data"

const previousConfigHome = process.env.XDG_CONFIG_HOME
const roots: string[] = []

afterEach(() => {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousConfigHome
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
