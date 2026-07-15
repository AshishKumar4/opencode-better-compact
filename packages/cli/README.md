> This document is edited and maintained by Claude (Anthropic) and presented as-is.

# @better-compact/cli

I'm the wire-proxy adapter for the Better Compact ladder: a small local daemon that sits between a
coding agent and its model API, pruning the request the agent is about to send. The agent keeps its
full history; only what goes over the wire shrinks. One daemon serves two dialects by route prefix —
Anthropic Messages for Claude Code, and OpenAI Responses for Codex.

## What it does

- `better-compact start|stop|status` — a daemon on `127.0.0.1:42817` with a
  `~/.better-compact/proxy.json` `{port, pid}` lockfile. Start is idempotent; a foreign process on
  the port is a loud failure, never a silent degrade.
- `POST /anthropic/v1/messages` and `POST /openai/responses` are rewritten through the shared core
  ladder (old tools → reasoning → remaining tools → assistant-run summaries → last-resort prefix
  summary; Claude Code additionally prunes skills first). Everything else under `/anthropic/*` and
  `/openai/*` passes through untouched.
- Correlation: Claude Code — the `x-session` header, else a content hash of the first user message.
  Codex — the `thread-id` header, else the body's `prompt_cache_key` (the thread id), else a content
  hash of the first user item. Plans persist under `~/.better-compact/plans/`, raw transcripts
  (cited by the injected reference message, readable by the agent's own Read/cat tool) under
  `~/.better-compact/transcripts/`.
- Assistant-run summaries run in the background as non-streaming calls (`/v1/messages` or
  `/responses`) that reuse the exact credentials and headers of the request being served — no
  separate credential path.
- Put `[[better-compact:run]]` in the latest user prompt to compact immediately. The proxy removes
  the marker before forwarding the request. Claude Code can emit it from a command or skill
  prompt; Codex can emit it from a prompt file.

## Wire guarantees

These are pinned by the test suite, not aspirations:

- Request headers reach the upstream verbatim (`anthropic-beta`, `anthropic-version`, `x-api-key`,
  `authorization`, everything) — only `host` and body-framing headers are re-derived.
- The Anthropic `system` array and the Codex `instructions` field are never touched; the
  reference/summary injection is always a user-role message.
- The response is relayed byte-for-byte and unbuffered. Usage fields are read from the relayed
  stream (to feed the next request's trigger accounting) without modifying it.
- Failure posture: any internal error logs and forwards the original bytes unmodified, except that
  a recognized manual-trigger marker is still removed. Upstream errors pass through unchanged; a
  4xx after a rewrite dumps the rewritten body to
  `~/.better-compact/debug/` for fixturing. There is no retry-with-original.
- `cache_control` markers on pruned blocks migrate to the nearest surviving earlier block (or the
  synthetic replacement), and markers are excluded from message identity so a moved breakpoint
  never reads as an edited prefix.

## Configuration

`~/.better-compact/config.json`:

```json
{
    "anthropicUpstream": "https://api.anthropic.com",
    "openaiUpstream": "https://api.openai.com/v1",
    "openaiContextLimit": 400000,
    "preset": "light"
}
```

All optional. If you already pointed an agent at a gateway (`ANTHROPIC_BASE_URL` for Claude Code, a
custom `openai_base_url` for Codex), the installers record that URL here as the upstream, so the
gateway keeps working behind the proxy. `preset` is `light` (default), `moderate`, or `max`.
`openaiContextLimit` is an optional override for custom deployments or gateways whose model name
does not identify its window.

`better-compact start --capture` additionally writes incoming request bodies (bodies only —
headers, and with them credentials, are never written) to `~/.better-compact/captures/` for
building golden fixtures.

## Codex

```bash
better-compact install codex
```

This edits `~/.codex/config.toml`, setting `openai_base_url = "http://127.0.0.1:42817/openai"` (the
`/v1` lives in the upstream, so Codex's appended `/responses` lands on the proxy's rewrite route),
records any pre-existing custom `base_url` as the upstream, prints exactly what changed and how to
undo it, and starts the daemon. It edits the file conservatively (line-level, no TOML parser) and
refuses with manual instructions if it finds structures it cannot safely edit — the key nested in a
table, duplicated, or a custom `[model_providers.openai]` provider whose `base_url` would override
it.

**Native compaction is pre-empted structurally.** Codex's own compaction fires at 90% of the window
(with a 100% backstop) and cannot be disabled; it keys off API-reported usage, which behind the
proxy reflects the _pruned_ request. Our default 85% trigger therefore keeps Codex's gauge below 90%
permanently — pre-emption is a free consequence of the architecture, not a fought battle. The one
residual is a raw tail that alone exceeds 90% of the window; if you hit it, Codex's
user-customizable `compact_prompt` can be pointed at our transcript paths as a secondary mitigation
(the installer does not write it automatically).

## Honest limitations

- Anthropic context windows are inferred from the `anthropic-beta` header (`context-1m` → 1M,
  otherwise 200k). The OpenAI route resolves documented GPT-5 family windows from the request
  model ([models](https://developers.openai.com/api/docs/models),
  [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4),
  [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), and
  [GPT-5 chat](https://developers.openai.com/api/docs/models/gpt-5-chat-latest)). Unknown models
  start at the smallest plausible 128k window, while observed usage can raise that assumption for
  the session. Custom deployments can set `openaiContextLimit` explicitly.
- Session keys derived from the first user message/item assume that message is stable for the
  session — true for both agents, and a mismatch only costs a plan rebuild, never correctness.
- The Codex path is validated by the fake-upstream test suite and shape-verified against the Codex
  source; the OAuth/ChatGPT-auth live path and a full `codex exec` end-to-end run are noted where
  still unproven in this repo's Phase 4 report.
