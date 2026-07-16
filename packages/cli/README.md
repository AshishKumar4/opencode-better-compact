> This document is edited and maintained by Claude (Anthropic) and presented as-is.

# @better-compact/cli

I'm the Better Compact CLI. Two jobs, matched to what each platform actually allows:

- **Claude Code → on-disk session compaction** (`better-compact claude`). Claude Code enforces its
  context ceiling client-side and anchors its meter on token counts recorded inside the session
  transcript, so a wire proxy structurally cannot help it. Compacting the transcript on disk can,
  and does.
- **Codex → wire proxy** (`better-compact start` + `install codex`). A small local daemon on
  `openai_base_url` that prunes the request Codex is about to send. The `/anthropic` dialect also
  exists for gateway users, but it is no longer the Claude Code integration path.

## Claude Code: `better-compact claude`

```sh
better-compact claude [sessionId] [--resume] [--aggressive] [--from-backup] [--keep-tokens N]
better-compact claude --run [claude args...]
```

Compacts a **closed** session's transcript (`~/.claude/projects/<project>/<sessionId>.jsonl`) so it
reopens under the context limit. The default keeps **every message**: old tool outputs and oversized
tool inputs become short stubs (tool name, call id, and primary target preserved), old reasoning
blocks are dropped, and the recent tail (`--keep-tokens`, default 25k) stays verbatim. It also
zeroes the stale input-side token counts Claude Code seeds its context meter from — recorded usage
that describes requests which no longer exist (output tokens are kept). `--aggressive` instead
reproduces Claude Code's own `/compact` (append-only boundary + summary; old turns leave the
context). `--from-backup` restores the full history from the latest backup first. Every run backs
up the original to `~/.better-compact/claude-backups/` and refuses to touch a live session (registry
pid check plus a scan for still-starting `claude --resume` processes).

`--run` wraps `claude` so the `/better-compact:compact` command (from the companion plugin) can
queue a compaction: exit the session and it prunes and reopens automatically — no tmux, no wrapper
scripts.

## Codex proxy: what it does

- `better-compact start|stop|status` — a daemon on `127.0.0.1:42817` with a
  `~/.better-compact/proxy.json` `{port, pid}` lockfile. Start is idempotent; a foreign process on
  the port is a loud failure, never a silent degrade.
- `POST /anthropic/v1/messages` and `POST /openai/responses` are rewritten through the shared core
  ladder (old tools → reasoning → remaining tools → assistant-run summaries → last-resort prefix
  summary; the Anthropic dialect additionally prunes skills first). Everything else under `/anthropic/*` and
  `/openai/*` passes through untouched.
- Correlation: Anthropic dialect — the `x-session` header, else a content hash of the first user message.
  Codex — the `thread-id` header, else the body's `prompt_cache_key` (the thread id), else a content
  hash of the first user item. Plans persist under `~/.better-compact/plans/`, raw transcripts
  (cited by the injected reference message, readable by the agent's own Read/cat tool) under
  `~/.better-compact/transcripts/`.
- Assistant-run summaries run in the background as non-streaming calls (`/v1/messages` or
  `/responses`) that reuse the exact credentials and headers of the request being served — no
  separate credential path.
- Put `[[better-compact:run]]` in the latest user prompt to compact immediately. The proxy removes
  the marker before forwarding the request; Codex can emit it from a prompt file.

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

All optional. If you already pointed an agent at a gateway (a custom `openai_base_url` for Codex,
or `ANTHROPIC_BASE_URL` for an Anthropic-dialect client), the installers record that URL here as the upstream, so the
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
