import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadConfig, proxyPaths } from "../src/config"
import { CODEX_PROXY_BASE_URL, editCodexConfig, installCodex } from "../src/install"

const PROXY = "http://127.0.0.1:42817/openai"

test("loads a positive OpenAI context-limit override", async () => {
    const home = await mkdtemp(join(tmpdir(), "proxy-config-"))
    try {
        const paths = proxyPaths(home)
        await writeFile(paths.configFile, '{"openaiContextLimit":640000}\n')
        assert.equal(loadConfig(paths).openaiContextLimit, 640_000)
        await writeFile(paths.configFile, '{"openaiContextLimit":0}\n')
        assert.equal(loadConfig(paths).openaiContextLimit, undefined)
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

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

test("edits a root-level key that follows a multiline array, not treating `[...]` array elements as table headers", () => {
    const edit = editCodexConfig(
        'sandbox_writable_roots = [\n  "/tmp",\n  ["nested", "value"],\n]\nopenai_base_url = "https://gw/v1"\n',
        PROXY,
    )
    assert.ok(edit.ok)
    assert.equal(edit.action, "replaced")
    assert.equal(edit.previousBaseUrl, "https://gw/v1")
    assert.match(edit.content, /openai_base_url = "http:\/\/127\.0\.0\.1:42817\/openai"/)
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

test("installCodex preserves the ChatGPT upstream selected by OAuth auth", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-install-"))
    try {
        await mkdir(join(home, ".codex"), { recursive: true })
        await writeFile(join(home, ".codex", "auth.json"), '{"auth_mode":"chatgpt"}\n')
        const paths = proxyPaths(join(home, ".better-compact"))

        installCodex(paths, home)

        const config = JSON.parse(await readFile(paths.configFile, "utf-8")) as {
            openaiUpstream: string
        }
        assert.equal(config.openaiUpstream, "https://chatgpt.com/backend-api/codex")
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

test("installCodex does not overwrite an explicit proxy upstream", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-install-"))
    try {
        await mkdir(join(home, ".codex"), { recursive: true })
        await writeFile(join(home, ".codex", "auth.json"), '{"auth_mode":"chatgpt"}\n')
        const paths = proxyPaths(join(home, ".better-compact"))
        await mkdir(paths.home, { recursive: true })
        await writeFile(paths.configFile, '{"openaiUpstream":"https://explicit.example/v1"}\n')

        installCodex(paths, home)

        const config = JSON.parse(await readFile(paths.configFile, "utf-8")) as {
            openaiUpstream: string
        }
        assert.equal(config.openaiUpstream, "https://explicit.example/v1")
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

test("installCodex infers legacy ChatGPT auth without an auth_mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-install-"))
    try {
        await mkdir(join(home, ".codex"), { recursive: true })
        await writeFile(join(home, ".codex", "auth.json"), '{"tokens":{}}\n')
        const paths = proxyPaths(join(home, ".better-compact"))

        installCodex(paths, home)

        const config = JSON.parse(await readFile(paths.configFile, "utf-8")) as {
            openaiUpstream: string
        }
        assert.equal(config.openaiUpstream, "https://chatgpt.com/backend-api/codex")
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

test("installCodex honors CODEX_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-install-"))
    const previous = process.env.CODEX_HOME
    try {
        const codexHome = join(root, "isolated-codex")
        await mkdir(codexHome, { recursive: true })
        await writeFile(join(codexHome, "auth.json"), '{"auth_mode":"chatgpt"}\n')
        process.env.CODEX_HOME = codexHome
        const paths = proxyPaths(join(root, ".better-compact"))

        const result = installCodex(paths, root)

        assert.equal(result.codexConfigPath, join(codexHome, "config.toml"))
        assert.match(
            await readFile(result.codexConfigPath, "utf-8"),
            /openai_base_url = "http:\/\/127\.0\.0\.1:42817\/openai"/,
        )
    } finally {
        if (previous === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = previous
        await rm(root, { recursive: true, force: true })
    }
})

test("installCodex refuses malformed proxy config before editing Codex", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-install-"))
    try {
        const codexHome = join(home, ".codex")
        await mkdir(codexHome, { recursive: true })
        const original = 'model = "gpt-5.4-mini"\n'
        await writeFile(join(codexHome, "config.toml"), original)
        await writeFile(join(codexHome, "auth.json"), '{"auth_mode":"chatgpt"}\n')
        const paths = proxyPaths(join(home, ".better-compact"))
        await mkdir(paths.home, { recursive: true })
        await writeFile(paths.configFile, "{broken")

        assert.throws(() => installCodex(paths, home), /valid JSON object/)
        assert.equal(await readFile(join(codexHome, "config.toml"), "utf-8"), original)
        assert.equal(await readFile(paths.configFile, "utf-8"), "{broken")
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})

test("installCodex refreshes an inferred upstream when the auth mode changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-install-"))
    try {
        const codexHome = join(home, ".codex")
        await mkdir(codexHome, { recursive: true })
        const authPath = join(codexHome, "auth.json")
        await writeFile(authPath, '{"auth_mode":"chatgpt"}\n')
        const paths = proxyPaths(join(home, ".better-compact"))

        installCodex(paths, home)
        await writeFile(authPath, '{"auth_mode":"apikey","OPENAI_API_KEY":"test"}\n')
        installCodex(paths, home)

        const config = JSON.parse(await readFile(paths.configFile, "utf-8")) as Record<
            string,
            unknown
        >
        assert.equal(config.openaiUpstream, undefined)
        assert.equal(config.openaiUpstreamSource, undefined)
    } finally {
        await rm(home, { recursive: true, force: true })
    }
})
