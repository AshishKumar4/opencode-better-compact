# Better Compact: Multi-Platform Architecture

Design for extending the context-pruning ladder from OpenCode to pi, Claude Code, and Codex. Designed against the post-fix engine semantics (unified simulate/replay, single-scale token accounting with measured provider-overhead offset, rangeHash validation at apply, re-prune on regrowth, in-flight guard).

Three integration modes exist in the wild:

- **In-process transform** (OpenCode `experimental.chat.messages.transform`, pi `context` event): we receive the platform's native message array and return a replacement.
- **Wire proxy** (Codex via `openai_base_url`): we receive the full serialized request body, rewrite `messages`/`input`, and pass the response SSE through untouched.
- **On-disk transcript compaction** (Claude Code, `better-compact claude`): we rewrite the closed session's transcript file, which the platform re-derives its context from on resume.

Everything below follows from making the ladder run once, identically, over these modes.

> **Claude Code pivot (2026-07-16).** This document originally routed Claude Code through the wire
> proxy. Live verification falsified that design: Claude Code enforces its context ceiling
> **client-side, before any request is sent**, and anchors its context meter on token counts
> recorded inside the session transcript — the last `usage` along the resolved `parentUuid` chain,
> reconstructed from `usage.iterations` at load. A proxy therefore never sees the requests that
> matter and cannot move the meter. The shipped integration compacts the transcript on disk
> instead (`packages/cli/src/claude/`): stub old tool inputs/outputs and reasoning in place
> keeping every message (or `--aggressive`: reproduce the native append-only
> `compact_boundary` + `isCompactSummary` entries), and zero the stale input-side usage counters so
> the meter recounts the real content. The Claude-Code-specific proxy claims later in this
> document are retained as design history and are superseded by this note.

---

## 1. Core abstraction: canonical IR with handle-preserving codecs (option a)

**Decision: a canonical IR, but IR items are *views with handles* — every item carries its original native payload opaquely; decode re-emits untouched payloads verbatim and only synthesizes what the plan changed.**

Rejected alternative — capability interface over native shapes (option b): tool results live in *different messages* from their calls on three of four platforms (pi `ToolResultMessage`, Anthropic `tool_result` blocks in the next user message, Codex `function_call_output` items). A capability interface either leaks that pairing structure into the ladder (fat, per-platform-shaped interface) or forces each adapter to reimplement selection/grouping/summarization mechanics (four copies of the algorithm). The IR pays one codec per platform — which the proxy mode forces us to write anyway, since we must parse the wire format regardless. The IR passes the deletion test: inlining it means writing the ladder four times.

### 1.1 The IR

```ts
// packages/core/src/ir.ts
type ItemKey = string // platform id, or content-hash (§1.4)

interface Turn {
    key: ItemKey
    role: "user" | "assistant"
    items: Item[]
}

type Item =
    | { kind: "text"; key: ItemKey; text: string; handle: unknown }
    | { kind: "reasoning"; key: ItemKey; text: string; handle: unknown }
    | { kind: "tool"; key: ItemKey; callId: string; name: string
        input: unknown; output?: string; error?: string; handle: unknown }
    | { kind: "opaque"; key: ItemKey; handle: unknown } // unknown block types — never touched by stages
    | { kind: "synthetic"; key: ItemKey; text: string } // ladder output; no handle — codec renders it

interface Codec<Native> {
    encode(native: Native): Turn[]
    decode(turns: Turn[], native: Native): Native // untouched handles re-emitted verbatim
    encodedSize(item: Item): number // chars of the item as this platform serializes it (§3 estimator)
}
```

- **Fidelity contract** (property-tested, §6): `decode(encode(x), x)` is deep-value-equal to `x` — every field the codec does not model (unknown block types, vendor extensions, `cache_control`, `prompt_cache_key`, `client_metadata`) survives byte-for-byte at the value level. Wire-level whitespace/key-order is irrelevant to upstreams and to prompt caching (caching is over tokenized content, not JSON bytes); *headers* are the byte-verbatim surface, and the proxy passes those through untouched (§4).
- **Tool pairing is the codec's job.** The codec presents call+result as one IR `tool` item whatever the native split; when the ladder drops it, the codec drops the full native footprint (Anthropic: the `tool_use` block *and* the `tool_result` block, collapsing the carrier user message if emptied; pi: the `ToolCall` content *and* the `ToolResultMessage`; Codex: the `function_call`/`function_call_output` pair). Validity invariants (Anthropic's strict tool_use/tool_result pairing, Codex's reasoning-adjacent-to-function_call constraint) are enforced structurally inside `decode` — where a Codex `reasoning` item is not independently removable, the codec binds it into the adjacent tool item's handle so it lives and dies with the pair. No validity knowledge leaks into the ladder.
- **Reasoning:** OpenCode `reasoning` part, pi `ThinkingContent`, Anthropic `thinking` block, Codex `reasoning` item → all `kind:"reasoning"`. The raw tail is never touched, so current-turn thinking-signature constraints (Anthropic interleaved thinking, Codex encrypted reasoning for in-flight tool loops) never arise — those live in the tail by construction.
- **Turn grouping:** a Turn is a role-run. pi's `BashExecutionMessage`/`CustomMessage`, and any assistant-adjacent oddities, fold into the enclosing turn as `opaque` items. `CompactionSummaryMessage` (pi) and CC microcompaction placeholders arrive as ordinary content — already cheap, the estimator prices them honestly, no special-casing.

### 1.2 Platform conventions (selectors, not flags)

"Skill parts" and "latest todo" are platform *semantics*, expressed as selectors the adapter supplies:

```ts
interface Conventions {
    isSkillItem?(item: Item): boolean   // OpenCode: tool part tool==="skill"; CC: tool_use name "Skill"
    todo?: { isTodoItem(item: Item): boolean; format(item: Item): string } // OpenCode/CC: todowrite/TodoWrite
}
```

pi supplies neither (todo lives in session details, outside messages — nothing to preserve in-band); Codex supplies neither. The stage that needs a missing convention simply isn't in that platform's ladder (§5). No runtime gates.

### 1.3 Synthetic message rendering

The ladder emits `synthetic` items (reference message, prefix summary, `[tool calls cleared]` markers, todo-preserved lines). Each codec renders them as the smallest valid native shape: OpenCode → synthetic user message with a text part (as today); pi → user `AgentMessage` with `TextContent`; Anthropic → user message with one text block (**never** the system array — gateway protocol requires it untouched); Codex → user `message` ResponseItem. The reference message cites the transcript path from the `TranscriptStore` port (§3), so the agent's own Read/cat tool can recall raw history on any platform.

### 1.4 Identity without message IDs

OpenCode and pi have stable ids; Anthropic messages and Codex ResponseItems do not. One identity concept, two derivations:

- `ItemKey` = native id when the platform has one; else `sha256(stableJson(nativePayload)).slice(0,16)` with an occurrence-ordinal suffix (`#2`) for identical payloads. `TurnKey` = key of the turn's first item.
- `rangeHash` = sha256 over the compacted range's ordered per-turn `${key}:${stamp}` seed — byte-identical to the historical id+timestamp seed, so an edit-sensitive stamp (OpenCode's message creation time; folded into the content-hash key on id-less platforms) still participates in the hash.
- **Plan replay on id-less platforms:** the plan stores the tail-start TurnKey. On the next request, locate it by scanning keys from the end (append-only transcripts guarantee the prefix is stable), validate the prefix `rangeHash`, and replay deterministically. Hash mismatch — e.g. CC microcompaction rewrote an old tool_result, changing its content hash — means the prefix genuinely changed: discard and rebuild the plan against the new reality. That is correct behavior, not a failure; microcompaction already invalidated the provider prompt cache, so the one-time re-prune costs nothing extra.

---

## 2. Package layout

pnpm workspace in this repo, renamed **`better-compact`** (GitHub rename from `opencode-better-compact` with redirect; README rewritten — it currently claims "OpenCode plugin", which becomes one adapter among four):

```
better-compact/
├── package.json                 # workspace root: typecheck/test/build fan-out only
├── pnpm-workspace.yaml
└── packages/
    ├── core/                    # @better-compact/core — pure, zero I/O
    │   └── src/  ir.ts  ladder.ts  stages.ts  plan.ts  identity.ts
    │             estimate.ts  transcript.ts  summarize.ts  profiles.ts  ports.ts
    ├── opencode/                # better-compact (npm name unchanged — existing installs keep working)
    │   └── src/  index.ts  tui.tsx  codec.ts  adapter/…  (hooks, commands, tui, state,
    │             host-permissions, auth, update — today's lib/, minus what moved to core)
    ├── pi/                      # @better-compact/pi — single-file-bundled extension + npm "pi package"
    │   └── src/  extension.ts  codec.ts  summarizer.ts  plan-store.ts
    ├── proxy/                   # @better-compact/cli — `better-compact` daemon
    │   └── src/  server.ts  session.ts  engine.ts  anthropic/codec.ts  openai/codec.ts
    │             summarizer.ts  stores.ts
    └── claude-code/             # @better-compact/claude-code — CC plugin (UX shell over proxy)
        └── commands/  hooks/  statusline/  scripts/install.sh
```

**Judgment calls:**

- **One proxy package, not three.** Rejected `proxy` + `proxy-anthropic` + `proxy-openai-responses`: the codecs are not independently consumable (nothing imports an Anthropic codec except the proxy), and one daemon serving both dialects by route (`/anthropic/v1/messages`, `/openai/responses`) is one deployable, one lifecycle, one install story. Codecs are modules inside the package.
- **Codecs live with their consumer**, not in core: OpenCode codec in `packages/opencode`, pi codec in `packages/pi`, wire codecs in `packages/cli`. Core stays dependency-free and platform-blind.
- **No `codex` package.** Codex's only extension surface is prompt-file slash commands; its entire adapter *is* the openai codec plus installer edits to `config.toml` (`openai_base_url`, custom `compact_prompt`). A package with no code fails the deletion test — Codex setup ships as `better-compact install codex`.
- **What stays OpenCode-specific:** TUI (`tui.tsx`, lib/tui, lib/ui), commands, host-permissions, compress-permission, auth, auto-update, hallucination stripping (lib/messages/reasoning-strip et al.), scratch-session summarizer. None of it generalizes; none of it should.

**Release/installer per platform:** OpenCode — npm package installed through OpenCode's built-in plugin manager (`opencode plugin better-compact --global`); the release pipeline packs, smoke-installs, and publishes with provenance (the earlier curl install.sh is retired). pi — npm "pi package" plus a bundled single `.ts`/`.js` artifact for `~/.pi/agent/extensions` drop-in; extension sets `compaction.enabled:false` (the pi analogue of today's `compaction.auto:false` in index.ts). Claude Code — plugin distribution (git/marketplace); its installer writes `ANTHROPIC_BASE_URL` into settings `env` and installs the proxy binary. Proxy — npm `bin` + install.sh, same checksum discipline as the existing installer.

---

## 3. Core/port interface

Core is one deep module. The entire external surface:

```ts
// packages/core/src/ports.ts — the entire port surface (as shipped)
interface EnginePorts { transcripts: TranscriptStore; plans: PlanStore; logger: Logger }

interface Summarizer {                // side-model; the adapter owns transport AND scheduling
    complete(job: BoundarySummaryJob): Promise<string | null>
}
interface TranscriptStore {
    // citablePath is known before anything is written (stage output embeds it),
    // so the reference message can cite it; the store hides the path scheme.
    citablePath(sessionKey: string, rangeHash: string): string
    write(relativePath: string, content: string): Promise<{ absolutePath?: string }>
}   // OpenCode keeps a project-relative ".opencode/better-compact/…" path (agent-readable,
    // ignorable); the proxy has no cwd, so it uses an absolute "~/.better-compact/transcripts/…".
interface PlanStore {
    load(sessionKey: string): Promise<PlanSnapshot | null> | PlanSnapshot | null
    save(sessionKey: string, snapshot: PlanSnapshot | null): Promise<void> | void  // null clears a stale plan
}

// packages/core/src/ladder.ts — the LadderSpec (codec + conventions + ordered
// stages) comes first, the ports second.
function createEngine(spec: LadderSpec, ports: EnginePorts): Engine

interface Engine {
    process(req: {
        sessionKey: string
        turns: Turn[]
        contextLimit?: number
        triggerRatio?: number
        targetRatio?: number
        recentToolResultBudgetTokens?: number
        providerReportedTokens?: number   // last provider-reported total, when the platform has it
    }): Promise<ProcessResult>
}

type ProcessResult =
    | { outcome: "unchanged" }
    | { outcome: "replayed"; turns: Turn[] }
    | { outcome: "planned"; turns: Turn[]; plan: BoundaryContextPlan }
```

*(The original design sketched a `summarizer` port on `EnginePorts`, a `now` hook, and a `{turns, plan, report}` return with a `force` flag; the shipped surface is the above. Summary scheduling moved out of the engine to the adapter, so the port set is exactly `{transcripts, plans, logger}` and `process` returns the discriminated union.)*

`process` owns the deterministic boundary transform: load the cached plan, validate its rangeHash, replay it when it still holds, otherwise discard it and build, persist, and apply a fresh one (re-pruning once the context regrows past the trigger), and write the transcript. **Summarization is adapter-owned**, not part of `process`: the adapter schedules `summarizeJobs` (core's concurrency/dedupe loop) in the background under its own in-flight guard, then persists the upgraded plan so it applies from the next request. The deterministic stages apply synchronously and never block a request; assistant-run summaries land between requests and upgrade the replayed prefix — the OpenCode auto-transform and background `runBetterCompact` paths, unified as one engine behavior plus one adapter-scheduled upgrade.

**Estimator:** core-owned, single-scale. `estimate(turns) = Σ chars(codec.estimateTurns …)/4 + overheadTokens`, where `overheadTokens` is the **last-value delta** `providerReportedTokens − rawEstimate` carried from the request's own reported usage (not an EMA). Provider totals include the system prompt, tool schemas, and cache accounting the char estimate cannot see, so carrying the delta keeps every gate and stage number on the provider-equivalent scale. The codec prices items as *that platform* serializes them — today's `toOpenCodeModelLikeMessage` in lib/context-estimate.ts is exactly the OpenCode implementation of this.

**File-by-file mapping of today's lib/:**

| Today | Destination |
|---|---|
| lib/boundary/context.ts | **core** — ladder, stages, plan, transcript format, reference/summary synthesis, rangeHash — generalized from `WithParts` to `Turn[]`. The heart of the extraction. |
| lib/boundary/summarizer.ts | split: scheduler/dedupe/concurrency/validation → **core** `summarize.ts`; scratch-session transport (`client.session.create/prompt/delete`) → **opencode** `Summarizer` impl |
| lib/boundary/progress.ts | job-progress model → **core** (report type); state wiring → opencode |
| lib/token-utils.ts | `countTokens` heuristic → **core** `estimate.ts`; `getCurrentTokenUsage`/`getCurrentParams` → **opencode** adapter (feeds `reportedTokens`) |
| lib/context-estimate.ts | **opencode codec** (`encodedSize` + breakdown for /context command) |
| lib/compaction-settings.ts | **core** `profiles.ts`, verbatim |
| lib/state/types.ts | `PlanSnapshot`/report types → **core** `plan.ts`; `SessionState` shell → opencode |
| lib/state/persistence.ts | **opencode** `PlanStore` impl (unchanged storage path) |
| lib/hooks.ts | **opencode** adapter — hooks call `engine.process` and the codec |
| lib/messages/* | **opencode** (shape filtering, hallucination strip are host-specific) |
| lib/commands, lib/tui, lib/ui, tui.tsx | **opencode** |
| lib/config.ts, host-permissions, compress-permission, auth, update, logger | **opencode** (logger interface type → core) |

Per-platform port implementations: **pi** — Summarizer via pi-ai `complete` + `ctx.modelRegistry.getApiKeyAndHeaders` (the blessed path); PlanStore via `pi.appendEntry` CustomEntry (branch-aware, restart-safe — a fork replays the plan recorded on its branch); trigger inputs from `ctx.getContextUsage()`. **proxy** — Summarizer issues a non-streaming upstream call reusing the exact credentials/headers of the request being served (§4); PlanStore = in-memory LRU backed by `~/.better-compact/plans/`; `reportedTokens` parsed from the usage fields of the SSE stream we relay.

---

## 4. Proxy engine design

One daemon, `better-compact`, binding `127.0.0.1` on a fixed default port (e.g. 42817), serving both dialects by route:

- `POST /anthropic/v1/messages` → rewrite → `api.anthropic.com` (or the pre-existing `ANTHROPIC_BASE_URL` value, read at install time and composed as upstream, so existing gateway users keep working)
- `POST /openai/responses` → rewrite → configured OpenAI upstream
- everything else on those prefixes → transparent passthrough (token counting, models, etc.)

**Lifecycle.** The CC plugin's SessionStart hook ensures the daemon is up (spawn-if-absent, idempotent via `~/.better-compact/proxy.json` `{port, pid}` lockfile); the Codex installer prints/installs the same. Fixed port beats discovery: `ANTHROPIC_BASE_URL` must be present in settings `env` *before* `claude` launches, and `openai_base_url` lives in static `config.toml` — neither can chase a dynamic port. Port conflict with a foreign process → fail loud at start, never silently degrade. Multi-instance is a non-goal: one shared per-user daemon serves all sessions concurrently, keyed by correlation id. Rejected per-session proxies: N lifecycles and N ports for zero isolation benefit.

**Request path.** Buffer the JSON body (bodies are small relative to what we save), `codec.encode`, `engine.process` keyed on the correlation id — CC: `x-session` header; Codex: session-id/thread-id headers with `prompt_cache_key` as fallback; absent all of these, derive the key from the hash of the first user item — then `codec.decode`, re-serialize, fix `content-length`, forward. **All other headers byte-verbatim** — `anthropic-beta`, `anthropic-version`, auth, everything (the gateway protocol demands it). The system array/`instructions` field is never touched; our injection is always a user-role message. Response: **SSE piped through byte-for-byte, unbuffered** — we prune requests, never responses. Usage fields are read from the relayed stream without modification to update the estimator offset and plan-cache telemetry.

**Failure posture.** Every per-request rewrite is wrapped: any internal error (codec, engine, store) → log, forward the *original* body and headers unmodified — the user's session must never break because of us. Upstream 4xx after a rewrite passes through unchanged, and the proxy dumps the offending rewritten body to `~/.better-compact/debug/` for fixture-ing. Rejected retry-once-with-original-on-400: it masks codec bugs, doubles cost and latency, and offline golden/property testing (§6) is the right place to earn validity confidence.

**Claude Code specifics.** OAuth against a custom base URL was verified working live on Claude Code 2.1.205 through the loopback proxy with no extra configuration (the API-key path needs nothing either). `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` exists in that binary and also works; it is kept as a documented contingency should a future version gate OAuth behind it. Native auto-compact needs no fighting: the API usage CC observes comes from our pruned requests, so it stays below CC's threshold naturally; `DISABLE_AUTO_COMPACT` is set by the installer as belt-and-braces since the knob officially exists. Microcompaction has no disable knob, so we *compose*: cleared tool outputs arrive as cheap placeholders the estimator prices honestly, and if microcompaction rewrites prefix content the rangeHash rebuild (§1.4) re-prunes correctly. `cache_control` breakpoints: a marker on a block we prune migrates to the nearest surviving earlier item (or the synthetic replacement) so CC's cache-anchoring intent survives; markers in the raw tail are untouched by construction.

**Codex pre-emption.** Native compaction (90% trigger, 100% backstop, non-disableable) keys off API-reported usage — which, behind our proxy, reflects the *pruned* request. Our default 85% trigger (light profile) therefore keeps Codex's own gauge permanently below 90%: pre-emption is a free consequence of the architecture, not a fought battle. Residual: a raw tail alone exceeding 90% of the window can still trip native compaction; the installer sets a custom `compact_prompt` directing any native summary to cite our transcript paths, so even that path degrades gracefully. `prompt_cache_key` and `client_metadata` pass through untouched.

**Prompt-cache economics.** Prefix rewriting invalidates the provider prompt cache exactly once per plan change. Plan stability is the mitigation, and it aligns with plan-replay by design: after a plan is built, every subsequent request decodes to a byte-stable transformed prefix (deterministic replay from the snapshot), so the pruned prefix becomes the new cached prefix and stays cached until regrowth crosses the trigger again — one cache re-write per prune event, amortized over the many turns the plan holds. The transformed-prefix determinism property in §6 is what guarantees this.

**Summarization side-calls** reuse the Bearer/x-api-key and headers of the request being served, non-streaming, small max_tokens, same model as the session (rejected a separate configured side-model: new credential path, new config, no demonstrated need), run in the background under the in-flight guard; the upgraded plan applies from the next request.

---

## 5. Ladder generalization

Universal stages, in ladder order: `tools-old` (with recent-tool budget) → `reasoning` → `tools-remaining` → `assistant-runs` (scored savings×age, background summaries) → `prefix-summary`, plus transcript write and reference injection. Platform-conditional: `skills` (needs `isSkillItem`), todo preservation inside the tool stages (needs `todo` convention).

Composition is a declared stage array per adapter — data, not flags:

```ts
// packages/opencode/src/adapter.ts        // packages/pi/src/extension.ts
stages: [                                  stages: [
  skillsStage(conventions),                  toolsOldStage(),      // no skills, no todo:
  toolsOldStage(conventions.todo),           reasoningStage(),     // pi todo lives in
  reasoningStage(),                          toolsRemainingStage(),// session details,
  toolsRemainingStage(conventions.todo),     assistantRunsStage(), // outside messages
  assistantRunsStage(conventions.todo),      prefixSummaryStage(),
  prefixSummaryStage(),                    ]
]
// proxy/anthropic: same as opencode (CC has Skill tool_use + TodoWrite)
// proxy/openai: same as pi (codex has neither)
```

A stage is `(turns, budget, ctx) → StageResult` operating purely on IR; the trigger/target/short-circuit loop (`isBelowTrigger`, `markTargetMet`), raw-tail boundary selection (`findRawTailStartIndex` — user-turn counting works identically on IR turns), and recent-tool budget walk port from context.ts unchanged in logic. No stage ever reads a platform name; absence from the array is the only conditionality.

---

## 6. Testing strategy

- **Core ladder behavior tests (written once, on IR):** port tests/boundary-context.test.ts to IR fixtures; cover trigger/target thresholds, tail inviolability, recent-tool budget edges, assistant-run scoring, summary-key replay, degenerate cases (single message, all-user history, empty prefix, plan vs. shrunk history).
- **Core properties:** stage monotonicity (tokens never increase), replay determinism (same plan + same turns → identical output turns — the prompt-cache guarantee), apply-idempotence, rangeHash stability under tail growth and mismatch under prefix mutation.
- **Codec golden fixtures (per codec):** captured *real* bodies — OpenCode via the existing `logger.saveContext` dumps; CC and Codex via a proxy `--capture` mode writing sanitized request bodies during Phase 3/4 bring-up; pi via a context-event dump. Assert: `decode(encode(b), b)` deep-equals `b` (empty plan), and unknown-field preservation via fuzz-injected junk keys that must survive round-trip.
- **Codec validity tests:** after each stage on each fixture, the decoded body satisfies platform invariants (every `tool_use` has its `tool_result`, no orphaned `function_call_output`, no empty content arrays, system/instructions untouched).
- **Proxy integration (fake upstream):** byte-identical SSE relay, header verbatim-ness, plan-cache reuse across sequential requests on one `x-session`, failure posture (codec throws → upstream receives the original body), concurrent sessions.
- **Per-platform smoke stories:** OpenCode — existing suite + `opencode plugin dev` session; pi — extension in a scripted pi session, verify context-event replacement and appendEntry plan survival across restart and branch fork; CC — real session through the proxy, drive past trigger, verify pruned usage in transcript JSONL and transcript-file recall via Read; Codex — `codex exec resume` loop through the proxy, verify native compaction never fires and thread replay stays valid.

---

## 7. Migration phasing

Each phase ships green (typecheck/tests/build) and independently useful. Phase 1 starts only after the concurrent engine-correctness work on context.ts/hooks.ts lands — extracting a moving target multiplies risk for nothing.

1. **Phase 1 — workspace + core extraction, zero behavior change.** Restructure into pnpm workspaces (`packages/opencode` = today's plugin, unchanged npm name so existing installs keep working). Extract core onto the IR; the OpenCode codec is the first codec. **This is the riskiest step of the whole program** — it rewrites the engine's data model. Verification: the full existing test suite passes unmodified against the adapter, plus a pre/post golden harness: capture N real-session transform inputs *before* the refactor (saveContext dumps), assert the post-refactor transform output is deep-equal on every capture. Ship as a patch release; observed behavior identical.
2. **Phase 2 — pi extension.** Smallest new adapter; in-process like OpenCode but exercises the split tool-result message model, content-hash-free ids, appendEntry plan persistence, and pi-ai summarizer — validating that the IR isn't secretly OpenCode-shaped. Verify with the pi smoke story; publish `@better-compact/pi`.
3. **Phase 3 — proxy engine + Anthropic codec + Claude Code plugin.** Riskiest for *new failure modes* (we enter the credential path): mitigations are the forward-original failure posture, `--capture` fixture harvesting from day one, gateway-constraint conformance tests (headers, system array, SSE), and a live check of `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` before the OAuth story is documented. Verify with the CC smoke story and a week of dogfooding on real sessions.
4. **Phase 4 — OpenAI Responses codec + Codex story.** Adds the codec, hash-only identity at scale, pre-emption verification (drive a session past 90% raw, confirm native compaction never fires), `codex exec` headless smoke, and the `install codex` config writer.

Rename/branding lands with Phase 1: repo → `better-compact`, README rewritten around the ladder as the product with four adapters, schema URLs re-pointed post-rename (they were just fixed to master — e7649bc — and must move with the rename in the same commit).
