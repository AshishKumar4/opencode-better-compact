import assert from "node:assert/strict"
import test from "node:test"
import { errorEnvelope } from "../src/route"

test("Anthropic errors wrap the error object under a type discriminator", () => {
    assert.deepEqual(errorEnvelope("anthropic", "api_error", "boom"), {
        type: "error",
        error: { type: "api_error", message: "boom" },
    })
})

test("OpenAI errors are the bare error object", () => {
    assert.deepEqual(errorEnvelope("openai", "api_error", "boom"), {
        error: { type: "api_error", message: "boom" },
    })
})
