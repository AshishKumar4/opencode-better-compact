export function formatDuration(ms: number): string {
    const safeMs = Math.max(0, Math.round(ms))
    if (safeMs < 1000) return `${safeMs} ms`

    const totalSeconds = safeMs / 1000
    if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`

    const wholeSeconds = Math.floor(totalSeconds)
    const hours = Math.floor(wholeSeconds / 3600)
    const minutes = Math.floor((wholeSeconds % 3600) / 60)
    const seconds = wholeSeconds % 60
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
    return `${minutes}m ${seconds}s`
}

export function pct(value: number, total: number): string {
    if (total <= 0) return "0.0%"
    return `${((value / total) * 100).toFixed(1)}%`
}
