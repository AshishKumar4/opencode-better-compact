import type { CodecOps, Turn } from "./ir"
import type { BoundaryContextPlan } from "./plan"
import type { Logger, TranscriptStore } from "./ports"

export function formatTranscript(turns: Turn[], codec: CodecOps): string {
    const lines = ["# Better Compact Raw Transcript", ""]
    for (const turn of turns) {
        lines.push(`## ${turn.role.toUpperCase()} ${turn.key}`)
        lines.push(`created: ${turn.stamp}`)
        lines.push("")
        for (const item of turn.items) {
            lines.push(codec.transcriptLine(item))
        }
        lines.push("")
    }
    return lines.join("\n").trimEnd() + "\n"
}

export async function writeTranscript(
    plan: BoundaryContextPlan,
    deps: { transcripts: TranscriptStore; logger: Logger; codec: CodecOps },
): Promise<void> {
    const turns = plan.transcript.turns ?? []
    const content =
        plan.transcript.content ||
        (deps.codec.transcriptDocument ? deps.codec.transcriptDocument(turns) : formatTranscript(turns, deps.codec))
    const { absolutePath } = await deps.transcripts.write(plan.transcript.relativePath, content)
    plan.transcript.content = content
    plan.transcript.turns = undefined
    plan.transcript.absolutePath = absolutePath
    deps.logger.info("Wrote Better Compact transcript reference", {
        path: absolutePath,
        messages: plan.transcript.messageIds.length,
    })
}
