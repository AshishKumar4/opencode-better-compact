export function formatTokenCount(tokens: number, compact?: boolean): string {
    const suffix = compact ? "" : " tokens"
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + suffix
    }
    return tokens.toString() + suffix
}
