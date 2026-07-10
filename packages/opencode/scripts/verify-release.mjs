import { readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const argument = process.argv.slice(2).find((value) => value !== "--")
const tag = process.env.GITHUB_REF_NAME ?? argument

if (!tag) {
    throw new Error("release tag is required through GITHUB_REF_NAME or the first argument")
}

const expected = `v${pkg.version}`
if (tag !== expected) {
    throw new Error(
        `release tag ${tag} does not match package version ${pkg.version}; expected ${expected}`,
    )
}

console.log(`release tag ${tag} matches ${pkg.name}@${pkg.version}`)
