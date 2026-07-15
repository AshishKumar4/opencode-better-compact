import assert from "node:assert/strict"
import test from "node:test"
import { assistantRunKey } from "../src/identity"
import type { Item, Turn } from "../src/ir"

function assistantTurn(key: string, items: Item[], fragmentKey?: string): Turn {
    return { key, stamp: 0, role: "assistant", items, fragmentKey }
}

function textItem(key: string, text: string): Item {
    return { kind: "text", key, text, handle: {} }
}

function toolItem(key: string, callId: string): Item {
    return { kind: "tool", key, callId, handle: {} }
}

test("stamp-less single-turn assistant runs use text content in their keys", () => {
    const first = [assistantTurn("wire-turn-a", [textItem("wire-item-a", "First answer")])]
    const second = [assistantTurn("wire-turn-b", [textItem("wire-item-b", "Second answer")])]

    assert.notEqual(assistantRunKey(first), assistantRunKey(second))
})

test("stamp-less tool-only assistant runs use call ids in their keys", () => {
    const first = [assistantTurn("wire-turn-a", [toolItem("wire-item-a", "call_a")])]
    const second = [assistantTurn("wire-turn-b", [toolItem("wire-item-b", "call_b")])]

    assert.notEqual(assistantRunKey(first), assistantRunKey(second))
})

test("assistant run keys survive forked turn and item identities", () => {
    const source = [
        assistantTurn(
            "source-turn",
            [textItem("source-text", "Shared answer"), toolItem("source-tool", "call_shared")],
            "fragment-1",
        ),
    ]
    const fork = [
        assistantTurn(
            "fork-turn",
            [textItem("fork-text", "Shared answer"), toolItem("fork-tool", "call_shared")],
            "fragment-1",
        ),
    ]

    assert.equal(assistantRunKey(source), assistantRunKey(fork))
})

test("assistant run keys are deterministic", () => {
    const turns = [assistantTurn("wire-turn", [textItem("wire-item", "Stable answer")])]

    assert.equal(assistantRunKey(turns), assistantRunKey(turns))
})
