import { createHash } from "node:crypto"
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, ".release")
const stage = path.join(out, "better-compact")
const tarball = path.join(out, "better-compact.tar.gz")

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const required = [
    "dist/index.js",
    "dist/tui.js",
    "dist/index.d.ts",
    "dist/tui.d.ts",
    "better-compact.schema.json",
    "README.md",
    "LICENSE",
    "package.json",
]

for (const file of required) {
    if (!existsSync(path.join(root, file))) {
        throw new Error(`missing release input: ${file}`)
    }
}

await rm(out, { recursive: true, force: true })
await mkdir(stage, { recursive: true })

for (const file of required) {
    const source = path.join(root, file)
    const target = path.join(stage, file)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(source, target, { recursive: true })
}

await writeFile(
    path.join(stage, "manifest.json"),
    JSON.stringify(
        {
            name: pkg.name,
            version: pkg.version,
            repository: pkg.repository?.url,
            server: "dist/index.js",
            tui: "dist/tui.js",
        },
        null,
        2,
    ) + "\n",
)

execFileSync("tar", ["-czf", tarball, "-C", stage, "."], { cwd: root, stdio: "inherit" })

const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex")
await writeFile(path.join(out, "checksums.txt"), `${digest}  better-compact.tar.gz\n`)

console.log(`created ${path.relative(root, tarball)}`)
console.log(`sha256 ${digest}`)
