import {
    type EnginePorts,
    type Logger,
    type PlanSnapshot,
    type TranscriptStore,
} from "@better-compact/core"
import type { PiMessage } from "../src/codec"
import { assistantMessage, toolResultMessage, userMessage } from "./fixtures"

export const quietLogger: Logger = { info() {}, debug() {}, warn() {}, error() {} }

export function memoryTranscripts(): TranscriptStore & { written: Map<string, string> } {
    const written = new Map<string, string>()
    return {
        written,
        citablePath: (sessionKey, rangeHash) => `/sessions/${sessionKey}/better-compact/${rangeHash}.md`,
        async write(path, content) {
            written.set(path, content)
            return { absolutePath: path }
        },
    }
}

export function memoryPorts(): EnginePorts & {
    written: Map<string, string>
    snapshots: Array<PlanSnapshot | null>
} {
    const transcripts = memoryTranscripts()
    const snapshots: Array<PlanSnapshot | null> = []
    return {
        written: transcripts.written,
        snapshots,
        transcripts,
        plans: {
            load: () => snapshots.at(-1) ?? null,
            save: (_sessionKey, snapshot) => {
                snapshots.push(snapshot)
            },
        },
        logger: quietLogger,
    }
}

// A pi-shaped session big enough to cross the 85% trigger of a small window:
// several tool-heavy assistant turns with thinking, then a short raw tail.
export function overTriggerConversation(): PiMessage[] {
    const messages: PiMessage[] = []
    let at = 1_000
    for (let round = 0; round < 6; round++) {
        messages.push(userMessage(`please do task ${round}`, at++))
        messages.push(
            assistantMessage(
                [
                    { type: "thinking", thinking: `thinking about task ${round} ${"t".repeat(1_400)}` },
                    { type: "text", text: `Working on task ${round}.` },
                    { type: "toolCall", id: `call_${round}`, name: "bash", arguments: { command: `run ${round}` } },
                ],
                { stopReason: "toolUse", timestamp: at++ },
            ),
        )
        messages.push(toolResultMessage(`call_${round}`, `output ${round} ${"o".repeat(4_800)}`, { timestamp: at++ }))
        messages.push(assistantMessage([{ type: "text", text: `Task ${round} done.` }], { timestamp: at++ }))
    }
    messages.push(userMessage("what is left?", at++))
    messages.push(assistantMessage([{ type: "text", text: "Nothing, all done." }], { timestamp: at++ }))
    messages.push(userMessage("great, wrap up", at++))
    return messages
}

