import assert from "node:assert/strict"
import test from "node:test"
import { resolvePiComplete } from "../src/summarizer"

test("pi complete transport uses the compat entrypoint when available", async () => {
    const compatComplete = () => "compat"
    let loadedLegacy = false

    const complete = await resolvePiComplete(
        async () => ({ complete: compatComplete }),
        async () => {
            loadedLegacy = true
            return {}
        },
    )

    assert.equal(complete, compatComplete)
    assert.equal(loadedLegacy, false)
})

test("pi complete transport falls back to the legacy root entrypoint", async () => {
    const compatError = new Error("compat entrypoint missing")
    const legacyComplete = () => "legacy"

    const complete = await resolvePiComplete(
        async () => {
            throw compatError
        },
        async () => ({ complete: legacyComplete }),
    )

    assert.equal(complete, legacyComplete)
})

test("pi complete transport reports both entrypoint failures", async () => {
    const compatError = new Error("compat entrypoint missing")
    const legacyError = new Error("legacy entrypoint missing")

    await assert.rejects(
        resolvePiComplete(
            async () => {
                throw compatError
            },
            async () => {
                throw legacyError
            },
        ),
        (error: unknown) => {
            assert.ok(error instanceof AggregateError)
            assert.deepEqual(error.errors, [compatError, legacyError])
            return true
        },
    )
})
