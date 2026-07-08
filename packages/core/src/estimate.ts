import type { CodecOps, Turn } from "./ir"

// Matches OpenCode's Token.estimate heuristic; the shared scale every
// platform estimate is expressed in.
export function countTokens(text: string): number {
    if (!text) return 0
    return Math.max(0, Math.round(text.length / 4))
}

// Provider totals include system prompt, tool schemas, and cache accounting
// the char-based estimate cannot see; the measured delta keeps every gate
// and stage number on the provider-equivalent scale.
export interface Estimator {
    overheadTokens: number
}

export function estimateTurns(turns: Turn[], codec: CodecOps, estimator: Estimator): number {
    return Math.max(0, Math.round(codec.estimateTurns(turns) + estimator.overheadTokens))
}

export function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text
    return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[...omitted]`
}
