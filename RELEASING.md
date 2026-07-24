# Releasing

Three packages publish to npm, each on its own tag, each through GitHub Actions
OIDC trusted publishing (no npm token or 2FA in CI).

## `better-compact` (the OpenCode plugin)

1. Bump `packages/opencode/package.json` `version`, commit, push to `master`.
2. Tag and push:
   ```bash
   git tag v0.2.1 && git push origin v0.2.1
   ```
   `.github/workflows/release.yml` verifies the tag matches the version, runs
   the full gate, smoke-installs the tarball through a real `opencode`, and
   publishes with provenance.

## `@better-compact/core` (the shared ladder)

1. Bump `packages/core/package.json` `version`, commit, push to `master`.
2. Tag and push with the `core-v` prefix:
   ```bash
   git tag core-v0.1.1 && git push origin core-v0.1.1
   ```
   `.github/workflows/release-core.yml` verifies the tag matches the version,
   runs typecheck + tests, then `pnpm pack`s the package (so `publishConfig`
   repoints `exports`/`main`/`types` at `dist`) and `npm publish`es that tarball
   with provenance.

### One-time trusted-publisher setup (required before the first CI core release)

`@better-compact/core@0.1.0` was published manually. For CI to publish future
versions without a token, configure a trusted publisher once on npmjs.com:

- npmjs.com → the `@better-compact/core` package → **Settings → Trusted Publishing**
- Add a **GitHub Actions** publisher:
  - Repository owner/name: `AshishKumar4/better-compact`
  - Workflow filename: `release-core.yml`

After that, a `core-v*` tag publishes core hands-off, the same way the plugin
already releases.

## `@better-compact/cli` (the Claude Code compaction CLI)

1. Bump `packages/cli/package.json` `version`, commit, push to `master`.
2. Tag and push with the `cli-v` prefix:
   ```bash
   git tag cli-v0.2.0 && git push origin cli-v0.2.0
   ```
   `.github/workflows/release-cli.yml` verifies the tag matches the version,
   runs typecheck + tests, builds and `pnpm pack`s the package, and `npm publish`es
   that tarball with provenance via the configured npmjs trusted publisher
   (GitHub Actions, workflow `release-cli.yml`) — no token or 2FA involved.

## One-time trusted-publisher setup (required before the first CI proxy release)

The first publish of `@better-compact/cli@0.1.0` must be manual from an
authenticated npm session. After it exists, configure a trusted publisher once
on npmjs.com so CI can publish future versions without a token:

- npmjs.com → the `@better-compact/cli` package → **Settings → Trusted Publishing**
- Add a **GitHub Actions** publisher:
  - Repository owner/name: `AshishKumar4/better-compact`
  - Workflow filename: `release-proxy.yml`

After that, subsequent `proxy-v*` tags publish the proxy tokenlessly with
provenance.
