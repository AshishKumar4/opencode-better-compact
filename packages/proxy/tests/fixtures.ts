import type { WireBlock, WireMessage } from "../src/anthropic/codec"

export function userMessage(content: string | WireBlock[]): WireMessage {
    return { role: "user", content }
}

export function assistantMessage(content: string | WireBlock[]): WireMessage {
    return { role: "assistant", content }
}

export function toolUse(
    id: string,
    name: string,
    input: unknown,
    extra: Record<string, unknown> = {},
): WireBlock {
    return { type: "tool_use", id, name, input, ...extra }
}

export function toolResult(
    id: string,
    content: unknown,
    extra: Record<string, unknown> = {},
): WireBlock {
    return { type: "tool_result", tool_use_id: id, content, ...extra }
}

export function thinking(text: string, signature = "sig_abc"): WireBlock {
    return { type: "thinking", thinking: text, signature }
}

// A conversation exercising every shape the Claude Code wire produces:
// string and block user content, thinking, parallel tool_use with a mixed
// carrier (results + system-reminder text), redacted thinking, unknown block
// types, an orphan tool_result, images, and cache_control markers.
export function kitchenSinkMessages(): WireMessage[] {
    return [
        userMessage("start the task"),
        assistantMessage([
            thinking("private reasoning"),
            { type: "text", text: "Reading the file." },
            toolUse(
                "toolu_01",
                "Read",
                { file_path: "/etc/hosts" },
                { caller: { type: "direct" } },
            ),
            toolUse("toolu_02", "Bash", { command: "ls" }),
        ]),
        userMessage([
            toolResult("toolu_01", "127.0.0.1 localhost", { is_error: false }),
            toolResult("toolu_02", [{ type: "text", text: "file-a\nfile-b" }]),
            { type: "text", text: "<system-reminder>stay focused</system-reminder>" },
        ]),
        assistantMessage([
            { type: "redacted_thinking", data: "opaquedata==" },
            { type: "text", text: "Done. Next I will edit.", cache_control: { type: "ephemeral" } },
            {
                type: "server_tool_use",
                id: "srvtoolu_01",
                name: "web_search",
                input: { query: "x" },
            },
        ]),
        userMessage([
            toolResult("toolu_ghost", "orphaned result"),
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aWs=" } },
            { type: "text", text: "continue please" },
        ]),
        assistantMessage("plain string assistant reply"),
        userMessage("final question"),
    ]
}

export function messagesBody(
    messages: WireMessage[],
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        model: "claude-sonnet-4-5",
        max_tokens: 32_000,
        stream: true,
        system: [
            { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
            { type: "text", text: "Project instructions here." },
        ],
        tools: [{ name: "Bash", description: "run a command", input_schema: { type: "object" } }],
        metadata: { user_id: "user_123" },
        messages,
        ...overrides,
    }
}

// Big enough that the char/4 estimate crosses the light profile's 85%
// trigger of a 200k window.
export function bigConversation(exchanges = 12, outputChars = 80_000): WireMessage[] {
    const messages: WireMessage[] = []
    for (let index = 0; index < exchanges; index++) {
        messages.push(userMessage(`task ${index}: inspect module ${index}`))
        messages.push(
            assistantMessage([
                thinking(`thinking about module ${index}. `.repeat(40)),
                { type: "text", text: `Working on module ${index}.` },
                toolUse(`toolu_big_${index}`, "Bash", { command: `make module-${index}` }),
            ]),
        )
        messages.push(
            userMessage([
                toolResult(
                    `toolu_big_${index}`,
                    `output-${index} `.repeat(Math.ceil(outputChars / 10)),
                ),
            ]),
        )
    }
    messages.push(userMessage("second-to-last user prompt"))
    messages.push(assistantMessage([{ type: "text", text: "tail assistant reply" }]))
    messages.push(userMessage("latest user prompt"))
    return messages
}
