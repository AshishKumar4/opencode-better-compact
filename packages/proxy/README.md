> This document is edited and maintained by Claude (Anthropic) and presented as-is.

# @better-compact/proxy

I'm the wire-proxy adapter for the Better Compact ladder: a small local daemon that sits between
an Anthropic-wire coding agent (Claude Code today) and the Anthropic API, pruning the request the
agent is about to send. The agent keeps its full history; only what goes over the wire shrinks.

## What it does

- `better-compact-proxy start|stop|status` — a daemon on `127.0.0.1:42817` with a
  `~/.better-compact/proxy.json` `{port, pid}` lockfile. Start is idempotent; a foreign process on
  the port is a loud failure, never a silent degrade.
- `POST /anthropic/v1/messages` is rewritten through the shared core ladder (skills → old tools →
  reasoning → remaining tools → assistant-run summaries → last-resort prefix summary). Everything
  else under `/anthropic/*` passes through untouched.
- Correlation: the `x-session` header when a client sends one; Claude Code sends none, so the
  fallback is a content hash of the session's first user message. Plans persist under
  `~/.better-compact/plans/`, raw transcripts (cited by the injected reference message, readable by
  the agent's own Read tool) under `~/.better-compact/transcripts/`.
- Assistant-run summaries run in the background as non-streaming `/v1/messages` calls that reuse
  the exact credentials and headers of the request being served — no separate credential path.

## Wire guarantees

These are pinned by the test suite, not aspirations:

- Request headers reach the upstream verbatim (`anthropic-beta`, `anthropic-version`, `x-api-key`,
  `authorization`, everything) — only `host` and body-framing headers are re-derived.
- The `system` array is never touched; the reference/summary injection is always a user message.
- The response is relayed byte-for-byte and unbuffered. Usage fields are read from the relayed
  stream (to feed the next request's trigger accounting) without modifying it.
- Failure posture: any internal error logs and forwards the original bytes unmodified. Upstream
  errors pass through unchanged; a 4xx after a rewrite dumps the rewritten body to
  `~/.better-compact/debug/` for fixturing. There is no retry-with-original.
- `cache_control` markers on pruned blocks migrate to the nearest surviving earlier block (or the
  synthetic replacement), and markers are excluded from message identity so a moved breakpoint
  never reads as an edited prefix.

## Configuration

`~/.better-compact/config.json`:

```json
{
    "anthropicUpstream": "https://api.anthropic.com",
    "preset": "light"
}
```

Both optional. If you already pointed your agent at a gateway via `ANTHROPIC_BASE_URL`, the
Claude Code installer records that URL here as the upstream, so the gateway keeps working behind
the proxy. `preset` is `light` (default), `moderate`, or `max`.

`better-compact-proxy start --capture` additionally writes incoming request bodies (bodies only —
headers, and with them credentials, are never written) to `~/.better-compact/captures/` for
building golden fixtures.

## Honest limitations

- Context windows are inferred from the `anthropic-beta` header (`context-1m` → 1M, otherwise
  200k); there is no per-model table.
- Session keys derived from the first user message assume that message is stable for the session —
  true for Claude Code, and a mismatch only costs a plan rebuild, never correctness.
- Only the Anthropic dialect exists today; the OpenAI Responses route is planned as a second route
  module in the same daemon.
