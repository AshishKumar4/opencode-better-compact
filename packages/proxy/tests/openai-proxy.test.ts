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
import { COMPACTION_PRESETS, type Logger, type PlanSnapshot } from "@better-compact/core"
import { createProxyServer } from "../src/server"
import type { ResponseItemWire } from "../src/openai/codec"
import {
    assistantMessage,
    bigConversation,
    functionCall,
    functionCallOutput,
    responsesBody,
    userMessage,
} from "./openai-fixtures"

const silent: Logger = { info() {}, debug() {}, warn() {}, error() {} }

interface Captured {
    method: string
    url: string
    headers: IncomingHttpHeaders
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

function sseBytes(totalTokens: number): Buffer[] {
    const events = [
        `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n`,
        `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n`,
        `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":${totalTokens - 12},"output_tokens":12,"total_tokens":${totalTokens}}}}\n\n`,
    ].join("")
    const raw = Buffer.from(events)
    const chunks: Buffer[] = []
    // Deliberately misaligned chunk boundaries: relay must not care.
    for (let offset = 0; offset < raw.length; offset += 41)
        chunks.push(raw.subarray(offset, offset + 41))
    return chunks
}

function isStreaming(req: Captured): boolean {
    try {
        return (JSON.parse(req.body.toString("utf-8")) as { stream?: boolean }).stream === true
    } catch {
        return false
    }
}

function defaultResponder(req: Captured): {
    status: number
    headers: Record<string, string>
    chunks: Buffer[]
} {
    if (isStreaming(req)) {
        return {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-upstream-mark": "codex" },
            chunks: sseBytes(1_000),
        }
    }
    const summary =
        "Summary: investigated the modules, ran the builds, confirmed the outputs. " +
        "Key decisions and file paths are preserved for replay."
    return {
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [
            Buffer.from(
                JSON.stringify({
                    id: "resp_2",
                    output: [
                        { type: "reasoning", summary: [] },
                        {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: summary }],
                        },
                    ],
                    usage: { input_tokens: 50, output_tokens: 40, total_tokens: 90 },
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
                body: Buffer.concat(chunks),
            }
            requests.push(captured)
            const reply = upstream.respond(captured)
            res.writeHead(reply.status, reply.headers)
            let delay = 0
            for (const chunk of reply.chunks) setTimeout(() => res.write(chunk), (delay += 2))
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

async function startHarness(): Promise<Harness> {
    const upstream = await startFakeUpstream()
    const home = await mkdtemp(join(tmpdir(), "better-compact-openai-"))
    const server = createProxyServer({
        upstream: `http://127.0.0.1:${upstream.port}`,
        openaiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
        profile: COMPACTION_PRESETS.light,
        plansDir: join(home, "plans"),
        transcriptsDir: join(home, "transcripts"),
        capturesDir: join(home, "captures"),
        debugDir: join(home, "debug"),
        capture: false,
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
    authorization: "Bearer sk-codex-test-key",
    "openai-beta": "responses=v1",
    "user-agent": "codex_cli_rs/0.0.0",
}

function streamRequests(upstream: FakeUpstream): Captured[] {
    return upstream.requests.filter(isStreaming)
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

test("relays Responses SSE byte-for-byte and forwards headers verbatim", async () => {
    const harness = await startHarness()
    const body = Buffer.from(JSON.stringify(responsesBody([userMessage("hi")])))
    const response = await post(harness.proxyPort, "/openai/responses", body, {
        ...CLIENT_HEADERS,
        "thread-id": "t-small",
    })

    assert.equal(response.status, 200)
    assert.equal(response.body.toString("utf-8"), Buffer.concat(sseBytes(1_000)).toString("utf-8"))
    assert.equal(response.headers["content-type"], "text/event-stream")
    assert.equal(response.headers["x-upstream-mark"], "codex")

    const seen = harness.upstream.requests[0]
    assert.equal(seen.url, "/v1/responses")
    // Below the trigger nothing is rewritten: upstream receives original bytes.
    assert.deepEqual(seen.body, body)
    for (const [name, value] of Object.entries(CLIENT_HEADERS)) {
        assert.equal(seen.headers[name], value, `header ${name} must arrive verbatim`)
    }
    assert.equal(seen.headers["thread-id"], "t-small")
    assert.equal(seen.headers.host, `127.0.0.1:${harness.upstream.port}`)
})

test("prunes past the trigger, reuses the plan, and never touches instructions", async () => {
    const harness = await startHarness()
    const input = bigConversation()
    const body = responsesBody(input)
    const sentInstructions = body.instructions

    const first = await post(
        harness.proxyPort,
        "/openai/responses",
        Buffer.from(JSON.stringify(body)),
        { ...CLIENT_HEADERS, "thread-id": "t-big" },
    )
    assert.equal(first.status, 200)

    const firstSeen = JSON.parse(streamRequests(harness.upstream)[0].body.toString("utf-8")) as {
        instructions: string
        input: ResponseItemWire[]
        model: string
        prompt_cache_key: string
    }
    assert.ok(firstSeen.input.length < input.length, "prefix must shrink")
    assert.equal(firstSeen.instructions, sentInstructions)
    assert.equal(firstSeen.model, "gpt-5-codex")
    assert.equal(firstSeen.prompt_cache_key, "thread_abc123")
    assert.ok(
        firstSeen.input.some(
            (item) =>
                item.type === "message" &&
                Array.isArray(item.content) &&
                (item.content as Array<{ text?: string }>).some((part) =>
                    String(part.text ?? "").includes("Better Compact context pruning applied"),
                ),
        ),
        "reference message must be injected",
    )

    const planFile = join(harness.home, "plans", "t-big.json")
    const planAfterFirst = JSON.parse(await readFile(planFile, "utf-8")) as PlanSnapshot
    assert.equal(planAfterFirst.sessionId, "t-big")
    const transcript = await readFile(planAfterFirst.transcriptRelativePath, "utf-8")
    assert.ok(transcript.includes("# Better Compact Raw Transcript"))

    // The conversation grows by one exchange; the cached plan replays.
    const grown = [
        ...input,
        assistantMessage("more work"),
        functionCall("call_next", "shell", { cmd: "true" }),
        functionCallOutput("call_next", "done"),
        userMessage("one more prompt"),
    ]
    const second = await post(
        harness.proxyPort,
        "/openai/responses",
        Buffer.from(JSON.stringify(responsesBody(grown))),
        { ...CLIENT_HEADERS, "thread-id": "t-big" },
    )
    assert.equal(second.status, 200)
    const secondSeen = JSON.parse(streamRequests(harness.upstream)[1].body.toString("utf-8")) as {
        input: ResponseItemWire[]
    }
    assert.ok(secondSeen.input.length < grown.length)
    const planAfterSecond = JSON.parse(await readFile(planFile, "utf-8")) as PlanSnapshot
    assert.equal(planAfterSecond.rangeHash, planAfterFirst.rangeHash, "replay must not rebuild")
    assert.equal(planAfterSecond.createdAt, planAfterFirst.createdAt)
})

test("no orphaned function_call_output survives a rewrite", async () => {
    const harness = await startHarness()
    const first = await post(
        harness.proxyPort,
        "/openai/responses",
        Buffer.from(JSON.stringify(responsesBody(bigConversation()))),
        { ...CLIENT_HEADERS, "thread-id": "t-valid" },
    )
    assert.equal(first.status, 200)
    const sent = JSON.parse(streamRequests(harness.upstream)[0].body.toString("utf-8")) as {
        input: ResponseItemWire[]
    }
    const calls = new Set<string>()
    for (const item of sent.input) {
        if (item.type === "function_call") calls.add(item.call_id as string)
        if (item.type === "function_call_output") {
            assert.ok(calls.has(item.call_id as string), `orphan output ${String(item.call_id)}`)
        }
    }
})

test("fails open: a body the codec cannot handle reaches upstream byte-identical", async () => {
    const harness = await startHarness()
    for (const raw of [
        JSON.stringify({ model: "m", stream: true, input: 42 }),
        JSON.stringify({ model: "m", stream: true }),
        "{not json at all",
    ]) {
        harness.upstream.requests.length = 0
        const body = Buffer.from(raw)
        const response = await post(harness.proxyPort, "/openai/responses", body, CLIENT_HEADERS)
        assert.equal(response.status, 200)
        assert.deepEqual(
            harness.upstream.requests[0].body,
            body,
            `must forward original bytes for: ${raw.slice(0, 30)}`,
        )
    }
})

test("correlation precedence: thread-id header, then prompt_cache_key, then first-item hash", async () => {
    const harness = await startHarness()
    // prompt_cache_key alone (no thread-id header) keys the plan.
    await post(
        harness.proxyPort,
        "/openai/responses",
        Buffer.from(
            JSON.stringify(responsesBody(bigConversation(), { prompt_cache_key: "pck-1" })),
        ),
        CLIENT_HEADERS,
    )
    // thread-id header wins over a different prompt_cache_key.
    await post(
        harness.proxyPort,
        "/openai/responses",
        Buffer.from(
            JSON.stringify(responsesBody(bigConversation(), { prompt_cache_key: "pck-2" })),
        ),
        { ...CLIENT_HEADERS, "thread-id": "hdr-wins" },
    )
    assert.ok(await waitUntil(async () => (await readdir(join(harness.home, "plans"))).length >= 2))
    const plans = await readdir(join(harness.home, "plans"))
    assert.ok(plans.includes("pck-1.json"), "prompt_cache_key keys the plan when no header")
    assert.ok(plans.includes("hdr-wins.json"), "thread-id header takes precedence")
    assert.ok(!plans.includes("pck-2.json"), "the header must beat prompt_cache_key")
})

test("feeds relayed response.completed usage into the next request's trigger", async () => {
    const harness = await startHarness()
    harness.upstream.respond = (req) =>
        isStreaming(req)
            ? {
                  status: 200,
                  headers: { "content-type": "text/event-stream" },
                  chunks: sseBytes(260_000),
              }
            : defaultResponder(req)

    const small = [
        userMessage("first"),
        assistantMessage("reply one"),
        userMessage("second"),
        assistantMessage("reply two"),
        userMessage("third"),
    ]
    const first = await post(
        harness.proxyPort,
        "/openai/responses",
        Buffer.from(JSON.stringify(responsesBody(small))),
        { ...CLIENT_HEADERS, "thread-id": "t-usage" },
    )
    assert.equal(first.status, 200)
    assert.deepEqual(
        JSON.parse(streamRequests(harness.upstream)[0].body.toString("utf-8")).input,
        small,
    )

    // The provider said 260k tokens; the raw estimate alone would never trigger.
    const grown = [...small, assistantMessage("reply three"), userMessage("fourth")]
    const second = await post(
        harness.proxyPort,
        "/openai/responses",
        Buffer.from(JSON.stringify(responsesBody(grown))),
        { ...CLIENT_HEADERS, "thread-id": "t-usage" },
    )
    assert.equal(second.status, 200)
    const secondSeen = JSON.parse(streamRequests(harness.upstream)[1].body.toString("utf-8")) as {
        input: ResponseItemWire[]
    }
    assert.notDeepEqual(secondSeen.input, grown, "provider-reported usage must drive a prune")
})

test("summary side-calls reuse the request credentials and upgrade the plan", async () => {
    const harness = await startHarness()
    // Assistant-text-heavy history with no tools: only run summarization can
    // reach the target, so summary jobs are scheduled.
    const input: ResponseItemWire[] = []
    for (let index = 0; index < 12; index++) {
        input.push(userMessage(`chapter ${index}`))
        input.push(assistantMessage(`analysis ${index} `.repeat(9_000)))
    }
    input.push(userMessage("penultimate prompt"))
    input.push(assistantMessage("tail reply"))
    input.push(userMessage("final prompt"))

    const response = await post(
        harness.proxyPort,
        "/openai/responses",
        Buffer.from(JSON.stringify(responsesBody(input))),
        { ...CLIENT_HEADERS, "thread-id": "t-summ" },
    )
    assert.equal(response.status, 200)

    const planFile = join(harness.home, "plans", "t-summ.json")
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
    const summaryCall = harness.upstream.requests.find(
        (req) => !isStreaming(req) && req.url === "/v1/responses",
    )
    assert.ok(summaryCall, "summarizer must call /responses")
    assert.equal(summaryCall.headers.authorization, CLIENT_HEADERS.authorization)
    const summaryBody = JSON.parse(summaryCall.body.toString("utf-8")) as {
        model: string
        max_output_tokens: number
        stream: boolean
        input: Array<{ content: Array<{ text: string }> }>
    }
    assert.equal(summaryBody.model, "gpt-5-codex")
    assert.equal(summaryBody.stream, false)
    assert.ok(summaryBody.max_output_tokens <= 4_096)
    assert.ok(
        summaryBody.input[0].content[0].text.includes("Summarize this historical assistant turn"),
    )
})

test("passes other /openai paths through untouched", async () => {
    const harness = await startHarness()
    harness.upstream.respond = () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        chunks: [Buffer.from(JSON.stringify({ data: [{ id: "gpt-5-codex" }] }))],
    })
    const body = Buffer.from(JSON.stringify({ probe: true }))
    const response = await post(harness.proxyPort, "/openai/models", body, CLIENT_HEADERS)
    assert.equal(response.status, 200)
    assert.equal(response.body.toString("utf-8"), JSON.stringify({ data: [{ id: "gpt-5-codex" }] }))
    const seen = harness.upstream.requests[0]
    assert.equal(seen.url, "/v1/models")
    assert.deepEqual(seen.body, body)
})
