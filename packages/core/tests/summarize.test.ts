import assert from "node:assert/strict"
import test from "node:test"
import { summarizeJobs, type BoundarySummaryJob, type Logger } from "@better-compact/core"

const job: BoundarySummaryJob = {
    key: "assistant-run",
    rangeStartMessageId: "msg-assistant-1",
    rangeEndMessageId: "msg-assistant-2",
    transcriptRelativePath: "transcripts/session/range.md",
    prompt: "Summarize the run.",
}

function logger(warnings: unknown[]): Logger {
    return {
        info() {},
        debug() {},
        warn(_message, data) {
            warnings.push(data)
        },
        error() {},
    }
}

test("summarizeJobs rejects prose without the required sections", async () => {
    const warnings: unknown[] = []
    const summaries = await summarizeJobs({
        jobs: [job],
        summarizer: {
            complete: async () =>
                "Investigated the modules, ran the tests, and confirmed the implementation is ready for replay with all important details preserved.",
        },
        logger: logger(warnings),
    })

    assert.deepEqual(summaries, {})
    assert.equal(warnings.length, 1)
})

test("summarizeJobs accepts a structured failure-preserving summary", async () => {
    const summary = [
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
    const summaries = await summarizeJobs({
        jobs: [job],
        summarizer: { complete: async () => `\n${summary}\n` },
        logger: logger([]),
    })

    assert.equal(summaries[job.key], summary)
})
