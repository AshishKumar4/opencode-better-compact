import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const INSTALL_SH = join(process.cwd(), "scripts", "install.sh")

// The installer validates every config file it will touch before any mutation
// (bin link, settings/config write, daemon start). A malformed settings.json
// must abort cleanly, naming the file, with zero side effects — never a
// half-install and a bare JSON.parse stack trace.
test("install.sh refuses malformed settings.json before any mutation", () => {
    const home = mkdtempSync(join(tmpdir(), "better-compact-cc-install-"))
    try {
        const settingsPath = join(home, ".claude", "settings.json")
        mkdirSync(join(home, ".claude"), { recursive: true })
        writeFileSync(settingsPath, "{ not valid json")
        const before = readFileSync(settingsPath, "utf8")

        const result = spawnSync("sh", [INSTALL_SH], {
            encoding: "utf8",
            env: { ...process.env, HOME: home },
        })

        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /settings\.json is not valid JSON/)
        // Zero side effects: settings untouched, no launcher linked.
        assert.equal(readFileSync(settingsPath, "utf8"), before)
        assert.equal(existsSync(join(home, ".local", "bin", "better-compact-proxy")), false)
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
})
