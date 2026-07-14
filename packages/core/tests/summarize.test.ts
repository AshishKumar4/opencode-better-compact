import assert from "node:assert/strict"
import test from "node:test"
import { createSummaryScheduler, type BoundarySummaryJob, type Logger } from "@better-compact/core"

const job: BoundarySummaryJob = {
    key: "assistant-run",
    rangeStartMessageId: "msg-assistant-1",
    rangeEndMessageId: "msg-assistant-2",
    transcriptRelativePath: "transcripts/session/range.md",
    prompt: "Summarize the run.",
}

const validSummary = [
    "## Decisions",
    "- Keep the canonical parser.",
    "",
    "## Files & Symbols",
    "- src/parser.ts:parseInput",
    "",
    "## Errors (verbatim)",
    "- EINVAL request_id=req_123",
    "",
    "## What failed and why",
    "- The legacy parser rejected the payload.",
    "",
    "## Constraints",
    "- Preserve call_456 exactly.",
    "",
    "## Next step",
    "- Run pnpm test.",
].join("\n")

function logger(warnings: Array<{ message: string; data: unknown }>): Logger {
    return {
        info() {},
        debug() {},
        warn(message, data) {
            warnings.push({ message, data })
        },
        error() {},
    }
}

test("summary scheduler rejects prose without the required sections", async () => {
    const warnings: Array<{ message: string; data: unknown }> = []
    const scheduler = createSummaryScheduler(logger(warnings))
    const summaries = await scheduler.summarize({
        sessionKey: "session-invalid",
        jobs: [job],
        summarizer: {
            complete: async () =>
                "Investigated the modules, ran the tests, and confirmed the implementation is ready for replay with all important details preserved.",
        },
    })

    assert.deepEqual(summaries, {})
    assert.equal(warnings.length, 1)
})

test("summary scheduler accepts a structured failure-preserving summary", async () => {
    const scheduler = createSummaryScheduler(logger([]))
    const summaries = await scheduler.summarize({
        sessionKey: "session-valid",
        jobs: [job],
        summarizer: { complete: async () => `\n${validSummary}\n` },
    })

    assert.equal(summaries[job.key], validSummary)
})

test("a thrown summarizer is contained and reported as a failed job", async () => {
    const warnings: Array<{ message: string; data: unknown }> = []
    const progress: boolean[] = []
    const scheduler = createSummaryScheduler(logger(warnings))

    const summaries = await scheduler.summarize({
        sessionKey: "session-throw",
        jobs: [job],
        summarizer: {
            complete: async () => {
                throw new Error("provider unavailable")
            },
        },
        onProgress: (event) => {
            progress.push(event.ok)
        },
    })

    assert.deepEqual(summaries, {})
    assert.deepEqual(progress, [false])
    assert.ok(warnings.some((entry) => entry.message === "Summary job failed"))
})

test("three consecutive failures open the session breaker until its window elapses", async () => {
    let now = 1_000
    let calls = 0
    const warnings: Array<{ message: string; data: unknown }> = []
    const scheduler = createSummaryScheduler(logger(warnings), { now: () => now })
    const failing = {
        complete: async () => {
            calls++
            return null
        },
    }

    for (let attempt = 0; attempt < 3; attempt++) {
        assert.deepEqual(
            await scheduler.summarize({
                sessionKey: "session-breaker",
                jobs: [job],
                summarizer: failing,
            }),
            {},
        )
    }
    await scheduler.summarize({
        sessionKey: "session-breaker",
        jobs: [job],
        summarizer: failing,
    })
    assert.equal(calls, 3)
    assert.ok(warnings.some((entry) => entry.message === "Summary circuit breaker opened"))

    const otherSession = await scheduler.summarize({
        sessionKey: "session-healthy",
        jobs: [job],
        summarizer: { complete: async () => validSummary },
    })
    assert.equal(otherSession[job.key], validSummary)

    now += 5 * 60_000
    const recovered = await scheduler.summarize({
        sessionKey: "session-breaker",
        jobs: [job],
        summarizer: {
            complete: async () => {
                calls++
                return validSummary
            },
        },
    })
    assert.equal(calls, 4)
    assert.equal(recovered[job.key], validSummary)
})

test("the breaker stops scheduling a failing batch after the threshold", async () => {
    let calls = 0
    const scheduler = createSummaryScheduler(logger([]))
    const jobs = Array.from({ length: 6 }, (_, index) => ({
        ...job,
        key: `assistant-run-${index}`,
        rangeStartMessageId: `msg-assistant-${index * 2}`,
        rangeEndMessageId: `msg-assistant-${index * 2 + 1}`,
    }))

    const summaries = await scheduler.summarize({
        sessionKey: "session-batch",
        jobs,
        concurrency: 1,
        summarizer: {
            complete: async () => {
                calls++
                return null
            },
        },
    })

    assert.deepEqual(summaries, {})
    assert.equal(calls, 3)
})

test("an interleaved success resets the consecutive failure count", async () => {
    let calls = 0
    const outcomes: Array<string | null> = [null, null, validSummary, null, null, null]
    const scheduler = createSummaryScheduler(logger([]))
    const summarizer = {
        complete: async () => {
            calls++
            return outcomes.shift() ?? null
        },
    }

    for (let attempt = 0; attempt < 6; attempt++) {
        await scheduler.summarize({
            sessionKey: "session-reset",
            jobs: [job],
            summarizer,
        })
    }
    await scheduler.summarize({
        sessionKey: "session-reset",
        jobs: [job],
        summarizer,
    })

    assert.equal(calls, 6)
})
