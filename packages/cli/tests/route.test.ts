import assert from "node:assert/strict"
import test from "node:test"
import { resolveOpenAIContextLimit } from "../src/openai/route"
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

test("resolves documented GPT-5 family context windows", () => {
    assert.equal(resolveOpenAIContextLimit("gpt-5-codex"), 400_000)
    assert.equal(resolveOpenAIContextLimit("gpt-5.4-mini-2026-03-17"), 400_000)
    assert.equal(resolveOpenAIContextLimit("gpt-5.4-2026-03-05"), 1_050_000)
    assert.equal(resolveOpenAIContextLimit("gpt-5.2-chat-latest"), 128_000)
})

test("unknown OpenAI models use the smallest plausible window", () => {
    assert.equal(resolveOpenAIContextLimit("gpt-5.7-future"), 128_000)
    assert.equal(resolveOpenAIContextLimit("custom-gateway-model"), 128_000)
})

test("an explicit OpenAI context limit overrides model resolution", () => {
    assert.equal(resolveOpenAIContextLimit("gpt-5.4", 640_000), 640_000)
})
