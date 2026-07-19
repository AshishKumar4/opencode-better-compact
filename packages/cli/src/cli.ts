import { claudeCommand } from "./claude/command"
import { installClaudeCode } from "./install"

const HELP = `better-compact — on-disk context compaction for Claude Code

Usage:
  better-compact claude [sessionId] [flags]   Compact a Claude Code session on disk
  better-compact claude --run [claude args...] Launch Claude Code with auto-compaction
  better-compact install claude-code          Unwind a legacy proxy redirect, if present

better-compact claude prunes old tool output and reasoning from a session's
transcript in place, keeping every message, so it reopens under Claude Code's
context limit. Quit the session first. Flags:
  --resume        reopen the session afterward
  --aggressive    summarize old turns instead (drops them from view; last resort)
  --from-backup   restore each entry's original content from the backups, then compact
  --keep-tokens N recent-tail budget kept fully intact (default 25000)
better-compact claude --run wraps Claude Code so the /better-compact:compact
command compacts and reopens the session automatically on exit (no tmux).
Originals are backed up to ~/.better-compact/claude-backups/.`

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2)

    switch (command) {
        case "claude": {
            await claudeCommand(rest)
            return
        }
        case "install": {
            if (rest[0] !== "claude-code") {
                console.error("Valid targets: claude-code")
                process.exit(1)
            }
            let result
            try {
                result = installClaudeCode()
            } catch (error) {
                console.error(`Claude Code setup failed: ${(error as Error).message}`)
                process.exit(1)
            }
            console.log("Claude Code uses on-disk compaction; there is nothing to wire up.")
            if (result.removedBaseUrl || result.removedDisableAutoCompact) {
                console.log(`Cleaned up ${result.settingsPath}:`)
                if (result.removedBaseUrl) {
                    console.log(
                        result.restoredBaseUrl
                            ? `  - restored env.ANTHROPIC_BASE_URL to ${result.restoredBaseUrl}`
                            : "  - removed the legacy proxy env.ANTHROPIC_BASE_URL redirect",
                    )
                }
                if (result.removedDisableAutoCompact) {
                    console.log(
                        "  - removed env.DISABLE_AUTO_COMPACT (native auto-compaction restored)",
                    )
                }
            } else {
                console.log("No legacy proxy settings found; nothing to change.")
            }
            console.log("")
            console.log("To compact a session that hit the limit:")
            console.log("  1. quit the session")
            console.log("  2. better-compact claude <sessionId> --resume")
            console.log("Or launch via `better-compact claude --run` and use /better-compact:compact.")
            return
        }
        default: {
            console.log(HELP)
            if (command !== undefined && command !== "--help" && command !== "-h") process.exit(1)
        }
    }
}

void main()
