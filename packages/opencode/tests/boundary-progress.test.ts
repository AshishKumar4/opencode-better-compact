import assert from "node:assert/strict"
import test from "node:test"
import { createBoundaryJob, startBoundaryJob } from "../lib/boundary/progress"
import { createSessionState } from "../lib/state"

test("boundary job factory creates an immediately useful correlated snapshot", () => {
    const job = createBoundaryJob({
        id: "bc_test",
        sessionId: "session-1",
        startedAt: 123,
        counters: {
            beforeTokens: 854_367,
            currentTokens: 854_367,
            targetTokens: 95_200,
            contextLimit: 272_000,
            clearedTokens: 0,
            stageClearedTokens: 0,
        },
    })

    assert.equal(job.id, "bc_test")
    assert.equal(job.sessionId, "session-1")
    assert.equal(job.startedAt, 123)
    assert.equal(job.stages.length, 11)
    assert.equal(
        job.stages.every((stage) => stage.status === "pending"),
        true,
    )
    assert.equal(job.counters.contextLimit, 272_000)
    assert.equal(job.counters.beforeTokens, 854_367)
    assert.equal(job.counters.targetTokens, 95_200)
})

test("server job initialization preserves TUI correlation identity", () => {
    const state = createSessionState()
    const job = startBoundaryJob(state, {
        id: "bc_correlated",
        sessionId: "session-1",
        startedAt: 456,
    })

    assert.equal(state.boundary.job, job)
    assert.equal(job.id, "bc_correlated")
    assert.equal(job.startedAt, 456)
})
