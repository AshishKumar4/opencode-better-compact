export type ItemKey = string

// Items are views with handles: every item encoded from a native message
// carries its original native payload opaquely, and the codec re-emits
// untouched handles verbatim on decode. Only `synthetic` items (ladder
// output) have no handle; the codec renders them natively.
export type Item =
    | { kind: "text"; key: ItemKey; text: string; handle: unknown }
    | { kind: "reasoning"; key: ItemKey; handle: unknown }
    | { kind: "tool"; key: ItemKey; callId: string; handle: unknown }
    | { kind: "opaque"; key: ItemKey; handle: unknown }
    | { kind: "synthetic"; key: ItemKey; text: string }

export interface Turn {
    // Citable native identity (message id on platforms that have ids).
    key: ItemKey
    // Edit-sensitive revision that participates in rangeHash alongside the
    // key. OpenCode supplies the message creation timestamp; id-less
    // platforms will fold this into content-hash keys instead (Phase 3/4).
    stamp: number
    role: "user" | "assistant"
    items: Item[]
    // Plugin-injected notification turns (e.g. Better Compact's own ignored
    // report messages): they carry no user intent, so they neither count as
    // protected user turns for tail selection nor feed prefix summaries.
    ephemeral?: boolean
    // Original native message; absent on ladder-synthesized turns.
    handle?: unknown
}

// The Native-independent half of a codec: how this platform prices and
// renders turns. The ladder consumes only these operations.
export interface CodecOps {
    // Tokens for the turns exactly as this platform would serialize them
    // for a model request, on the platform's own estimation scale.
    estimateTurns(turns: Turn[]): number
    estimateItem(item: Extract<Item, { kind: "tool" }>): number
    // One transcript block for the item, rendering native payload detail.
    transcriptLine(item: Item): string
    // Optional whole-document override for the reference transcript. A codec
    // that can render its native payloads losslessly (e.g. raw JSON) should,
    // so the model can recover exact prior detail instead of a preview.
    transcriptDocument?(turns: Turn[]): string
}

export interface Codec<Native> extends CodecOps {
    encode(native: Native[]): Turn[]
    decode(turns: Turn[], native: Native[]): Native[]
}

// Platform semantics expressed as selectors the adapter supplies. A stage
// that needs a missing convention simply finds nothing to act on.
export interface Conventions {
    isSkillItem?(item: Item): boolean
    tool?(item: Extract<Item, { kind: "tool" }>): {
        name: string
        input: unknown
        error?: string
    }
    todo?: {
        isTodoItem(item: Item): boolean
        format(item: Item): string
    }
    // An extra line to preserve when an assistant run containing this item
    // is collapsed to a summary (OpenCode: patch parts).
    itemNote?(item: Item): string | null
}
