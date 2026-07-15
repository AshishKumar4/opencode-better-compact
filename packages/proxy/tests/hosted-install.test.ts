import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const INSTALL_SH = join(process.cwd(), "..", "..", "install", "install.sh")

interface InstallerRun {
    status: number | null
    stdout: string
    stderr: string
    calls: string[]
}

function runInstaller(commands: string[], args: string[] = []): InstallerRun {
    const root = mkdtempSync(join(tmpdir(), "better-compact-hosted-install-"))
    const bin = join(root, "bin")
    const callsPath = join(root, "calls.log")
    mkdirSync(bin)

    for (const command of commands) {
        let body = "#!/bin/sh\n"
        if (command === "npm") body += `printf 'npm:%s\\n' "$*" >> "$CALLS"\n`
        if (command === "better-compact-proxy") {
            body += `printf 'proxy:%s\\n' "$*" >> "$CALLS"\n`
        }
        writeFileSync(join(bin, command), body)
        chmodSync(join(bin, command), 0o755)
    }

    try {
        const result = spawnSync("/bin/sh", [INSTALL_SH, ...args], {
            encoding: "utf-8",
            env: { PATH: bin, CALLS: callsPath },
        })
        return {
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            calls: existsSync(callsPath) ? readFileSync(callsPath, "utf-8").trim().split("\n") : [],
        }
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

test("hosted installer is valid POSIX shell syntax", () => {
    const result = spawnSync("/bin/sh", ["-n", INSTALL_SH], { encoding: "utf-8" })

    assert.equal(result.status, 0, result.stderr)
})

test("hosted installer auto-detects every installed agent CLI", () => {
    const cases = [
        { agents: ["claude"], targets: ["claude-code"] },
        { agents: ["codex"], targets: ["codex"] },
        { agents: ["claude", "codex"], targets: ["claude-code", "codex"] },
    ]

    for (const { agents, targets } of cases) {
        const result = runInstaller(["node", "npm", "better-compact-proxy", ...agents])

        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(result.calls, [
            "npm:install -g @better-compact/proxy@latest",
            ...targets.map((target) => `proxy:install ${target}`),
        ])
        assert.match(result.stdout, /Installed @better-compact\/proxy@latest globally\./)
        for (const target of targets) {
            assert.match(result.stdout, new RegExp(`Configured Better Compact for ${target}\\.`))
        }
    }
})

test("an explicit hosted-installer target wins over auto-detection", () => {
    const result = runInstaller(
        ["node", "npm", "better-compact-proxy", "claude", "codex"],
        ["codex"],
    )

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.calls, [
        "npm:install -g @better-compact/proxy@latest",
        "proxy:install codex",
    ])
    assert.match(result.stdout, /Configured Better Compact for codex\./)
    assert.doesNotMatch(result.stdout, /claude-code/)
})

test("hosted installer refuses to install when no supported agent CLI is present", () => {
    const result = runInstaller(["node", "npm", "better-compact-proxy"])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Valid targets: claude-code, codex/)
    assert.deepEqual(result.calls, [])
})

test("hosted installer names missing Node.js and npm prerequisites", () => {
    const missingNode = runInstaller(["npm", "better-compact-proxy"], ["codex"])
    assert.notEqual(missingNode.status, 0)
    assert.match(missingNode.stderr, /Node\.js is required; install Node\.js/)
    assert.deepEqual(missingNode.calls, [])

    const missingNpm = runInstaller(["node", "better-compact-proxy"], ["codex"])
    assert.notEqual(missingNpm.status, 0)
    assert.match(missingNpm.stderr, /npm is required; install npm/)
    assert.deepEqual(missingNpm.calls, [])
})

test("hosted installer rejects an unknown explicit target before npm install", () => {
    const result = runInstaller(["node", "npm", "better-compact-proxy"], ["other"])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Valid targets: claude-code, codex/)
    assert.deepEqual(result.calls, [])
})
