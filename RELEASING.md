> This document is edited and maintained by Claude (Anthropic) and presented as-is.

# Releasing

Two packages publish to npm, each on its own tag, each through GitHub Actions
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
  - Repository owner/name: `AshishKumar4/opencode-better-compact`
  - Workflow filename: `release-core.yml`

After that, a `core-v*` tag publishes core hands-off, the same way the plugin
already releases.
