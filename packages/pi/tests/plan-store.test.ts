import assert from "node:assert/strict"
import test from "node:test"
import {
    createEngine,
    rangeHash,
    toPlanSnapshot,
    type PlanSnapshot,
    type Turn,
} from "@better-compact/core"
import type { SessionManager } from "@earendil-works/pi-coding-agent"
import { piCodec, piSpec } from "../src/codec"
import { createPlanStore, PLAN_ENTRY_TYPE } from "../src/plan-store"
import { memoryTranscripts, overTriggerConversation, quietLogger } from "./helpers"

type BranchReader = Pick<SessionManager, "getBranch" | "getSessionId">

// A fake session: appendEntry accumulates custom entries exactly as pi
// persists them, and getBranch replays them root -> leaf.
function fakeSession(sessionId: string) {
    const entries: Array<{ type: string; customType: string; data: unknown }> = []
    const session = {
        getSessionId: () => sessionId,
        getBranch: () => entries,
    } as unknown as BranchReader
    return {
        session,
        entries,
        appendEntry: (customType: string, data: unknown) => {
            entries.push({ type: "custom", customType, data })
        },
    }
}

function turns(prefixKey = "prefix-key"): Turn[] {
    return [
        {
            key: prefixKey,
            stamp: 0,
            role: "user",
            items: [{ kind: "text", key: `${prefixKey}-text`, text: "prefix", handle: null }],
        },
        {
            key: "turn-key",
            stamp: 0,
            role: "user",
            items: [{ kind: "text", key: "tail-text", text: "tail", handle: null }],
        },
    ]
}

function snapshotOf(sessionId: string): PlanSnapshot {
    return {
        sessionId,
        rangeHash: rangeHash(turns().slice(0, 1)),
        contextLimit: 6_000,
        rawTailStartMessageId: "turn-key",
        transcriptRelativePath: "/sessions/x/better-compact/abc123.md",
        beforeTokens: 5_000,
        afterPruneTokens: 1_500,
        triggerTokens: 5_100,
        targetTokens: 1_800,
        requiresCustomCompaction: false,
        createdAt: 1,
    }
}

test("plans persist through appendEntry and restore from the branch", () => {
    const { session, appendEntry, entries } = fakeSession("session-1")
    const store = createPlanStore(appendEntry)
    store.save("session-1", snapshotOf("session-1"))
    assert.equal(entries.length, 1)
    assert.equal(entries[0].customType, PLAN_ENTRY_TYPE)

    const restored = createPlanStore(appendEntry)
    restored.restore(session)
    restored.adopt("session-1", turns())
    assert.deepEqual(restored.load("session-1"), snapshotOf("session-1"))
})

test("the last plan entry on the branch wins and null clears", () => {
    const { session, appendEntry } = fakeSession("session-1")
    const store = createPlanStore(appendEntry)
    store.save("session-1", snapshotOf("session-1"))
    store.save("session-1", null)

    const restored = createPlanStore(appendEntry)
    restored.restore(session)
    restored.adopt("session-1", turns())
    assert.equal(restored.load("session-1"), null)
})

test("a fork rebases the restored plan onto the live session id", () => {
    const origin = fakeSession("session-origin")
    createPlanStore(origin.appendEntry).save("session-origin", snapshotOf("session-origin"))

    // A fork copies the branch entries into a new session file with a new id.
    const fork = fakeSession("session-fork")
    fork.entries.push(...origin.entries)
    const store = createPlanStore(fork.appendEntry)
    store.restore(fork.session)
    store.adopt("session-fork", turns())
    assert.equal((store.load("session-fork") as PlanSnapshot).sessionId, "session-fork")
})

test("a fork refuses a persisted plan whose compacted prefix diverged", () => {
    const origin = fakeSession("session-origin")
    createPlanStore(origin.appendEntry).save("session-origin", snapshotOf("session-origin"))

    const fork = fakeSession("session-fork")
    fork.entries.push(...origin.entries)
    const store = createPlanStore(fork.appendEntry)
    store.restore(fork.session)
    store.adopt("session-fork", turns("edited-prefix"))
    assert.equal(store.load("session-fork"), null)
})

test("a persisted plan survives restart and replays identically through the engine", async () => {
    const messages = overTriggerConversation()
    const { session, appendEntry } = fakeSession("session-1")

    const firstStore = createPlanStore(appendEntry)
    const first = await createEngine(piSpec, {
        transcripts: memoryTranscripts(),
        plans: firstStore,
        logger: quietLogger,
    }).process({ sessionKey: "session-1", turns: piCodec.encode(messages), contextLimit: 6_000 })
    assert.equal(first.outcome, "planned")
    if (first.outcome !== "planned") return

    // Restart: a fresh store reconstructs from the persisted entries.
    const restartedStore = createPlanStore(appendEntry)
    restartedStore.restore(session)
    restartedStore.adopt("session-1", piCodec.encode(messages))
    assert.deepEqual(
        { ...(restartedStore.load("session-1") as PlanSnapshot), createdAt: 0 },
        { ...toPlanSnapshot(first.plan), createdAt: 0 },
    )

    const replayed = await createEngine(piSpec, {
        transcripts: memoryTranscripts(),
        plans: restartedStore,
        logger: quietLogger,
    }).process({ sessionKey: "session-1", turns: piCodec.encode(messages), contextLimit: 6_000 })
    assert.equal(replayed.outcome, "replayed")
    if (replayed.outcome !== "replayed") return
    assert.deepEqual(
        piCodec.decode(replayed.turns, messages),
        piCodec.decode(first.turns, messages),
    )
})
