import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2).filter((value) => value !== "--")
const executableArg = args[0] ?? process.env.OPENCODE_BIN
const executable = path.resolve(executableArg ?? "")
const packageSpec = args[1]

if (!executableArg) {
    throw new Error("pass the OpenCode executable path as the first argument or OPENCODE_BIN")
}

const sandbox = await mkdtemp(path.join(tmpdir(), "better-compact-install-"))

async function findInstalledPackage(rootDir) {
    const pending = [rootDir]
    while (pending.length > 0) {
        const dir = pending.shift()
        if (!dir) continue

        try {
            const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))
            if (pkg.name === "better-compact") return dir
        } catch {}

        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
            if (entry.isDirectory()) pending.push(path.join(dir, entry.name))
        }
    }
}

try {
    const packageDir = path.join(sandbox, "package")
    const projectDir = path.join(sandbox, "project")
    const configHome = path.join(sandbox, "config")
    const configDir = path.join(configHome, "opencode")

    await mkdir(projectDir, { recursive: true })
    await mkdir(configDir, { recursive: true })
    if (!packageSpec) {
        await mkdir(packageDir, { recursive: true })
        await cp(path.join(root, "package.json"), path.join(packageDir, "package.json"))
        await cp(path.join(root, "dist"), path.join(packageDir, "dist"), { recursive: true })
    }

    const marker = "// better-compact smoke-test comment"
    await writeFile(
        path.join(configDir, "opencode.jsonc"),
        `{
  ${marker}
  "$schema": "https://opencode.ai/config.json",
}
`,
    )
    await writeFile(
        path.join(configDir, "tui.jsonc"),
        `{
  ${marker}
  "$schema": "https://opencode.ai/tui.json",
}
`,
    )

    const env = {
        ...process.env,
        HOME: path.join(sandbox, "home"),
        XDG_CACHE_HOME: path.join(sandbox, "cache"),
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: path.join(sandbox, "data"),
        XDG_STATE_HOME: path.join(sandbox, "state"),
        PATH: path.dirname(executable),
    }

    const version = execFileSync(executable, ["--version"], { encoding: "utf8", env }).trim()
    const target = packageSpec ?? packageDir
    execFileSync(executable, ["plugin", target, "--global"], {
        cwd: projectDir,
        env,
        encoding: "utf8",
        stdio: "pipe",
    })

    for (const name of ["opencode.jsonc", "tui.jsonc"]) {
        const text = await readFile(path.join(configDir, name), "utf8")
        if (!text.includes(marker)) {
            throw new Error(`${name} lost its existing JSONC comment`)
        }
        if (!text.includes(target)) {
            throw new Error(`${name} does not register ${target}`)
        }
    }

    const debug = execFileSync(executable, ["debug", "config"], {
        cwd: projectDir,
        env,
        encoding: "utf8",
        stdio: "pipe",
    })
    const config = JSON.parse(debug)
    if (config.compaction?.auto !== false) {
        throw new Error("server plugin did not initialize and disable native auto-compaction")
    }

    Object.assign(process.env, {
        XDG_CACHE_HOME: env.XDG_CACHE_HOME,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: env.XDG_DATA_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
    })
    const layers = []
    const installedPackage = packageSpec
        ? await findInstalledPackage(env.XDG_CACHE_HOME)
        : undefined
    if (packageSpec && !installedPackage) {
        throw new Error(`OpenCode cache does not contain ${packageSpec}`)
    }
    const tuiPath = path.join(installedPackage ?? root, "dist/tui.js")
    const tui = await import(`${pathToFileURL(tuiPath).href}?smoke=${Date.now()}`)
    await tui.default.tui({
        client: {},
        state: {
            path: { directory: projectDir, worktree: projectDir },
        },
        keymap: {
            registerLayer(layer) {
                layers.push(layer)
            },
        },
    })
    const commands = layers
        .flatMap((layer) => layer.commands ?? [])
        .map((command) => command.slashName)
    for (const command of ["better-compact", "better-compact-settings"]) {
        if (!commands.includes(command)) {
            throw new Error(`TUI plugin did not register /${command}`)
        }
    }

    console.log(
        `OpenCode ${version} installed ${target}, loaded its server plugin without an external runtime, and registered its TUI commands`,
    )
} finally {
    await rm(sandbox, { recursive: true, force: true })
}
