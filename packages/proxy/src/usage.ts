import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import type { IncomingHttpHeaders } from "node:http"

const MAX_BUFFERED_JSON = 4 * 1024 * 1024

// Reads usage out of the response we relay without touching the relayed
// bytes: SSE message_start carries the input-side counts, message_delta the
// final cumulative output count; non-streaming bodies carry plain `usage`.
export interface UsageReader {
    feed(chunk: Buffer): void
    finish(): Promise<number | null>
}

export function createUsageReader(headers: IncomingHttpHeaders): UsageReader {
    const contentType = String(headers["content-type"] ?? "")
    const parser = contentType.includes("text/event-stream") ? sseUsageParser() : jsonUsageParser()
    const encoding = String(headers["content-encoding"] ?? "").toLowerCase()
    if (encoding === "" || encoding === "identity") {
        return { feed: parser.feed, finish: async () => parser.finish() }
    }

    const decompressor =
        encoding === "gzip" || encoding === "x-gzip"
            ? createGunzip()
            : encoding === "br"
              ? createBrotliDecompress()
              : encoding === "deflate"
                ? createInflate()
                : null
    if (!decompressor) return { feed: () => {}, finish: async () => null }

    let failed = false
    decompressor.on("data", (chunk: Buffer) => parser.feed(chunk))
    decompressor.on("error", () => {
        failed = true
    })
    return {
        feed: (chunk) => {
            if (!failed) decompressor.write(chunk)
        },
        finish: () =>
            new Promise((resolve) => {
                if (failed) return resolve(null)
                decompressor.once("error", () => resolve(null))
                decompressor.end(() => resolve(failed ? null : parser.finish()))
            }),
    }
}

interface UsageParser {
    feed(chunk: Buffer): void
    finish(): number | null
}

interface WireUsage {
    input_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens?: number
}

function inputSide(usage: WireUsage): number {
    return (
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
    )
}

function sseUsageParser(): UsageParser {
    let pending = ""
    let inputTokens: number | null = null
    let outputTokens = 0

    const consume = (line: string) => {
        if (!line.startsWith("data:")) return
        let event: { type?: string; message?: { usage?: WireUsage }; usage?: WireUsage }
        try {
            event = JSON.parse(line.slice(5))
        } catch {
            return
        }
        if (event.type === "message_start" && event.message?.usage) {
            inputTokens = inputSide(event.message.usage)
            outputTokens = event.message.usage.output_tokens ?? 0
        } else if (event.type === "message_delta" && event.usage?.output_tokens !== undefined) {
            outputTokens = event.usage.output_tokens
        }
    }

    return {
        feed(chunk) {
            pending += chunk.toString("utf-8")
            const lines = pending.split("\n")
            pending = lines.pop() ?? ""
            for (const line of lines) consume(line.trimEnd())
        },
        finish() {
            if (pending) consume(pending.trimEnd())
            return inputTokens === null ? null : inputTokens + outputTokens
        },
    }
}

function jsonUsageParser(): UsageParser {
    const chunks: Buffer[] = []
    let size = 0
    return {
        feed(chunk) {
            if (size > MAX_BUFFERED_JSON) return
            chunks.push(chunk)
            size += chunk.length
        },
        finish() {
            if (size === 0 || size > MAX_BUFFERED_JSON) return null
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
                    usage?: WireUsage
                }
                if (!body.usage) return null
                return inputSide(body.usage) + (body.usage.output_tokens ?? 0)
            } catch {
                return null
            }
        },
    }
}
