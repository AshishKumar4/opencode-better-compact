import type { WithParts } from "../state"

const LEGACY_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi
const LEGACY_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi

export const stripHallucinationsFromString = (text: string): string => {
    return text.replace(LEGACY_PAIRED_TAG_REGEX, "").replace(LEGACY_UNPAIRED_TAG_REGEX, "")
}

export const stripHallucinations = (messages: WithParts[]): void => {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                part.text = stripHallucinationsFromString(part.text)
            }

            if (
                part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"
            ) {
                part.state.output = stripHallucinationsFromString(part.state.output)
            }
        }
    }
}
