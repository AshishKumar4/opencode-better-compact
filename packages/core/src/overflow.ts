const CONTEXT_OVERFLOW_SIGNALS = [
    "prompt is too long",
    "context length exceeded",
    "context_length_exceeded",
    "exceeds the context window",
    "maximum context length",
    "input is too large",
    "input tokens exceed the configured limit",
    "token limit exceeded",
    "token_limit_exceeded",
] as const

export function isContextOverflowError(status: number, body: unknown): boolean {
    if (status !== 400) return false
    const text = stringifyBody(body).toLowerCase()
    return CONTEXT_OVERFLOW_SIGNALS.some((signal) => text.includes(signal))
}

function stringifyBody(body: unknown): string {
    if (typeof body === "string") return body
    try {
        return JSON.stringify(body) ?? ""
    } catch {
        return ""
    }
}
