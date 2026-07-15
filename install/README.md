> This document is edited and maintained by Claude (Anthropic) and presented as-is.

# Hosted installer

The installer works only after `@better-compact/cli` has been published to npm.

## Deploy

Authenticate Wrangler with the Cloudflare account that owns the active
`ashishkumarsingh.com` zone, then deploy from this directory:

```sh
cd install
wrangler deploy
```

To bind `better-compact.ashishkumarsingh.com` as the Worker's Custom Domain:

1. In the `ashishkumarsingh.com` zone's DNS records, remove any existing CNAME
   record for `better-compact.ashishkumarsingh.com`. Cloudflare cannot attach a
   Custom Domain over an existing CNAME.
2. Uncomment the `routes` block in `wrangler.jsonc`.
3. Run `wrangler deploy` from `install/` again.

Cloudflare creates the DNS record and managed certificate for the Custom Domain.
Do not create a separate DNS record for the hostname.

## Install Better Compact

Auto-detect installed Claude Code and Codex CLIs, configuring every one found:

```sh
curl -fsSL https://better-compact.ashishkumarsingh.com | sh
```

Or choose one explicitly:

```sh
curl -fsSL https://better-compact.ashishkumarsingh.com | sh -s -- claude-code
curl -fsSL https://better-compact.ashishkumarsingh.com | sh -s -- codex
```
