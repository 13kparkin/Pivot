# Release Checklist

> For maintainers of this Pivot fork. End-user docs: [docs/user](../user/).

This document covers the unified release workflow for stable and nightly releases
on this repository (**desktop + CLI**). Hosted web (Vercel) and **T3 Connect** are
not part of this release path. Use local web (`pnpm run dev` / `npx t3`) instead.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push tag matching `v*.*.*` for stable releases
  - scheduled nightly check every three hours
  - manual `workflow_dispatch` for either channel
- Runs quality gates first in `preflight`:
  - `vp check`
  - `vp run typecheck`
  - `vp run test`
- Builds four desktop artifacts in parallel:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
- Includes Electron auto-update metadata (`latest*.yml` / `nightly*.yml`, `*.blockmap`).
- Publishes the CLI package (`apps/server`, npm package `pivot-cli`) with OIDC trusted publishing:
  - stable → npm dist-tag `latest`
  - nightly → npm dist-tag `nightly`
- Signing is optional and auto-detected per platform from secrets (unsigned is fine for tester channels).

## Not in this release path

- **Hosted web / Vercel** — not deployed. Local web only.
- **T3 Connect** — public config left unset. Local / LAN / Tailscale pairing still works.
  `.github/workflows/deploy-relay.yml` is disabled.
- **Discord announce** — removed; this fork is not on the upstream T3 Discord.

## Required credentials

### GitHub Actions secrets (stable finalize only)

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`  
  Used by `finalize` to commit aligned package versions to `main`. Nightlies skip finalize.

### GitHub Actions variables (optional)

- `T3CODE_DESKTOP_UPDATE_REPOSITORY`: `owner/repo` for this fork (auto-update feed).
  If unset, the workflow falls back to `github.repository`.

### npm OIDC trusted publishing

Configure the `pivot-cli` package Trusted Publisher for this repository and
`.github/workflows/release.yml`. No classic `NPM_TOKEN` is required.

## Nightly builds

- Triggers: schedule every three hours, or `workflow_dispatch` with `channel=nightly`
- Same quality gates and desktop matrix as stable
- GitHub prerelease tag: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
- CLI npm dist-tag: `nightly`
- Does not commit version bumps to `main`
- `finalize` is skipped (stable-only; see below)

## Stable builds

- Push tag `vX.Y.Z`, or `workflow_dispatch` with `channel=stable` and `version`
- CLI npm dist-tag: `latest`
- `finalize` may commit `chore(release): prepare vX.Y.Z` to `main`

## Server self-update invariant

Connected servers update to the client's exact version. Ordering in the
workflow:

1. `publish_cli` publishes `pivot-cli@<version>`
2. `release` publishes desktop artifacts

Preserve that order. Smoke test: `npm view pivot-cli@<version> version`.

## Desktop auto-update

- Provider: GitHub Releases
- Repository slug: `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY`
- Required assets: installers, channel `*.yml`, `*.blockmap`

## Cut a release

1. Ensure `main` is green.
2. Nightly: Actions → Release → Run workflow → `channel=nightly`.
3. Stable: tag `vX.Y.Z` and push (or dispatch with version).
4. Verify: preflight (`check` / `typecheck` / `test`), matrix builds, `publish_cli`,
   GitHub Release assets.

## Optional later

- Hosted web on Vercel
- Apple / Windows code signing
- Own T3 Connect relay
