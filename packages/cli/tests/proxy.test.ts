import assert from "node:assert/strict"
import { after, test } from "node:test"
import {
    createServer,
    request as httpRequest,
    type IncomingHttpHeaders,
    type Server,
} from "node:http"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { COMPACTION_PRESETS, type Logger, type PlanSnapshot } from "@better-compact/core"
import { checkHealth } from "../src/daemon"
import { createProxyServer } from "../src/server"
import { stripAnthropicManualTrigger, type WireMessage } from "../src/anthropic/codec"
import {
    assistantMessage,
    bigConversation,
    messagesBody,
    toolResult,
    toolUse,
    userMessage,
} from "./fixtures"

const silent: Logger = { info() {}, debug() {}, warn() {}, error() {} }

interface Captured {
    method: string
    url: string
    headers: IncomingHttpHeaders
    rawHeaders: string[]
    body: Buffer
}

interface FakeUpstream {
    port: number
    requests: Captured[]
    respond: (req: Captured) => {
        status: number
        headers: Record<string, string>
        chunks: Buffer[]
    }
    close(): Promise<void>
}

function sseBytes(inputTokens: number, outputTokens: number): Buffer[] {
    const events = [
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","usage":{"input_tokens":${inputTokens},"cache_creation_input_tokens":7,"cache_read_input_tokens":13,"output_tokens":1}}}\n\n`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${outputTokens}}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ].join("")
    // Deliberately misaligned chunk boundaries: relay must not care.
    const raw = Buffer.from(events)
    const chunks: Buffer[] = []
    for (let offset = 0; offset < raw.length; offset += 37)
        chunks.push(raw.subarray(offset, offset + 37))
    return chunks
}

function defaultResponder(req: Captured): {
    status: number
    headers: Record<string, string>
    chunks: Buffer[]
} {
    let body: { stream?: boolean } = {}
    try {
        body = JSON.parse(req.body.toString("utf-8") || "{}") as { stream?: boolean }
    } catch {
        // Malformed bodies (fail-open tests) get the JSON reply below.
    }
    if (body.stream) {
        return {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-upstream-mark": "fake" },
            chunks: sseBytes(1_000, 12),
        }
    }
    const summary =
        "## Decisions\n- Keep the implementation.\n\n## Files & Symbols\n- src/index.ts\n\n## Errors (verbatim)\n- (none)\n\n## What failed and why\n- (none)\n\n## Constraints\n- Preserve behavior.\n\n## Next step\n- Run tests."
    return {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [
            Buffer.from(
                JSON.stringify({
                    id: "msg_02",
                    content: [{ type: "text", text: summary }],
                    usage: { input_tokens: 50, output_tokens: 40 },
                }),
            ),
        ],
    }
}

async function startFakeUpstream(): Promise<FakeUpstream> {
    const requests: Captured[] = []
    const upstream: FakeUpstream = {
        port: 0,
        requests,
        respond: defaultResponder,
        close: async () => {},
    }
    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => {
            const captured: Captured = {
                method: req.method ?? "",
                url: req.url ?? "",
                headers: req.headers,
                rawHeaders: req.rawHeaders,
                body: Buffer.concat(chunks),
            }
            requests.push(captured)
            const reply = upstream.respond(captured)
            res.writeHead(reply.status, reply.headers)
            let delay = 0
            for (const chunk of reply.chunks) {
                setTimeout(() => res.write(chunk), (delay += 2))
            }
            setTimeout(() => res.end(), delay + 2)
        })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    upstream.port = (server.address() as { port: number }).port
    upstream.close = () =>
        new Promise((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
        })
    return upstream
}

interface Harness {
    upstream: FakeUpstream
    proxyPort: number
    home: string
    close(): Promise<void>
}

const harnesses: Harness[] = []

async function startHarness(capture = false): Promise<Harness> {
    const upstream = await startFakeUpstream()
    const home = await mkdtemp(join(tmpdir(), "better-compact-"))
    const server = createProxyServer({
        upstream: `http://127.0.0.1:${upstream.port}`,
        openaiUpstream: `http://127.0.0.1:${upstream.port}`,
        profile: COMPACTION_PRESETS.light,
        plansDir: join(home, "plans"),
        transcriptsDir: join(home, "transcripts"),
        capturesDir: join(home, "captures"),
        debugDir: join(home, "debug"),
        capture,
        logger: silent,
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const proxyPort = (server.address() as { port: number }).port
    const harness: Harness = {
        upstream,
        proxyPort,
        home,
        close: async () => {
            await new Promise<void>((resolve) => {
                ;(server as Server).closeAllConnections()
                server.close(() => resolve())
            })
            await upstream.close()
            await rm(home, { recursive: true, force: true })
        },
    }
    harnesses.push(harness)
    return harness
}

after(async () => {
    for (const harness of harnesses) await harness.close()
})

function post(
    port: number,
    path: string,
    body: Buffer,
    headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                host: "127.0.0.1",
                port,
                path,
                method: "POST",
                headers: { ...headers, "content-length": body.length },
            },
            (res) => {
                const chunks: Buffer[] = []
                res.on("data", (chunk: Buffer) => chunks.push(chunk))
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                    }),
                )
            },
        )
        req.on("error", reject)
        req.end(body)
    })
}

const CLIENT_HEADERS = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-api-key": "sk-ant-test-key",
    authorization: "Bearer oauth-token-xyz",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "user-agent": "claude-cli/2.1.205 (external, cli)",
}

function streamRequests(upstream: FakeUpstream): Captured[] {
    return upstream.requests.filter((req) => {
        try {
            return (JSON.parse(req.body.toString("utf-8")) as { stream?: boolean }).stream === true
        } catch {
            return false
        }
    })
}

async function waitUntil(
    probe: () => Promise<boolean> | boolean,
    timeoutMs = 5_000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await probe()) return true
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
}

test("relays SSE byte-for-byte and forwards request headers verbatim", async () => {
    const harness = await startHarness()
    const body = Buffer.from(JSON.stringify(messagesBody([userMessage("hi")])))
    const response = await post(harness.proxyPort, "/anthropic/v1/messages", body, {
        ...CLIENT_HEADERS,
        "x-session": "s-small",
    })

    assert.equal(response.status, 200)
    assert.equal(
        response.body.toString("utf-8"),
        Buffer.concat(sseBytes(1_000, 12)).toString("utf-8"),
    )
    assert.equal(response.headers["content-type"], "text/event-stream")
    assert.equal(response.headers["x-upstream-mark"], "fake")

    const seen = harness.upstream.requests[0]
    assert.equal(seen.url, "/v1/messages")
    // Below the trigger nothing is rewritten: the upstream receives the
    // original bytes.
    assert.deepEqual(seen.body, body)
    for (const [name, value] of Object.entries(CLIENT_HEADERS)) {
        assert.equal(seen.headers[name], value, `header ${name} must arrive verbatim`)
    }
    assert.equal(seen.headers["x-session"], "s-small")
    assert.equal(seen.headers.host, `127.0.0.1:${harness.upstream.port}`)
})

test("manual sentinel forces a plan and is stripped from the latest user message", async () => {
    const harness = await startHarness()
    const messages: WireMessage[] = [
        userMessage("old request"),
        assistantMessage(`old reply ${"detail ".repeat(5_000)}`),
        userMessage("second-to-last request"),
        assistantMessage("recent reply"),
        userMessage([
            { type: "text", text: "keep this block" },
            { type: "text", text: "before [[better-compact:run]] after" },
        ]),
    ]

    const response = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody(messages))),
        { ...CLIENT_HEADERS, "x-session": "s-manual" },
    )

    assert.equal(response.status, 200)
    const seen = JSON.parse(streamRequests(harness.upstream)[0].body.toString("utf-8")) as {
        messages: WireMessage[]
    }
    assert.ok(
        seen.messages.some(
            (message) =>
                Array.isArray(message.content) &&
                message.content.some((block) =>
                    String(block.text ?? "").includes("Better Compact context pruning applied"),
                ),
        ),
        "manual trigger must force a plan below the automatic threshold",
    )
    assert.ok(!JSON.stringify(seen).includes("[[better-compact:run]]"))
    assert.ok(JSON.stringify(seen).includes("keep this block"))
    assert.ok(JSON.stringify(seen).includes("before  after"))
    const plan = JSON.parse(
        await readFile(join(harness.home, "plans", "s-manual.json"), "utf-8"),
    ) as PlanSnapshot
    assert.equal(plan.sessionId, "s-manual")
})

test("manual sentinel is stripped from replayed prompts without retriggering", () => {
    const messages: WireMessage[] = [
        userMessage([
            { type: "text", text: "[[better-compact:run]] replayed prompt" },
            { type: "text", text: "second [[better-compact:run]] marker" },
        ]),
        assistantMessage([toolUse("toolu_manual", "Read", { file_path: "/tmp/example" })]),
        userMessage([toolResult("toolu_manual", "contents")]),
    ]

    assert.deepEqual(stripAnthropicManualTrigger(messages, "[[better-compact:run]]"), {
        forced: false,
        stripped: true,
    })
    assert.ok(!JSON.stringify(messages).includes("[[better-compact:run]]"))
})

test("replayed manual sentinel is sanitized on an otherwise unchanged request", async () => {
    const harness = await startHarness()
    const messages: WireMessage[] = [
        userMessage("[[better-compact:run]] replayed prompt"),
        assistantMessage([toolUse("toolu_replay", "Read", { file_path: "/tmp/example" })]),
        userMessage([toolResult("toolu_replay", "contents")]),
    ]

    const response = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody(messages))),
        { ...CLIENT_HEADERS, "x-session": "s-replay" },
    )

    assert.equal(response.status, 200)
    const seen = JSON.parse(streamRequests(harness.upstream)[0].body.toString("utf-8"))
    assert.ok(!JSON.stringify(seen).includes("[[better-compact:run]]"))
    assert.ok(!JSON.stringify(seen).includes("Better Compact context pruning applied"))
})

test("drops content-encoding when the body is rewritten, keeps it verbatim otherwise", async () => {
    const harness = await startHarness()

    // Rewritten (pruned) request: the fresh plaintext body must not carry the
    // client's content-encoding, or the upstream would try to decompress it.
    await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        gzipSync(Buffer.from(JSON.stringify(messagesBody(bigConversation())))),
        { ...CLIENT_HEADERS, "x-session": "s-enc-pruned", "content-encoding": "gzip" },
    )
    const prunedSeen = streamRequests(harness.upstream).at(-1)
    assert.ok(prunedSeen)
    const prunedBody = JSON.parse(prunedSeen.body.toString("utf-8")) as { messages: WireMessage[] }
    assert.ok(
        prunedBody.messages.length < bigConversation().length,
        "request must have been rewritten",
    )
    assert.equal(
        prunedSeen.headers["content-encoding"],
        undefined,
        "rewritten body must not forward content-encoding",
    )

    // Below the trigger nothing is rewritten: content-encoding rides along.
    harness.upstream.requests.length = 0
    const unchanged = gzipSync(Buffer.from(JSON.stringify(messagesBody([userMessage("hi")]))))
    await post(harness.proxyPort, "/anthropic/v1/messages", unchanged, {
        ...CLIENT_HEADERS,
        "x-session": "s-enc-plain",
        "content-encoding": "gzip",
    })
    assert.deepEqual(harness.upstream.requests[0].body, unchanged)
    assert.equal(harness.upstream.requests[0].headers["content-encoding"], "gzip")
})

test("prunes past the trigger, reuses the plan across requests, and never touches system", async () => {
    const harness = await startHarness()
    const messages = bigConversation()
    const body = messagesBody(messages)
    const sentSystem = JSON.stringify(body.system)

    const first = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(body)),
        {
            ...CLIENT_HEADERS,
            "x-session": "s-big",
        },
    )
    assert.equal(first.status, 200)

    const firstSeen = JSON.parse(streamRequests(harness.upstream)[0].body.toString("utf-8")) as {
        system: unknown
        messages: WireMessage[]
        model: string
        metadata: unknown
    }
    assert.ok(firstSeen.messages.length < messages.length, "prefix must shrink")
    assert.equal(JSON.stringify(firstSeen.system), sentSystem)
    assert.equal(firstSeen.model, "claude-sonnet-4-5")
    assert.deepEqual(firstSeen.metadata, { user_id: "user_123" })
    assert.ok(
        firstSeen.messages.some(
            (message) =>
                Array.isArray(message.content) &&
                message.content.some((block) =>
                    String(block.text ?? "").includes("Better Compact context pruning applied"),
                ),
        ),
        "reference message must be injected",
    )

    const planFile = join(harness.home, "plans", "s-big.json")
    const planAfterFirst = JSON.parse(await readFile(planFile, "utf-8")) as PlanSnapshot
    assert.equal(planAfterFirst.sessionId, "s-big")
    const transcript = await readFile(planAfterFirst.transcriptRelativePath, "utf-8")
    assert.ok(transcript.includes("# Better Compact Raw Transcript"))

    // The conversation grows by one exchange; the cached plan replays.
    const grown = [
        ...messages,
        assistantMessage([toolUse("toolu_next", "Bash", { command: "true" })]),
        userMessage([toolResult("toolu_next", "done")]),
        userMessage("one more prompt"),
    ]
    const second = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody(grown))),
        { ...CLIENT_HEADERS, "x-session": "s-big" },
    )
    assert.equal(second.status, 200)
    const secondSeen = JSON.parse(streamRequests(harness.upstream)[1].body.toString("utf-8")) as {
        messages: WireMessage[]
    }
    assert.ok(secondSeen.messages.length < grown.length)
    const planAfterSecond = JSON.parse(await readFile(planFile, "utf-8")) as PlanSnapshot
    assert.equal(
        planAfterSecond.rangeHash,
        planAfterFirst.rangeHash,
        "replay must not rebuild the plan",
    )
    assert.equal(planAfterSecond.createdAt, planAfterFirst.createdAt)
})

test("count_tokens is pruned with the same plan so the client's context meter reflects reality", async () => {
    const harness = await startHarness()
    harness.upstream.respond = (req) =>
        req.url.startsWith("/v1/messages/count_tokens")
            ? {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  chunks: [Buffer.from(JSON.stringify({ input_tokens: 4242 }))],
              }
            : defaultResponder(req)

    const messages = bigConversation()
    const res = await post(
        harness.proxyPort,
        "/anthropic/v1/messages/count_tokens?beta=true",
        Buffer.from(JSON.stringify(messagesBody(messages))),
        { ...CLIENT_HEADERS, "x-session": "s-count" },
    )
    assert.equal(res.status, 200)
    // The provider's count of the pruned body relays back verbatim.
    assert.deepEqual(JSON.parse(res.body.toString("utf-8")), { input_tokens: 4242 })
    const seen = harness.upstream.requests.find((req) =>
        req.url.startsWith("/v1/messages/count_tokens"),
    )
    assert.ok(seen, "count_tokens reached upstream")
    const forwarded = JSON.parse(seen.body.toString("utf-8")) as {
        messages: WireMessage[]
        system: unknown
    }
    assert.ok(
        forwarded.messages.length < messages.length,
        "over the trigger, count_tokens must forward a pruned body",
    )
    assert.equal(JSON.stringify(forwarded.system), JSON.stringify(messagesBody(messages).system))

    // Below the trigger the count body forwards unchanged.
    harness.upstream.requests.length = 0
    const small = messagesBody([userMessage("hi")])
    await post(
        harness.proxyPort,
        "/anthropic/v1/messages/count_tokens",
        Buffer.from(JSON.stringify(small)),
        { ...CLIENT_HEADERS, "x-session": "s-count-small" },
    )
    const smallSeen = harness.upstream.requests.find((req) =>
        req.url.startsWith("/v1/messages/count_tokens"),
    )
    assert.ok(smallSeen)
    assert.deepEqual(
        (JSON.parse(smallSeen.body.toString("utf-8")) as { messages: WireMessage[] }).messages,
        small.messages,
    )
})

test("fails open: a body the codec cannot handle reaches upstream byte-identical", async () => {
    const harness = await startHarness()
    for (const raw of [
        JSON.stringify({ model: "m", stream: true, messages: 42 }),
        JSON.stringify({
            model: "m",
            stream: true,
            messages: [{ role: "system", content: "sneaky" }],
        }),
        "{not json at all",
    ]) {
        harness.upstream.requests.length = 0
        const body = Buffer.from(raw)
        const response = await post(
            harness.proxyPort,
            "/anthropic/v1/messages",
            body,
            CLIENT_HEADERS,
        )
        assert.equal(response.status, 200)
        assert.deepEqual(
            harness.upstream.requests[0].body,
            body,
            `must forward original bytes for: ${raw.slice(0, 30)}`,
        )
    }
})

test("serves concurrent sessions independently", async () => {
    const harness = await startHarness()
    const [a, b] = await Promise.all([
        post(
            harness.proxyPort,
            "/anthropic/v1/messages",
            Buffer.from(JSON.stringify(messagesBody(bigConversation()))),
            {
                ...CLIENT_HEADERS,
                "x-session": "s-alpha",
            },
        ),
        post(
            harness.proxyPort,
            "/anthropic/v1/messages",
            Buffer.from(JSON.stringify(messagesBody(bigConversation(11)))),
            {
                ...CLIENT_HEADERS,
                "x-session": "s-beta",
            },
        ),
    ])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    const plans = await readdir(join(harness.home, "plans"))
    assert.deepEqual(plans.sort(), ["s-alpha.json", "s-beta.json"])
})

test("dumps the rewritten body when upstream rejects it with a 4xx", async () => {
    const harness = await startHarness()
    const errorBody = JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "boom" },
    })
    harness.upstream.respond = () => ({
        status: 400,
        headers: { "content-type": "application/json" },
        chunks: [Buffer.from(errorBody)],
    })
    const response = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody(bigConversation()))),
        { ...CLIENT_HEADERS, "x-session": "s-reject" },
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.toString("utf-8"), errorBody)
    // The dump is written fire-and-forget; wait until it exists AND parses
    // (a partially flushed file is valid to observe mid-write).
    let dumped: { messages: WireMessage[] } | null = null
    assert.ok(
        await waitUntil(async () => {
            const dumps = await readdir(join(harness.home, "debug")).catch(() => [])
            if (dumps.length === 0) return false
            try {
                dumped = JSON.parse(
                    await readFile(join(harness.home, "debug", dumps[0]), "utf-8"),
                ) as { messages: WireMessage[] }
                return true
            } catch {
                return false
            }
        }),
    )
    assert.ok(dumped!.messages.length < bigConversation().length)
})

test("an overflow forces one fresh compaction and retries through the normal forward path", async () => {
    const harness = await startHarness()
    const overflow = JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long" },
    })
    harness.upstream.respond = (req) =>
        harness.upstream.requests.length === 1
            ? {
                  status: 400,
                  headers: { "content-type": "application/json", "x-overflow": "original" },
                  chunks: [Buffer.from(overflow)],
              }
            : defaultResponder(req)
    const messages: WireMessage[] = [
        userMessage("old request"),
        assistantMessage(`old reply ${"detail ".repeat(5_000)}`),
        userMessage("second request"),
        assistantMessage("recent reply"),
        userMessage("latest request"),
    ]
    const body = Buffer.from(JSON.stringify(messagesBody(messages)))

    const response = await post(harness.proxyPort, "/anthropic/v1/messages", body, {
        ...CLIENT_HEADERS,
        "x-session": "s-overflow-retry",
    })

    assert.equal(response.status, 200)
    assert.equal(harness.upstream.requests.length, 2)
    assert.deepEqual(harness.upstream.requests[0].body, body)
    assert.equal(harness.upstream.requests[1].headers.authorization, CLIENT_HEADERS.authorization)
    assert.equal(harness.upstream.requests[1].headers.accept, CLIENT_HEADERS.accept)
    const retried = JSON.parse(harness.upstream.requests[1].body.toString("utf-8")) as {
        messages: WireMessage[]
    }
    assert.notDeepEqual(retried.messages, messages)
    assert.ok(harness.upstream.requests[1].body.length < body.length)
    const retriedText = JSON.stringify(retried)
    assert.ok(retriedText.split("detail ").length - 1 < 5_000)
    assert.ok(retriedText.includes("latest request"))
})

test("a second overflow forwards the original provider response unchanged", async () => {
    const harness = await startHarness()
    const firstError = Buffer.from(
        JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "Prompt is too long" },
            request_id: "req_original",
        }),
    )
    const secondError = Buffer.from(
        JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "Input is too large" },
            request_id: "req_retry",
        }),
    )
    harness.upstream.respond = () => ({
        status: 400,
        headers: {
            "content-type": "application/json",
            "x-error-source": harness.upstream.requests.length === 1 ? "original" : "retry",
        },
        chunks: [harness.upstream.requests.length === 1 ? firstError : secondError],
    })
    const messages: WireMessage[] = [
        userMessage("old request"),
        assistantMessage(`old reply ${"detail ".repeat(5_000)}`),
        userMessage("second request"),
        assistantMessage("recent reply"),
        userMessage("latest request"),
    ]

    const response = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody(messages))),
        { ...CLIENT_HEADERS, "x-session": "s-overflow-twice" },
    )

    assert.equal(harness.upstream.requests.length, 2)
    assert.equal(response.status, 400)
    assert.equal(response.headers["x-error-source"], "original")
    assert.deepEqual(response.body, firstError)
})

test("a non-overflow 400 passes through without retry", async () => {
    const harness = await startHarness()
    const error = Buffer.from(
        JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "The model field is required." },
        }),
    )
    harness.upstream.respond = () => ({
        status: 400,
        headers: { "content-type": "application/json", "x-error-source": "upstream" },
        chunks: [error],
    })

    const response = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody([userMessage("hi")]))),
        { ...CLIENT_HEADERS, "x-session": "s-non-overflow" },
    )

    assert.equal(harness.upstream.requests.length, 1)
    assert.equal(response.status, 400)
    assert.equal(response.headers["x-error-source"], "upstream")
    assert.deepEqual(response.body, error)
})

test("an overflow is returned without retry when no prefix can be pruned", async () => {
    const harness = await startHarness()
    const error = Buffer.from(
        JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "Prompt is too long" },
        }),
    )
    harness.upstream.respond = () => ({
        status: 400,
        headers: { "content-type": "application/json", "x-error-source": "original" },
        chunks: [error],
    })

    const response = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody([userMessage("only request")]))),
        { ...CLIENT_HEADERS, "x-session": "s-overflow-no-prefix" },
    )

    assert.equal(harness.upstream.requests.length, 1)
    assert.equal(response.status, 400)
    assert.equal(response.headers["x-error-source"], "original")
    assert.deepEqual(response.body, error)
})

test("feeds relayed usage into the next request's trigger accounting", async () => {
    const harness = await startHarness()
    harness.upstream.respond = (req) => {
        const body = JSON.parse(req.body.toString("utf-8")) as { stream?: boolean }
        return body.stream
            ? {
                  status: 200,
                  headers: { "content-type": "text/event-stream" },
                  chunks: sseBytes(185_000, 500),
              }
            : defaultResponder(req)
    }
    const small = [
        userMessage("first"),
        assistantMessage([{ type: "text", text: "reply one" }]),
        userMessage("second"),
        assistantMessage([{ type: "text", text: "reply two" }]),
        userMessage("third"),
    ]
    const first = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody(small))),
        {
            ...CLIENT_HEADERS,
            "x-session": "s-usage",
        },
    )
    assert.equal(first.status, 200)
    assert.deepEqual(
        JSON.parse(streamRequests(harness.upstream)[0].body.toString("utf-8")).messages,
        small,
    )

    // The provider said 185k+ tokens; the raw estimate alone would never
    // trigger on this tiny history.
    const grown = [
        ...small,
        assistantMessage([{ type: "text", text: "reply three" }]),
        userMessage("fourth"),
    ]
    const second = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        Buffer.from(JSON.stringify(messagesBody(grown))),
        { ...CLIENT_HEADERS, "x-session": "s-usage" },
    )
    assert.equal(second.status, 200)
    const secondSeen = JSON.parse(streamRequests(harness.upstream)[1].body.toString("utf-8")) as {
        messages: WireMessage[]
    }
    assert.notDeepEqual(secondSeen.messages, grown, "provider-reported usage must drive a prune")
})

test("summary side-calls reuse the request credentials and upgrade the plan", async () => {
    const harness = await startHarness()
    const respond = harness.upstream.respond
    harness.upstream.respond = (request) => {
        const response = respond(request)
        const body = JSON.parse(request.body.toString("utf-8")) as { stream?: boolean }
        if (body.stream || request.headers["accept-encoding"] !== "gzip") return response
        return {
            ...response,
            headers: { ...response.headers, "content-encoding": "gzip" },
            chunks: [gzipSync(Buffer.concat(response.chunks))],
        }
    }
    // Assistant-text-heavy history: tool pruning cannot reach the target, so
    // runs are selected for summarization.
    const messages: WireMessage[] = []
    for (let index = 0; index < 8; index++) {
        messages.push(userMessage(`chapter ${index}`))
        messages.push(
            assistantMessage([{ type: "text", text: `analysis ${index} `.repeat(9_000) }]),
        )
    }
    messages.push(userMessage("penultimate prompt"))
    messages.push(assistantMessage([{ type: "text", text: "tail reply" }]))
    messages.push(userMessage("final prompt"))

    const response = await post(
        harness.proxyPort,
        "/anthropic/v1/messages",
        gzipSync(Buffer.from(JSON.stringify(messagesBody(messages)))),
        {
            ...CLIENT_HEADERS,
            "Accept-Encoding": "gzip",
            "Content-Encoding": "gzip",
            "x-session": "s-summ",
        },
    )
    assert.equal(response.status, 200)

    const planFile = join(harness.home, "plans", "s-summ.json")
    assert.ok(
        await waitUntil(async () => {
            try {
                const plan = JSON.parse(await readFile(planFile, "utf-8")) as PlanSnapshot
                return Object.keys(plan.assistantSummaries ?? {}).length > 0
            } catch {
                return false
            }
        }),
        "plan must be upgraded with assistant summaries",
    )
    const summaryCall = harness.upstream.requests.find((req) => {
        try {
            const body = JSON.parse(req.body.toString("utf-8")) as {
                stream?: boolean
                messages?: unknown
            }
            return body.stream === undefined && Array.isArray(body.messages)
        } catch {
            return false
        }
    })
    assert.ok(summaryCall, "summarizer must call upstream")
    assert.equal(summaryCall.url, "/v1/messages")
    assert.equal(summaryCall.headers.authorization, CLIENT_HEADERS.authorization)
    assert.equal(summaryCall.headers["x-api-key"], CLIENT_HEADERS["x-api-key"])
    assert.equal(summaryCall.headers["anthropic-beta"], CLIENT_HEADERS["anthropic-beta"])
    assert.equal(summaryCall.headers["accept-encoding"], "identity")
    assert.equal(summaryCall.headers["content-encoding"], undefined)
    const summaryBody = JSON.parse(summaryCall.body.toString("utf-8")) as {
        model: string
        max_tokens: number
        messages: Array<{ content: Array<{ text: string }> }>
    }
    assert.equal(summaryBody.model, "claude-sonnet-4-5")
    assert.ok(summaryBody.max_tokens <= 4_096)
    assert.ok(
        summaryBody.messages[0].content[0].text.includes(
            "Summarize this historical assistant turn",
        ),
    )
})

test("captures sanitized request bodies when --capture is on", async () => {
    const harness = await startHarness(true)
    const body = Buffer.from(JSON.stringify(messagesBody([userMessage("hello capture")])))
    await post(harness.proxyPort, "/anthropic/v1/messages", body, {
        ...CLIENT_HEADERS,
        "x-session": "s-cap",
    })
    assert.ok(
        await waitUntil(
            async () => (await readdir(join(harness.home, "captures")).catch(() => [])).length > 0,
        ),
    )
    const captures = await readdir(join(harness.home, "captures"))
    const captured = await readFile(join(harness.home, "captures", captures[0]))
    assert.deepEqual(captured, body)
    assert.ok(
        !captured.toString("utf-8").includes("sk-ant-test-key"),
        "captures must never contain credentials",
    )
})

test("passes other /anthropic paths through untouched", async () => {
    const harness = await startHarness()
    harness.upstream.respond = () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [Buffer.from(JSON.stringify({ input_tokens: 42 }))],
    })
    const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }))
    const response = await post(
        harness.proxyPort,
        "/anthropic/v1/messages/count_tokens",
        body,
        CLIENT_HEADERS,
    )
    assert.equal(response.status, 200)
    assert.equal(response.body.toString("utf-8"), JSON.stringify({ input_tokens: 42 }))
    const seen = harness.upstream.requests[0]
    assert.equal(seen.url, "/v1/messages/count_tokens")
    assert.deepEqual(seen.body, body)
})

test("unknown routes 404 with the Anthropic error envelope", async () => {
    const harness = await startHarness()
    const response = await post(harness.proxyPort, "/nope", Buffer.from("{}"), CLIENT_HEADERS)
    assert.equal(response.status, 404)
    assert.deepEqual(JSON.parse(response.body.toString("utf-8")), {
        type: "error",
        error: { type: "not_found_error", message: "unknown route" },
    })
})

test("health check distinguishes ours, foreign, and down", async () => {
    const harness = await startHarness()
    assert.equal((await checkHealth(harness.proxyPort)).kind, "ours")
    assert.equal((await checkHealth(harness.upstream.port)).kind, "foreign")
    const idle = createServer(() => {})
    await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve))
    const idlePort = (idle.address() as { port: number }).port
    await new Promise<void>((resolve) => idle.close(() => resolve()))
    assert.equal((await checkHealth(idlePort)).kind, "down")
})
