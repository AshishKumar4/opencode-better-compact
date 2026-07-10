import type { PlanSnapshot, PlanStore } from "@better-compact/core"
import type { SessionManager } from "@earendil-works/pi-coding-agent"

export const PLAN_ENTRY_TYPE = "better-compact-plan"

type BranchReader = Pick<SessionManager, "getBranch" | "getSessionId">

export interface PiPlanStore extends PlanStore {
    // Rebuild the in-memory snapshot from the session branch. Custom entries
    // are recorded per branch position, so a fork or resume replays exactly
    // the plan its branch last saved.
    restore(session: BranchReader): void
}

export function createPlanStore(appendEntry: (customType: string, data: unknown) => void): PiPlanStore {
    let snapshot: PlanSnapshot | null = null
    return {
        load: () => snapshot,
        save(_sessionKey, next) {
            snapshot = next
            appendEntry(PLAN_ENTRY_TYPE, { snapshot: next })
        },
        restore(session) {
            snapshot = null
            // getBranch walks root -> leaf; the last plan entry on the branch wins.
            for (const entry of session.getBranch()) {
                if (entry.type !== "custom" || entry.customType !== PLAN_ENTRY_TYPE) continue
                const stored = (entry.data as { snapshot?: PlanSnapshot | null } | undefined)?.snapshot ?? null
                // Forks copy the branch into a new session file under a new id;
                // provenance is the branch scan itself, so rebase to the live
                // session for the engine's ownership check.
                snapshot = stored ? { ...stored, sessionId: session.getSessionId() } : null
            }
        },
    }
}
