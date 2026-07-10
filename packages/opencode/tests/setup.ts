import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dataHome = mkdtempSync(join(tmpdir(), "better-compact-tests-"))
process.env.XDG_DATA_HOME = dataHome
process.on("exit", () => rmSync(dataHome, { recursive: true, force: true }))
