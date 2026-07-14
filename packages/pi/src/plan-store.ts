import { rangeHash, type PlanSnapshot, type PlanStore, type Turn } from "@better-compact/core"
import type { SessionManager } from "@earendil-works/pi-coding-agent"

export const PLAN_ENTRY_TYPE = "better-compact-plan"

type BranchReader = Pick<SessionManager, "getBranch">

export interface PiPlanStore extends PlanStore {
    // Rebuild the in-memory snapshot from the session branch. Custom entries
    // are recorded per branch position, so a fork or resume replays exactly
    // the plan its branch last saved.
    restore(session: BranchReader): void
    // A restored branch entry is only adopted after its compacted prefix is
    // proven to match the live context. Content-hash keys survive pi forks.
    adopt(sessionKey: string, turns: Turn[]): void
}

export function createPlanStore(
    appendEntry: (customType: string, data: unknown) => void,
): PiPlanStore {
    let snapshot: PlanSnapshot | null = null
    let pending: PlanSnapshot | null | undefined
    return {
        load: () => snapshot,
        save(_sessionKey, next) {
            snapshot = next
            pending = undefined
            appendEntry(PLAN_ENTRY_TYPE, { snapshot: next })
        },
        restore(session) {
            snapshot = null
            pending = null
            // getBranch walks root -> leaf; the last plan entry on the branch wins.
            for (const entry of session.getBranch()) {
                if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY_TYPE) continue
                pending =
                    (entry.data as { snapshot?: PlanSnapshot | null } | undefined)?.snapshot ?? null
            }
        },
        adopt(sessionKey, turns) {
            if (pending === undefined) return
            const stored = pending
            pending = undefined
            if (!stored) return
            const tailIndex = turns.findIndex((turn) => turn.key === stored.rawTailStartMessageId)
            if (tailIndex <= 0 || rangeHash(turns.slice(0, tailIndex)) !== stored.rangeHash) return
            snapshot = { ...stored, sessionId: sessionKey }
        },
    }
}
