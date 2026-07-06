import assert from "node:assert/strict"
import test from "node:test"
import { summarizeBoundaryJobs } from "../lib/boundary/summarizer"
import { Logger } from "../lib/logger"
import { createSessionState } from "../lib/state"

test("scratch summaries use the resolved summary effort variant", async () => {
    const prompts: any[] = []
    const deleted: string[] = []
    const summaries = await summarizeBoundaryJobs({
        client: {
            session: {
                create: async () => ({ data: { id: "scratch-1" } }),
                prompt: async (input: any) => {
                    prompts.push(input)
                    return {
                        data: {
                            parts: [{ type: "text", text: "Detailed summary content. ".repeat(8) }],
                        },
                    }
                },
                delete: async (input: any) => {
                    deleted.push(input.path.id)
                },
            },
        },
        state: createSessionState(),
        logger: new Logger(false),
        parentSessionId: "session-1",
        jobs: [
            {
                key: "job-1",
                rangeStartMessageId: "message-1",
                rangeEndMessageId: "message-2",
                transcriptRelativePath: ".opencode/transcript.md",
                prompt: "Summarize this run.",
            },
        ],
        params: {
            providerId: "openai",
            modelId: "gpt-test",
            agent: "build",
            variant: "high",
        },
    })

    assert.equal(prompts[0]?.body.variant, "high")
    assert.equal(typeof summaries["job-1"], "string")
    assert.deepEqual(deleted, ["scratch-1"])
})
