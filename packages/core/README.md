> This document is edited and maintained by Claude (Anthropic) and presented as-is.

# @better-compact/core

This is the heart of Better Compact: the platform-neutral, staged context-pruning
ladder, sitting over a canonical message IR. It is pure — no I/O, no network, no
filesystem, zero runtime dependencies — so the exact same pruning behavior runs
everywhere and every platform adapter is a thin codec around it.

It is a workspace-internal package (`private`, unpublished). Each adapter
(`opencode`, `pi`, `proxy`) bundles core into its own `dist/` at build time; you
never install `@better-compact/core` on its own.

## What it does

Given a conversation as `Turn[]` and a context limit, the engine decides whether
the context has crossed the trigger and, if so, walks the ladder — prune old
tool calls/results (keeping a recent-tool budget), then reasoning, then remaining
tool calls, then summarize old assistant runs, and only as a last resort a prefix
summary — writing a raw transcript and injecting a reference message so the model
can read back what was pruned. Plans are cached, validated with a range hash,
replayed deterministically across requests, and rebuilt when the context regrows
past the trigger.

## The public surface, at a glance

Everything is re-exported from [`src/index.ts`](src/); read that for the exact
list. The pieces, and where they live:

- **The IR** — [`src/ir.ts`](src/ir.ts): `Turn`, `Item`, `Codec<Native>` /
  `CodecOps`, `Conventions`. An `Item` is a view with a `handle` onto its
  original native payload; only `synthetic` items (ladder output) have none.
- **The engine and ladder** — [`src/ladder.ts`](src/ladder.ts): `createEngine`,
  `Engine`, `ProcessResult`, plus `buildPlan` / `transformTurns` /
  `replayPlanSnapshot` and the `LadderSpec` type (codec + conventions + ordered
  stages).
- **The stages** — [`src/stages.ts`](src/stages.ts): `skillsStage`,
  `toolsOldStage`, `reasoningStage`, `toolsRemainingStage`, `assistantRunsStage`,
  and the `Stage` type. A platform's ladder is just the subset it declares, in
  order — absence from the array is the only conditionality.
- **Plans** — [`src/plan.ts`](src/plan.ts): `BoundaryContextPlan`,
  `PlanSnapshot`, `toPlanSnapshot`, and the stage/summary/report types.
- **Ports** — [`src/ports.ts`](src/ports.ts): `EnginePorts` — exactly
  `{ transcripts, plans, logger }` — plus `TranscriptStore`, `PlanStore`,
  `Summarizer`, `Logger`.
- **Identity, estimation, transcript, summaries, profiles** —
  [`src/identity.ts`](src/identity.ts) (`contentHashKey`, `keyDeduper`,
  `rangeHash`), [`src/estimate.ts`](src/estimate.ts),
  [`src/transcript.ts`](src/transcript.ts),
  [`src/summarize.ts`](src/summarize.ts) (`createSummaryScheduler`),
  [`src/profiles.ts`](src/profiles.ts) (`COMPACTION_PRESETS`).

## How an adapter consumes it

An adapter supplies three things and calls one function:

1. A **`Codec<Native>`** — how to `encode` the platform's native messages into
   `Turn[]` and `decode` them back (untouched handles re-emitted verbatim), plus
   how to price and render items.
2. **`Conventions`** — selectors for platform semantics the stages need
   (`isSkillItem`, `todo`), supplied only where the platform has them.
3. An ordered **stage array**. Together, (1)–(3) are a `LadderSpec`.

Plus `EnginePorts`: a `TranscriptStore`, a `PlanStore`, and a `Logger`. Then, at
the platform's boundary:

```ts
const engine = createEngine(spec, ports)
const result = await engine.process({ sessionKey, turns, contextLimit /* … */ })
// result.outcome: "unchanged" | "replayed" | "planned"
```

`process` owns only the deterministic transform (plan load/validate/replay or
build/persist/apply, transcript write). Summarization is **adapter-owned**: core
gives you `createSummaryScheduler` (the concurrency, dedupe, and failure-circuit
loop); the adapter provides the `Summarizer.complete` transport and schedules the
background upgrade, which lands in the plan for the next request.

The three shipping adapters — `packages/opencode`, `packages/pi`,
`packages/cli` (Anthropic + OpenAI Responses codecs) — are the reference
consumers. The full design is in [`../../docs/architecture.md`](../../docs/architecture.md).
