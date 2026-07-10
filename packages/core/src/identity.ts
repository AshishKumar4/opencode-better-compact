import { createHash } from "node:crypto"
import type { Turn } from "./ir"

// The seed is `key:stamp` per turn, byte-identical to the historical
// id+timestamp seed, so hashes, transcript paths, and synthetic ids
// survive the IR extraction unchanged. Id-less platforms derive `key`
// via contentHashKey/keyDeduper below and plug in through Turn.key.
export function rangeHash(turns: Turn[]): string {
    const seed = turns.map((turn) => `${turn.key}:${turn.stamp}`).join("|")
    return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}

// Summary keys survive forks: forked sessions mint new message ids but copy
// roles and creation stamps, so a content-inherited plan can keep reusing
// its paid-for assistant summaries (ported from origin/master 173146f).
export function assistantRunKey(turns: Turn[]): string {
    const seed = turns.map((turn) => `${turn.role}:${turn.stamp}`).join("|")
    return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}

export function syntheticTextKey(turnKey: string, text: string): string {
    return `${turnKey}_better_compact_text_${createHash("sha1").update(text).digest("hex").slice(0, 8)}`
}

// Identity for platforms whose messages carry no ids (pi context events,
// Anthropic wire messages, Codex ResponseItems): a content hash over the
// native payload, stable across requests because transcripts are
// append-only. Codecs pass the payload with any request-volatile metadata
// (e.g. cache_control) already stripped.
export function contentHashKey(payload: unknown): string {
    return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16)
}

// Disambiguates identical payloads with an occurrence ordinal (`#2`, `#3`…),
// deterministic because encode walks messages in order.
export function keyDeduper(): (base: string) => string {
    const seen = new Map<string, number>()
    return (base) => {
        const count = (seen.get(base) ?? 0) + 1
        seen.set(base, count)
        return count === 1 ? base : `${base}#${count}`
    }
}

function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value && typeof value === "object") {
        const source = value as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key])
        return sorted
    }
    return value
}
