import type { Logger } from "@better-compact/core"

// The daemon's stdout/stderr land in ~/.better-compact/proxy.log via the
// detached spawn in `start`, so plain console logging is the whole story.
export function createLogger(): Logger {
    const line = (level: string, message: string, data?: unknown) =>
        `${new Date().toISOString()} ${level} ${message}${data === undefined ? "" : ` ${safeJson(data)}`}`
    return {
        info: (message, data) => console.log(line("INFO", message, data)),
        debug: (message, data) => console.log(line("DEBUG", message, data)),
        warn: (message, data) => console.error(line("WARN", message, data)),
        error: (message, data) => console.error(line("ERROR", message, data)),
    }
}

function safeJson(data: unknown): string {
    try {
        return JSON.stringify(data)
    } catch {
        return String(data)
    }
}
