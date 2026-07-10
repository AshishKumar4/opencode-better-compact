import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const INSTALL_SH = join(process.cwd(), "scripts", "install.sh")

const FAKE_CURL = `#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *better-compact.tar.gz) cp "$FIXTURE_DIR/better-compact.tar.gz" "$out" ;;
  *checksums.txt) cp "$FIXTURE_DIR/checksums.txt" "$out" ;;
  *) exit 22 ;;
esac
`

interface Fixture {
    root: string
    fixtureDir: string
    binDir: string
    configDir: string
    installRoot: string
}

function buildFixture(): Fixture {
    const root = mkdtempSync(join(tmpdir(), "better-compact-install-"))
    const fixtureDir = join(root, "fixture")
    const payloadDir = join(fixtureDir, "payload")
    mkdirSync(join(payloadDir, "dist"), { recursive: true })
    writeFileSync(join(payloadDir, "manifest.json"), JSON.stringify({ name: "better-compact", version: "9.9.9" }))
    writeFileSync(join(payloadDir, "dist", "index.js"), "export default {}\n")
    writeFileSync(join(payloadDir, "dist", "tui.js"), "export default {}\n")
    execFileSync("tar", ["-czf", join(fixtureDir, "better-compact.tar.gz"), "-C", payloadDir, "."])

    const hash = createHash("sha256").update(readFileSync(join(fixtureDir, "better-compact.tar.gz"))).digest("hex")
    writeFileSync(join(fixtureDir, "checksums.txt"), `${hash}  better-compact.tar.gz\n`)

    const binDir = join(root, "bin")
    mkdirSync(binDir)
    writeFileSync(join(binDir, "curl"), FAKE_CURL)
    chmodSync(join(binDir, "curl"), 0o755)

    const configDir = join(root, "config")
    const installRoot = join(root, "plugins")
    return { root, fixtureDir, binDir, configDir, installRoot }
}

function runInstaller(fixture: Fixture, pathOverride?: string) {
    return spawnSync("sh", [INSTALL_SH], {
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: pathOverride ?? `${fixture.binDir}:${process.env.PATH}`,
            FIXTURE_DIR: fixture.fixtureDir,
            OPENCODE_CONFIG_DIR: fixture.configDir,
            BETTER_COMPACT_HOME: fixture.installRoot,
        },
    })
}

test("install.sh installs, rewrites config, and exits 0", () => {
    const fixture = buildFixture()
    try {
        mkdirSync(fixture.configDir, { recursive: true })
        writeFileSync(
            join(fixture.configDir, "opencode.json"),
            JSON.stringify({ plugin: ["file:///old/opencode-dcp/index.js", "file:///keep/other-plugin.js"] }),
        )

        const result = runInstaller(fixture)
        assert.equal(result.status, 0, `stderr: ${result.stderr}`)
        assert.match(result.stdout, /Better Compact 9\.9\.9 installed/)
        assert.match(result.stdout, /Server: file:\/\/.*dist\/index\.js/)
        assert.match(result.stdout, /TUI: {4}file:\/\/.*dist\/tui\.js/)

        const serverConfig = JSON.parse(readFileSync(join(fixture.configDir, "opencode.json"), "utf8"))
        assert.equal(serverConfig.plugin.length, 2)
        assert.equal(serverConfig.plugin[0], "file:///keep/other-plugin.js")
        assert.equal(serverConfig.plugin[1], `file://${join(fixture.installRoot, "current", "dist", "index.js")}`)

        const tuiConfig = JSON.parse(readFileSync(join(fixture.configDir, "tui.json"), "utf8"))
        assert.equal(tuiConfig.plugin[0], `file://${join(fixture.installRoot, "current", "dist", "tui.js")}`)

        const current = realpathSync(join(fixture.installRoot, "current"))
        assert.equal(current, realpathSync(join(fixture.installRoot, "9.9.9")))
    } finally {
        rmSync(fixture.root, { recursive: true, force: true })
    }
})

test("install.sh refuses malformed config JSON before any mutation", () => {
    const fixture = buildFixture()
    try {
        mkdirSync(fixture.configDir, { recursive: true })
        const badPath = join(fixture.configDir, "opencode.json")
        writeFileSync(badPath, "{ not: valid json")
        const before = readFileSync(badPath, "utf8")

        const result = runInstaller(fixture)
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /opencode\.json is not valid JSON/)
        // Zero side effects: the bad file is untouched and nothing was installed.
        assert.equal(readFileSync(badPath, "utf8"), before)
        assert.equal(existsSync(fixture.installRoot), false)
        assert.equal(existsSync(join(fixture.configDir, "tui.json")), false)
    } finally {
        rmSync(fixture.root, { recursive: true, force: true })
    }
})

test("install.sh aborts on checksum mismatch", () => {
    const fixture = buildFixture()
    try {
        writeFileSync(join(fixture.fixtureDir, "checksums.txt"), `${"0".repeat(64)}  better-compact.tar.gz\n`)
        const result = runInstaller(fixture)
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /checksum verification failed/)
    } finally {
        rmSync(fixture.root, { recursive: true, force: true })
    }
})

test("install.sh verifies checksums even without sha256sum/shasum", () => {
    const fixture = buildFixture()
    try {
        const restrictedBin = join(fixture.root, "restricted-bin")
        mkdirSync(restrictedBin)
        writeFileSync(join(restrictedBin, "curl"), FAKE_CURL)
        chmodSync(join(restrictedBin, "curl"), 0o755)
        for (const tool of ["sh", "node", "tar", "gzip", "awk", "grep", "mktemp", "rm", "mkdir", "cp", "ln"]) {
            const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim()
            symlinkSync(real, join(restrictedBin, tool))
        }

        writeFileSync(join(fixture.fixtureDir, "checksums.txt"), `${"0".repeat(64)}  better-compact.tar.gz\n`)
        const tampered = runInstaller(fixture, restrictedBin)
        assert.notEqual(tampered.status, 0, "tampered install must fail without sha tools present")
        assert.match(tampered.stderr, /checksum verification failed/)

        const hash = createHash("sha256")
            .update(readFileSync(join(fixture.fixtureDir, "better-compact.tar.gz")))
            .digest("hex")
        writeFileSync(join(fixture.fixtureDir, "checksums.txt"), `${hash}  better-compact.tar.gz\n`)
        const clean = runInstaller(fixture, restrictedBin)
        assert.equal(clean.status, 0, `stderr: ${clean.stderr}`)
    } finally {
        rmSync(fixture.root, { recursive: true, force: true })
    }
})
