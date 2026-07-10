import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Readable } from "node:stream"

// Gateway protocol: request headers reach the upstream verbatim. Only the
// hop-by-hop framing headers are excluded — host names the upstream, and
// content-length/transfer-encoding are re-derived from the body we send.
const EXCLUDED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"])

// Preserves original header casing (rawHeaders) and duplicate headers.
export function forwardableHeaders(rawHeaders: string[]): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {}
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index]
        const value = rawHeaders[index + 1]
        if (EXCLUDED_HEADERS.has(name.toLowerCase())) continue
        const existing = headers[name]
        if (existing === undefined) headers[name] = value
        else if (Array.isArray(existing)) existing.push(value)
        else headers[name] = [String(existing), value]
    }
    return headers
}

export interface UpstreamRequest {
    method: string
    // Path (with query) relative to the upstream base URL's own path prefix.
    path: string
    headers: OutgoingHttpHeaders
    body: Buffer | Readable | null
}

export function requestUpstream(base: URL, options: UpstreamRequest): Promise<IncomingMessage> {
    const request = base.protocol === "https:" ? httpsRequest : httpRequest
    const basePath = base.pathname.replace(/\/+$/, "")
    return new Promise((resolve, reject) => {
        const upstream = request(
            {
                protocol: base.protocol,
                hostname: base.hostname,
                port: base.port || undefined,
                method: options.method,
                path: `${basePath}${options.path}`,
                headers: { ...options.headers, host: base.host },
            },
            resolve,
        )
        upstream.on("error", reject)
        if (options.body === null) {
            upstream.end()
        } else if (Buffer.isBuffer(options.body)) {
            upstream.setHeader("content-length", options.body.length)
            upstream.end(options.body)
        } else {
            options.body.pipe(upstream)
        }
    })
}
