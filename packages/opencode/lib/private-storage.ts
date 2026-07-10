import * as fs from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"

export async function ensurePrivateDirectory(path: string, root?: string): Promise<void> {
    if (root) await assertNoSymlinkPath(root, path)
    try {
        const existing = await fs.lstat(path)
        if (existing.isSymbolicLink()) {
            throw new Error(`Refusing symlinked Better Compact directory: ${path}`)
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error
        }
    }
    await fs.mkdir(path, { recursive: true, mode: 0o700 })
    await fs.chmod(path, 0o700)
}

export async function writePrivateFile(
    path: string,
    content: string,
    root?: string,
): Promise<void> {
    const directory = dirname(path)
    await ensurePrivateDirectory(directory, root)
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    let handle: fs.FileHandle | undefined
    try {
        handle = await fs.open(
            temporary,
            constants.O_CREAT |
                constants.O_EXCL |
                constants.O_WRONLY |
                constants.O_NOFOLLOW,
            0o600,
        )
        await handle.writeFile(content, { encoding: "utf8" })
        await handle.sync()
        await handle.close()
        handle = undefined
        if (root) await assertNoSymlinkPath(root, directory)
        await fs.rename(temporary, path)
        await fs.chmod(path, 0o600)
        const directoryHandle = await fs.open(directory, "r")
        try {
            await directoryHandle.sync()
        } finally {
            await directoryHandle.close()
        }
    } catch (error) {
        await handle?.close().catch(() => {})
        await fs.rm(temporary, { force: true }).catch(() => {})
        throw error
    }
}

export async function securePrivateFile(path: string): Promise<void> {
    await fs.chmod(path, 0o600)
}

export async function securePrivateTree(path: string): Promise<void> {
    let stat
    try {
        stat = await fs.lstat(path)
    } catch {
        return
    }
    if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symlinked Better Compact path: ${path}`)
    }
    if (!stat.isDirectory()) {
        await fs.chmod(path, 0o600)
        return
    }
    await fs.chmod(path, 0o700)
    const entries = await fs.readdir(path)
    await Promise.all(entries.map((entry) => securePrivateTree(join(path, entry))))
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
    const rootPath = resolve(root)
    const targetPath = resolve(target)
    const targetRelative = relative(rootPath, targetPath)
    if (
        targetRelative === ".." ||
        targetRelative.startsWith(`..${sep}`) ||
        isAbsolute(targetRelative)
    ) {
        throw new Error(`Better Compact path escapes its root: ${target}`)
    }
    let current = rootPath
    for (const component of targetRelative.split(sep).filter(Boolean)) {
        current = join(current, component)
        try {
            const stat = await fs.lstat(current)
            if (stat.isSymbolicLink()) {
                throw new Error(`Refusing symlinked Better Compact path: ${current}`)
            }
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                continue
            }
            throw error
        }
    }
}
