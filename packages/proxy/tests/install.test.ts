import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { proxyPaths } from "../src/config"
import { CODEX_PROXY_BASE_URL, editCodexConfig, installCodex } from "../src/install"

const PROXY = "http://127.0.0.1:42817/openai"

test("appends openai_base_url to a root table when absent", () => {
    const edit = editCodexConfig('model = "gpt-5-codex"\napproval_policy = "on-request"\n', PROXY)
    assert.ok(edit.ok)
    assert.equal(edit.action, "appended")
    assert.equal(edit.previousBaseUrl, null)
    assert.match(edit.content, /^openai_base_url = "http:\/\/127\.0\.0\.1:42817\/openai"$/m)
    assert.match(edit.content, /model = "gpt-5-codex"/)
})

test("inserts the key above the first table header, keeping it top-level", () => {
    const edit = editCodexConfig('model = "gpt-5-codex"\n\n[tui]\ntheme = "dark"\n', PROXY)
    assert.ok(edit.ok)
    const tableIndex = edit.content.split("\n").findIndex((line) => line.startsWith("[tui]"))
    const keyIndex = edit.content
        .split("\n")
        .findIndex((line) => line.startsWith("openai_base_url"))
    assert.ok(keyIndex >= 0 && keyIndex < tableIndex, "key must precede the first table header")
})

test("replaces an existing base_url and preserves a custom one as upstream", () => {
    const edit = editCodexConfig(
        'openai_base_url = "https://my-gw.example/v1"\nmodel = "x"\n',
        PROXY,
    )
    assert.ok(edit.ok)
    assert.equal(edit.action, "replaced")
    assert.equal(edit.previousBaseUrl, "https://my-gw.example/v1")
    assert.match(edit.content, /openai_base_url = "http:\/\/127\.0\.0\.1:42817\/openai"/)
    assert.doesNotMatch(edit.content, /my-gw\.example/)
})

test("is idempotent: re-running does not record the proxy as its own upstream", () => {
    const edit = editCodexConfig(`openai_base_url = "${PROXY}"\n`, PROXY)
    assert.ok(edit.ok)
    assert.equal(edit.previousBaseUrl, null)
    assert.equal(edit.action, "replaced")
})

test("refuses when a custom [model_providers.openai] provider is configured", () => {
    const edit = editCodexConfig(
        '[model_providers.openai]\nbase_url = "https://gw/v1"\nwire_api = "responses"\n',
        PROXY,
    )
    assert.ok(!edit.ok)
    assert.match(edit.reason, /model_providers\.openai/)
})

test("refuses when the key is nested inside a table section", () => {
    const edit = editCodexConfig('[profiles.work]\nopenai_base_url = "https://gw/v1"\n', PROXY)
    assert.ok(!edit.ok)
    assert.match(edit.reason, /inside a table/)
})

test("refuses when openai_base_url is assigned more than once", () => {
    const edit = editCodexConfig('openai_base_url = "a"\nopenai_base_url = "b"\n', PROXY)
    assert.ok(!edit.ok)
    assert.match(edit.reason, /assignments/)
})

test("installCodex writes config.toml and records a preserved upstream in config.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-install-"))
    try {
        await mkdir(join(home, ".codex"), { recursive: true })
        await writeFile(
            join(home, ".codex", "config.toml"),
            'openai_base_url = "https://gw.example/v1"\n',
        )
        const paths = proxyPaths(join(home, ".better-compact"))
        const result = installCodex(paths, home)

        assert.equal(result.action, "replaced")
        assert.equal(result.previousBaseUrl, "https://gw.example/v1")
        const toml = await readFile(join(home, ".codex", "config.toml"), "utf-8")
        assert.match(
            toml,
            new RegExp(`openai_base_url = "${CODEX_PROXY_BASE_URL.replace(/[/.]/g, "\\$&")}"`),
        )
        const config = JSON.parse(await readFile(paths.configFile, "utf-8")) as {
            openaiUpstream: string
        }
        assert.equal(config.openaiUpstream, "https://gw.example/v1")
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

test("installCodex creates config.toml when Codex has none", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-install-"))
    try {
        const paths = proxyPaths(join(home, ".better-compact"))
        const result = installCodex(paths, home)
        assert.equal(result.action, "appended")
        assert.equal(result.previousBaseUrl, null)
        const toml = await readFile(join(home, ".codex", "config.toml"), "utf-8")
        assert.match(toml, /openai_base_url = "http:\/\/127\.0\.0\.1:42817\/openai"/)
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})
