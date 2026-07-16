import assert from "node:assert/strict"
import test from "node:test"
import { stubTranscript, summarizeTranscript } from "../src/claude/compact"
import { stripSessionArgs } from "../src/claude/command"
import { restoreFromBackups, resumeModelArgs, type TranscriptEntry } from "../src/claude/transcript"

let counter = 0
function uuid(): string {
    return `uuid-${++counter}`
}

const COMMON = { sessionId: "s1", cwd: "/proj", version: "2.1.207", gitBranch: "main" }

function userText(parent: string | null, text: string): TranscriptEntry {
    return { ...COMMON, type: "user", uuid: uuid(), parentUuid: parent, message: { role: "user", content: text } }
}

function assistantToolUse(parent: string, callId: string, thinking = true): TranscriptEntry {
    const content: unknown[] = []
    if (thinking) content.push({ type: "thinking", thinking: "pondering ".repeat(50), signature: "sig" })
    content.push({ type: "text", text: "Running a command." })
    content.push({ type: "tool_use", id: callId, name: "Bash", input: { command: "ls" } })
    return { ...COMMON, type: "assistant", uuid: uuid(), parentUuid: parent, message: { role: "assistant", content } }
}

function userToolResult(parent: string, callId: string, chars: number): TranscriptEntry {
    return {
        ...COMMON,
        type: "user",
        uuid: uuid(),
        parentUuid: parent,
        toolUseResult: { stdout: "x".repeat(chars) },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "x".repeat(chars) }] },
    }
}

// A conversation of `n` tool exchanges with a fresh user prompt before each,
// plus a trailing prompt — realistic user-turn density for tail anchoring.
function conversation(n: number, outputChars = 8000): TranscriptEntry[] {
    const entries: TranscriptEntry[] = []
    let parent: string | null = null
    for (let i = 0; i < n; i++) {
        const prompt = userText(parent, `request ${i}`)
        const callId = `toolu_${i}`
        const a = assistantToolUse(prompt.uuid!, callId)
        const r = userToolResult(a.uuid!, callId, outputChars)
        entries.push(prompt, a, r)
        parent = r.uuid!
    }
    entries.push(userText(parent, "latest question"))
    return entries
}

function chainIsIntact(entries: TranscriptEntry[]): boolean {
    const uuids = new Set(entries.map((e) => e.uuid))
    return entries.every((e) => e.parentUuid === null || e.parentUuid === undefined || uuids.has(e.parentUuid))
}

test("stub mode keeps every message, stubs old tool output, strips old reasoning", () => {
    const entries = conversation(12)
    const before = entries.length
    const uuidsBefore = entries.map((e) => e.uuid)

    const outcome = stubTranscript(entries, { keepTailTokens: 2000 })
    assert.ok(outcome, "should compact")
    // Every entry preserved; no entries added or removed.
    assert.equal(outcome.entries.length, before)
    assert.deepEqual(outcome.entries.map((e) => e.uuid), uuidsBefore)
    assert.ok(chainIsIntact(outcome.entries), "parentUuid chain intact")
    // Old tool output stubbed, old reasoning stripped, tokens shrank.
    assert.ok(outcome.stubbedTools > 0, "stubbed some tool output")
    assert.ok(outcome.strippedReasoning > 0, "stripped some reasoning")
    assert.ok(outcome.postTokens < outcome.preTokens)
    assert.equal(outcome.totalMessages, entries.filter((e) => e.type === "user" || e.type === "assistant").length)

    // A stubbed tool_result keeps its id but replaces the payload.
    const stubbed = outcome.entries.find(
        (e) =>
            Array.isArray(e.message?.content) &&
            (e.message!.content as { type?: string; content?: unknown }[]).some(
                (b) => b.type === "tool_result" && typeof b.content === "string" && b.content.includes("better-compact: pruned"),
            ),
    )
    assert.ok(stubbed, "a tool_result was stubbed in place")

    // No reasoning blocks remain in the pruned prefix; the newest turns are untouched.
    const last = outcome.entries.at(-1)!
    assert.equal((last.message!.content as string) || "latest question", "latest question")
})

test("stub mode prunes oversized old tool inputs, keeping the action record", () => {
    const entries: TranscriptEntry[] = []
    const start = userText(null, "write files")
    entries.push(start)
    let parent = start.uuid!
    for (let i = 0; i < 10; i++) {
        const callId = `toolu_w${i}`
        const write: TranscriptEntry = {
            ...COMMON,
            type: "assistant",
            uuid: uuid(),
            parentUuid: parent,
            message: {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: callId,
                        name: "Write",
                        input: { file_path: `/proj/file${i}.ts`, content: "code ".repeat(3000) },
                    },
                ],
            },
        }
        const result = userToolResult(write.uuid!, callId, 30)
        entries.push(write, result)
        parent = result.uuid!
    }
    entries.push(userText(parent, "done?"))

    const outcome = stubTranscript(entries, { keepTailTokens: 2000 })
    assert.ok(outcome, "should compact input-heavy session")
    assert.ok(outcome.stubbedTools > 0)
    assert.ok(outcome.postTokens < outcome.preTokens / 2, "input bulk removed")
    const stubbedWrite = outcome.entries.find(
        (e) =>
            Array.isArray(e.message?.content) &&
            (e.message!.content as { type?: string; input?: { pruned?: string; target?: string } }[]).some(
                (b) => b.type === "tool_use" && typeof b.input?.pruned === "string",
            ),
    )
    assert.ok(stubbedWrite, "an old tool_use input was stubbed")
    const block = (stubbedWrite!.message!.content as { type?: string; id?: string; name?: string; input?: { target?: string } }[]).find(
        (b) => b.type === "tool_use",
    )!
    assert.equal(block.name, "Write", "tool name kept")
    assert.ok(block.id, "call id kept")
    assert.match(block.input!.target!, /\/proj\/file\d+\.ts/, "primary target kept")
})

test("stub mode leaves a small session alone", () => {
    const outcome = stubTranscript(conversation(1, 50), { keepTailTokens: 25000 })
    assert.equal(outcome, null)
})

test("compaction zeros the stale usage anchor so Claude Code recounts content", () => {
    const entries = conversation(12)
    // Two real API usage records; Claude Code anchors its meter on the last.
    const assistants = entries.filter((e) => e.type === "assistant")
    const older = assistants[assistants.length - 2]!
    const last = assistants[assistants.length - 1]!
    older.message!.usage = { input_tokens: 100, cache_read_input_tokens: 500_000, output_tokens: 9 }
    last.message!.usage = {
        input_tokens: 200,
        cache_read_input_tokens: 700_000,
        output_tokens: 7,
        iterations: [{ input_tokens: 2, cache_read_input_tokens: 699_000, output_tokens: 7 }],
    }

    const outcome = stubTranscript(entries, { keepTailTokens: 2000 })
    assert.ok(outcome)
    const lastUsage = last.message!.usage as Record<string, number> & {
        iterations: Record<string, number>[]
    }
    assert.equal(lastUsage.input_tokens, 0)
    assert.equal(lastUsage.cache_read_input_tokens, 0)
    assert.equal(lastUsage.output_tokens, 7, "output side untouched")
    // Claude Code rebuilds usage from iterations at load; they must be zeroed
    // too or the anchor resurrects.
    assert.equal(lastUsage.iterations[0].cache_read_input_tokens, 0)
    assert.equal(lastUsage.iterations[0].input_tokens, 0)
    assert.equal(lastUsage.iterations[0].output_tokens, 7)
    // Every record is cleared: transcripts interleave branches from competing
    // instances, so any usage record can end up as Claude Code's chain anchor.
    const olderUsage = older.message!.usage as Record<string, number>
    assert.equal(olderUsage.cache_read_input_tokens, 0)
    assert.equal(olderUsage.output_tokens, 9, "output side untouched")
})

test("an already-pruned transcript with nothing new to stub still gets the usage reset", () => {
    const entries = conversation(12)
    const last = entries.filter((e) => e.type === "assistant").at(-1)!
    last.message!.usage = { input_tokens: 300, cache_read_input_tokens: 800_000, output_tokens: 3 }
    const first = stubTranscript(entries, { keepTailTokens: 2000 })
    assert.ok(first)
    // Simulate the pre-fix state an earlier CLI version left behind: top-level
    // zeroed but iterations still carrying the original numbers (the exact
    // resurrection case observed live).
    ;(last.message!.usage as Record<string, unknown>).iterations = [
        { input_tokens: 2, cache_read_input_tokens: 740_196, output_tokens: 5 },
    ]
    const second = stubTranscript(first.entries, { keepTailTokens: 2000 })
    assert.ok(second, "reset-only pass still proceeds")
    const usage = last.message!.usage as { iterations: Record<string, number>[] }
    assert.equal(usage.iterations[0].cache_read_input_tokens, 0)
    assert.equal(usage.iterations[0].input_tokens, 0)
})

test("stub mode preserves the most recent tool output verbatim", () => {
    const entries = conversation(12)
    const lastResult = [...entries].reverse().find((e) => e.toolUseResult)!
    const originalLen = (lastResult.message!.content as { content: string }[])[0].content.length
    stubTranscript(entries, { keepTailTokens: 4000 })
    const after = (lastResult.message!.content as { content: string }[])[0].content
    assert.equal(after.length, originalLen, "most recent tool result not stubbed")
})

test("aggressive mode appends a valid native compaction boundary + summary", () => {
    const entries = conversation(12)
    const outcome = summarizeTranscript(entries, { keepTailTokens: 3000 })
    assert.ok(outcome)
    assert.equal(outcome.entries.length, entries.length + 2)
    const summary = outcome.entries.at(-1)!
    const boundary = outcome.entries.at(-2)!
    assert.equal(boundary.subtype, "compact_boundary")
    assert.equal(boundary.parentUuid, null)
    assert.equal(summary.isCompactSummary, true)
    assert.equal(summary.parentUuid, boundary.uuid)
    const preserved = (boundary.compactMetadata as { preservedMessages: { uuids: string[] } }).preservedMessages.uuids
    assert.ok(preserved.length >= 1 && preserved.length < outcome.keptMessages + outcome.droppedMessages)
    assert.ok(outcome.droppedMessages > outcome.keptMessages, "aggressive drops most turns")
})

test("restoreFromBackups takes each entry's oldest version and keeps newer turns", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "bc-restore-"))
    try {
        const original = conversation(3)
        const afterFirstStub = original.map((e) => structuredClone(e))
        stubTranscript(afterFirstStub, { keepTailTokens: 500 })
        // Oldest backup = full history; newer backup = already pruned.
        const b1 = join(dir, "b1.bak")
        const b2 = join(dir, "b2.bak")
        await writeFile(b1, original.map((e) => JSON.stringify(e)).join("\n") + "\n")
        await writeFile(b2, afterFirstStub.map((e) => JSON.stringify(e)).join("\n") + "\n")
        // Current = pruned state + a turn added after both backups.
        const newTurn = userText(afterFirstStub.at(-1)!.uuid!, "added later")
        const current = [...afterFirstStub.map((e) => structuredClone(e)), newTurn]

        const restored = restoreFromBackups(current, [b1, b2])
        assert.equal(restored.length, current.length)
        assert.equal(restored.at(-1), newTurn, "post-backup turn preserved")
        // A stubbed tool_result got its original content back from the oldest backup.
        const anyStub = restored.some(
            (e) =>
                Array.isArray(e.message?.content) &&
                (e.message!.content as { content?: unknown }[]).some(
                    (b) => typeof b.content === "string" && b.content.startsWith("[better-compact: pruned"),
                ),
        )
        assert.equal(anyStub, false, "original content restored everywhere")
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test("a session merely mentioning the stub marker is not treated as previously pruned", () => {
    const entries = conversation(1, 50)
    entries.push(userText(entries.at(-1)!.uuid!, "docs say '[better-compact: pruned 123-char tool output]'"))
    assert.equal(stubTranscript(entries, { keepTailTokens: 25000 }), null)
})

test("an originally-empty content array stays empty, with no false marker", () => {
    const entries = conversation(8)
    const empty: TranscriptEntry = {
        ...COMMON,
        type: "assistant",
        uuid: uuid(),
        parentUuid: entries[0].uuid,
        message: { role: "assistant", content: [] },
    }
    entries.splice(2, 0, empty)
    const outcome = stubTranscript(entries, { keepTailTokens: 2000 })
    assert.ok(outcome)
    assert.deepEqual(empty.message!.content, [])
})

test("resumeModelArgs adds the [1m] variant only when the transcript proves it", () => {
    const entries = conversation(2)
    const assistants = entries.filter((e) => e.type === "assistant")
    for (const a of assistants) a.message!.model = "claude-opus-4-8"

    // Under 200k: no override — Claude Code's own restore is fine.
    assistants[0]!.message!.usage = { input_tokens: 1000, cache_read_input_tokens: 50_000 }
    assert.deepEqual(resumeModelArgs(entries), [])

    // Proven past 200k: resume must carry the long-context variant.
    assistants[1]!.message!.usage = { input_tokens: 2, cache_read_input_tokens: 602_000 }
    assert.deepEqual(resumeModelArgs(entries), ["--model", "claude-opus-4-8[1m]"])

    // Evidence may live only in iterations (post-reset top levels are zeroed
    // by compaction, but resumeModelArgs runs on the pre-reset parse anyway).
    assistants[1]!.message!.usage = {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [{ input_tokens: 2, cache_read_input_tokens: 700_000 }],
    }
    assert.deepEqual(resumeModelArgs(entries), ["--model", "claude-opus-4-8[1m]"])

    // Unknown model families are never suffixed.
    for (const a of assistants) a.message!.model = "some-gateway-model"
    assert.deepEqual(resumeModelArgs(entries), [])
})

test("stripSessionArgs removes session selection and keeps every other flag", () => {
    assert.deepEqual(
        stripSessionArgs(["--model", "opus", "--resume", "abc-123", "--dangerously-skip-permissions"]),
        ["--model", "opus", "--dangerously-skip-permissions"],
    )
    assert.deepEqual(stripSessionArgs(["-c", "--model", "opus"]), ["--model", "opus"])
    assert.deepEqual(stripSessionArgs(["--resume", "--model", "opus"]), ["--model", "opus"])
    assert.deepEqual(stripSessionArgs(["--session-id", "abc"]), [])
})

test("compaction only touches the conversation after the last boundary", () => {
    const first = conversation(6)
    // Simulate an earlier compaction: append a boundary, then more turns.
    const boundary: TranscriptEntry = {
        ...COMMON,
        type: "system",
        subtype: "compact_boundary",
        parentUuid: null,
        uuid: uuid(),
        compactMetadata: {},
    }
    const cont = conversation(8)
    const all = [...first, boundary, ...cont]
    const outcome = stubTranscript(all, { keepTailTokens: 2000 })
    assert.ok(outcome)
    // Only the post-boundary conversation counts.
    assert.equal(
        outcome.totalMessages,
        cont.filter((e) => e.type === "user" || e.type === "assistant").length,
    )
})
