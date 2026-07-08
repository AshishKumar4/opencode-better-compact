import assert from "node:assert/strict"
import test from "node:test"
import {
    compressDisabledByOpencode,
    resolveEffectiveCompressPermission,
} from "../lib/host-permissions"

test("wildcard deny disables compress", () => {
    assert.equal(compressDisabledByOpencode({ "*": "deny" }), true)
})

test("later explicit compress allow overrides wildcard deny", () => {
    assert.equal(
        compressDisabledByOpencode({
            "*": "deny",
            compress: "allow",
        }),
        false,
    )
})

test("agent wildcard deny disables compress even when global config allows it", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { question: "allow" },
                agents: {
                    fast: { "*": "deny", question: "allow" },
                },
            },
            "fast",
        ),
        "deny",
    )
})

test("agent explicit allow overrides global wildcard deny", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { "*": "deny" },
                agents: {
                    build: { compress: "allow" },
                },
            },
            "build",
        ),
        "allow",
    )
})

test("permission wildcards follow opencode-style matching", () => {
    assert.equal(compressDisabledByOpencode({ "c?mpress": "deny" }), true)
})

test("pattern-specific denies do not disable the whole tool", () => {
    assert.equal(
        compressDisabledByOpencode({
            compress: {
                "/tmp/*": "deny",
            },
        }),
        false,
    )
})

test("compress permission resolution works without Array.findLast", () => {
    const originalFindLast = Array.prototype.findLast

    try {
        delete (Array.prototype as Array<unknown> & { findLast?: unknown }).findLast

        assert.equal(
            compressDisabledByOpencode({
                "*": "deny",
                compress: "allow",
            }),
            false,
        )
    } finally {
        Array.prototype.findLast = originalFindLast
    }
})
