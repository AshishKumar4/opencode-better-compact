import assert from "node:assert/strict"
import test from "node:test"
import { COMPACTION_PRESETS } from "@better-compact/core"
import { daemonNeedsRestart, decideStop, type HealthState, type LockInfo } from "../src/daemon"
import type { ProxyConfig } from "../src/config"

const lock: LockInfo = { port: 42817, pid: 4242 }
const config: ProxyConfig = {
    anthropicUpstream: "https://api.anthropic.com",
    openaiUpstream: "https://chatgpt.com/backend-api/codex",
    profile: COMPACTION_PRESETS.moderate,
}

test("daemon restart follows configured upstream changes", () => {
    const current: HealthState = {
        kind: "ours",
        pid: 99,
        upstream: config.anthropicUpstream,
        openaiUpstream: config.openaiUpstream,
        capture: false,
    }
    assert.equal(daemonNeedsRestart(current, config), false)
    assert.equal(
        daemonNeedsRestart(current, { ...config, openaiUpstream: "https://api.openai.com/v1" }),
        true,
    )
    assert.equal(daemonNeedsRestart(current, config, true), true)
    assert.equal(daemonNeedsRestart({ ...current, capture: true }, config, true), false)
    assert.equal(daemonNeedsRestart({ kind: "down" }, config), false)
})

test("stop signals only the live daemon's own pid", () => {
    const health: HealthState = { kind: "ours", pid: 99, upstream: "", openaiUpstream: "", capture: false }
    // The pid comes from the live health check, never from the lockfile.
    assert.deepEqual(decideStop(health, lock), { action: "signal", pid: 99 })
    assert.deepEqual(decideStop(health, null), { action: "signal", pid: 99 })
})

test("stop clears a stale lock instead of killing a recycled pid when the port is down", () => {
    assert.deepEqual(decideStop({ kind: "down" }, lock), { action: "clear-stale" })
})

test("stop reports not-running with nothing to clear when down without a lockfile", () => {
    assert.deepEqual(decideStop({ kind: "down" }, null), { action: "none" })
})

test("stop never touches a foreign occupant, with or without a stale lock", () => {
    assert.deepEqual(decideStop({ kind: "foreign" }, lock), { action: "none" })
    assert.deepEqual(decideStop({ kind: "foreign" }, null), { action: "none" })
})
