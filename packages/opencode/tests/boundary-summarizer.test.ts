import assert from "node:assert/strict"
import test from "node:test"
import { summarizeBoundaryJobs } from "../lib/boundary/summarizer"
import { Logger } from "../lib/logger"
import { createRuntimeState } from "../lib/state"

test("scratch summaries use the resolved summary effort variant", async () => {
    const prompts: any[] = []
    const deleted: string[] = []
    const client = {
        session: {
            create: async () => ({ data: { id: "scratch-1" } }),
            prompt: async (input: any) => {
                prompts.push(input)
                return {
                    data: {
                        parts: [
                            {
                                type: "text",
                                text: "## Decisions\n- Keep the implementation.\n\n## Files & Symbols\n- src/index.ts\n\n## Errors (verbatim)\n- (none)\n\n## What failed and why\n- (none)\n\n## Constraints\n- Preserve behavior.\n\n## Next step\n- Run tests.",
                            },
                        ],
                    },
                }
            },
            delete: async (input: any) => {
                deleted.push(input.path.id)
            },
        },
    }
    const summaries = await summarizeBoundaryJobs({
        client,
        runtime: createRuntimeState(client, new Logger(false)),
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
