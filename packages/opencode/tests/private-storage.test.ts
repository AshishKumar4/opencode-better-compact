import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensurePrivateDirectory, writePrivateFile } from "../lib/private-storage"
import { createSessionState, saveSessionState } from "../lib/state"
import { Logger } from "../lib/logger"

test("private storage rejects a symlinked destination directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-symlink-"))
    const target = join(root, "target")
    const link = join(root, "link")
    mkdirSync(target)
    symlinkSync(target, link)

    await assert.rejects(
        ensurePrivateDirectory(link),
        /Refusing symlinked Better Compact directory/,
    )
})

test("session persistence rejects path traversal IDs", async () => {
    const state = createSessionState("../../escape")

    await assert.rejects(
        saveSessionState(state, new Logger(false)),
        /Invalid Better Compact session ID/,
    )
})

test("private storage rejects a symlinked ancestor below its trusted root", async () => {
    const root = mkdtempSync(join(tmpdir(), "better-compact-ancestor-symlink-"))
    const target = join(root, "target")
    const link = join(root, ".opencode")
    mkdirSync(target)
    symlinkSync(target, link)

    await assert.rejects(
        writePrivateFile(join(link, "better-compact", "transcript.md"), "secret", root),
        /Refusing symlinked Better Compact path/,
    )
})
