import assert from "node:assert/strict"
import test from "node:test"
import { isContextOverflowError } from "@better-compact/core"

test("recognizes provider context overflow errors", () => {
    const cases: Array<[number, unknown]> = [
        [
            400,
            {
                type: "error",
                error: {
                    type: "invalid_request_error",
                    message: "prompt is too long: 204986 tokens > 200000 maximum",
                },
            },
        ],
        [
            400,
            {
                error: {
                    message:
                        "Your input exceeds the context window of this model. Please adjust your input and try again.",
                    type: "invalid_request_error",
                    param: "input",
                    code: "context_length_exceeded",
                },
            },
        ],
        [400, { error: { message: "This model's maximum context length is 8192 tokens." } }],
        [400, { message: "Input is too large for the selected model." }],
        [400, { message: "Input tokens exceed the configured limit of 272000 tokens" }],
        [400, { error: { type: "token_limit_exceeded", message: "Token limit exceeded" } }],
    ]

    for (const [status, body] of cases) {
        assert.equal(isContextOverflowError(status, body), true, JSON.stringify(body))
    }
})

test("rejects unrelated client errors and overflow text on other statuses", () => {
    assert.equal(
        isContextOverflowError(400, {
            error: { type: "invalid_request_error", message: "The model field is required." },
        }),
        false,
    )
    assert.equal(isContextOverflowError(401, { error: { message: "Prompt is too long" } }), false)
    assert.equal(isContextOverflowError(429, { error: { message: "Token limit exceeded" } }), false)
    const circular: { self?: unknown } = {}
    circular.self = circular
    assert.equal(isContextOverflowError(400, circular), false)
})
