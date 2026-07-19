import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { installClaudeCode } from "../src/install"

const LEGACY_PROXY_URL = "http://127.0.0.1:42817/anthropic"

test("installClaudeCode removes the legacy proxy redirect and re-enables auto-compaction", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-install-"))
    try {
        const settingsPath = join(home, ".claude", "settings.json")
        await mkdir(join(home, ".claude"), { recursive: true })
        await writeFile(
            settingsPath,
            JSON.stringify({
                theme: "dark",
                env: {
                    ANTHROPIC_BASE_URL: LEGACY_PROXY_URL,
                    DISABLE_AUTO_COMPACT: "1",
                    KEEP: "v",
                },
            }),
        )

        const result = installClaudeCode(home)

        const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
            theme: string
            env: Record<string, string>
        }
        assert.equal(settings.theme, "dark")
        assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined)
        assert.equal(settings.env.DISABLE_AUTO_COMPACT, undefined)
        assert.equal(settings.env.KEEP, "v")
        assert.equal(result.removedBaseUrl, true)
        assert.equal(result.removedDisableAutoCompact, true)
        assert.equal(result.restoredBaseUrl, null)
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

test("installClaudeCode restores a preserved real upstream when removing the redirect", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-install-"))
    try {
        const settingsPath = join(home, ".claude", "settings.json")
        await mkdir(join(home, ".claude"), { recursive: true })
        await writeFile(
            settingsPath,
            JSON.stringify({ env: { ANTHROPIC_BASE_URL: LEGACY_PROXY_URL } }),
        )
        await mkdir(join(home, ".better-compact"), { recursive: true })
        await writeFile(
            join(home, ".better-compact", "config.json"),
            JSON.stringify({ anthropicUpstream: "https://gateway.example/anthropic" }),
        )

        const result = installClaudeCode(home)

        const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
            env: Record<string, string>
        }
        assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://gateway.example/anthropic")
        assert.equal(result.restoredBaseUrl, "https://gateway.example/anthropic")
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

test("installClaudeCode leaves a non-proxy ANTHROPIC_BASE_URL untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-install-"))
    try {
        const settingsPath = join(home, ".claude", "settings.json")
        await mkdir(join(home, ".claude"), { recursive: true })
        await writeFile(
            settingsPath,
            JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://real.example" } }),
        )

        const result = installClaudeCode(home)

        const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
            env: Record<string, string>
        }
        assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://real.example")
        assert.equal(result.removedBaseUrl, false)
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

test("installClaudeCode refuses malformed settings before mutating", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-install-"))
    try {
        const settingsPath = join(home, ".claude", "settings.json")
        await mkdir(join(home, ".claude"), { recursive: true })
        await writeFile(settingsPath, "{broken")

        assert.throws(() => installClaudeCode(home), /settings\.json is not valid JSON/)
        assert.equal(await readFile(settingsPath, "utf-8"), "{broken")
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})
