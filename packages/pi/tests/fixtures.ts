import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai"
import type { PiMessage } from "../src/codec"

export function usage(totalTokens = 0): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
}

export function userMessage(content: UserMessage["content"], timestamp = 1_000): UserMessage {
    return { role: "user", content, timestamp }
}

export function assistantMessage(
    content: AssistantMessage["content"],
    overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: usage(),
        stopReason: "stop",
        timestamp: 2_000,
        ...overrides,
    }
}

export function toolResultMessage(
    toolCallId: string,
    text: string,
    overrides: Partial<ToolResultMessage> = {},
): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 3_000,
        ...overrides,
    }
}

// A conversation exercising every AgentMessage kind pi documents, plus an
// unrecognized future role and vendor-extension junk fields.
export function kitchenSinkConversation(): PiMessage[] {
    const futureMessage = {
        role: "hologram",
        payload: { frames: 3 },
        timestamp: 9_000,
    } as unknown as PiMessage
    return [
        userMessage("set up the project"),
        assistantMessage(
            [
                { type: "thinking", thinking: "planning the setup", thinkingSignature: "sig-1" },
                { type: "text", text: "Starting setup." },
                { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
                { type: "toolCall", id: "call_2", name: "read", arguments: { path: "README.md" } },
            ],
            { stopReason: "toolUse", extraVendorField: { keep: true } } as Partial<AssistantMessage>,
        ),
        toolResultMessage("call_1", "src\npackage.json"),
        toolResultMessage("call_2", "# Project", {
            content: [
                { type: "text", text: "# Project" },
                { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
        }),
        {
            role: "bashExecution",
            command: "git status",
            output: "clean",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 4_000,
        } as PiMessage,
        {
            role: "custom",
            customType: "some-extension",
            content: "injected context",
            display: true,
            timestamp: 5_000,
        } as PiMessage,
        userMessage([
            { type: "text", text: "looks good, continue" },
            { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
        ]),
        {
            role: "branchSummary",
            summary: "explored approach A",
            fromId: "entry-42",
            timestamp: 6_000,
        } as PiMessage,
        {
            role: "compactionSummary",
            summary: "earlier work summarized",
            tokensBefore: 50_000,
            timestamp: 7_000,
        } as PiMessage,
        // Orphaned tool result: no matching call anywhere.
        toolResultMessage("call_missing", "orphan output", { timestamp: 8_000 }),
        futureMessage,
        assistantMessage([{ type: "text", text: "Done." }], { timestamp: 10_000 }),
    ]
}
