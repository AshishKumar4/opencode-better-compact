import { createHash } from "node:crypto"
import type { WithParts } from "../state"

export function boundaryRangeHash(messages: WithParts[]): string {
    const seed = JSON.stringify(
        messages.map((message) => ({
            info: withoutTransportFields(message.info, ["id", "sessionID", "parentID"]),
            parts: message.parts.map((part) =>
                withoutTransportFields(part, ["id", "messageID", "sessionID"]),
            ),
        })),
    )
    return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}

function withoutTransportFields(value: object, fields: string[]): Record<string, unknown> {
    const result = { ...value } as Record<string, unknown>
    for (const field of fields) delete result[field]
    return result
}
