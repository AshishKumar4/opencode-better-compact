import { createHash } from "node:crypto"
import type { Turn } from "./ir"

// The seed is `key:stamp` per turn, byte-identical to the historical
// id+timestamp seed, so hashes, transcript paths, and synthetic ids
// survive the IR extraction unchanged. Id-less platforms (Phase 3/4)
// derive `key` as a content hash with an occurrence ordinal; that
// derivation is the codec's job and plugs in through Turn.key.
export function rangeHash(turns: Turn[]): string {
    const seed = turns.map((turn) => `${turn.key}:${turn.stamp}`).join("|")
    return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}

export function assistantRunKey(turns: Turn[]): string {
    return rangeHash(turns)
}

export function syntheticTextKey(turnKey: string, text: string): string {
    return `${turnKey}_better_compact_text_${createHash("sha1").update(text).digest("hex").slice(0, 8)}`
}
