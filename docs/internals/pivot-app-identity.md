# Pivot app identity

Canonical product identity for Pivot (desktop, mobile, CLI). Replaces upstream T3 Code store / Expo / deep-link IDs.

## Status

**Deferred.** Desktop + CLI ship first. Store mobile tracked here:

- iOS: https://github.com/13kparkin/Pivot/issues/3
- Android: https://github.com/13kparkin/Pivot/issues/4

Do not auto-run EAS production on `main` until those land (`mobile-eas-production.yml` is `workflow_dispatch` only for now).

Expo project already created: `30fefeda-e812-4912-8d34-b31fa5e00839` (wired in `apps/mobile/app.config.ts`).

## Locked identity

| Field                                                | Value                                  |
| ---------------------------------------------------- | -------------------------------------- |
| Product name                                         | **Pivot**                              |
| Short pitch                                          | T3.14 — T3 Code, pivoted to omp        |
| Legal / seller (placeholder until you set a company) | Kyle Parkin (`13kparkin`)              |
| Reverse-DNS root                                     | `com.13kparkin.pivot`                  |
| Expo slug                                            | `pivot`                                |
| Expo owner                                           | _(your Expo account — create / claim)_ |
| URL schemes                                          | `pivot`, `pivot-dev`, `pivot-preview`  |
| Desktop schemes                                      | same as above                          |
| CLI                                                  | `pivot` / `pivot-cli` (already)        |
| GitHub                                               | `https://github.com/13kparkin/Pivot`   |

### Mobile variants

| Variant     | Display name  | iOS bundle ID                 | Android package               | Scheme          |
| ----------- | ------------- | ----------------------------- | ----------------------------- | --------------- |
| development | Pivot Dev     | `com.13kparkin.pivot.dev`     | `com.13kparkin.pivot.dev`     | `pivot-dev`     |
| preview     | Pivot Preview | `com.13kparkin.pivot.preview` | `com.13kparkin.pivot.preview` | `pivot-preview` |
| production  | Pivot         | `com.13kparkin.pivot`         | `com.13kparkin.pivot`         | `pivot`         |

### Related IDs (fill when accounts exist)

| Field                                 | Status                                                                |
| ------------------------------------- | --------------------------------------------------------------------- |
| Expo project ID                       | `30fefeda-e812-4912-8d34-b31fa5e00839`                                |
| EAS updates URL                       | `https://u.expo.dev/30fefeda-e812-4912-8d34-b31fa5e00839`             |
| Apple Team ID                         | TBD — Membership details; set env `APPLE_TEAM_ID`                     |
| App Store Connect app ID (`ascAppId`) | TBD — create new app, not T3’s                                        |
| Google Play                           | **Deferred** — Android package IDs kept in config; Play Console later |
| Clerk / cloud / T3 Connect            | out of scope for v1 unless you stand up your own                      |

### Explicitly retired (do not reuse)

- Names: `T3 Code`, `T3 Code Dev`, `T3 Code Preview`
- Bundles: `com.t3tools.t3code*`
- Schemes: `t3code*`
- Expo: owner `pingdotgg`, slug `t3-code`, project `d763fcb8-…`
- Apple Team `ARK85ZXQ4Z`, ASC app `6787819824`
- Relying party `clerk.t3.codes` (until you own auth)

## Brand assets

Reuse the existing `assets/{dev,nightly,prod}` icon pipeline for now; rename display strings first. Later: replace mark/colors with Pivot-specific art (π / omp cue optional). Widget copy should say “Pivot agents”, not “T3 Code agents”.

## Why this DNS shape

No custom domain is required. `com.13kparkin.pivot` is a stable reverse-DNS rooted in the GitHub account that owns the product. If you later buy a domain (e.g. `pivot.sh`), you can migrate bundle IDs only with a **new** store listing — treat today’s IDs as permanent unless you accept that cost.

## Step-by-step (do in order)

### Phase A — Accounts (you, outside the repo)

1. Apple Developer Program enrollment (paid).
2. Google Play Console enrollment (paid one-time).
3. Expo account at https://expo.dev — org or personal under `13kparkin`.
4. Create empty App Store Connect app named **Pivot** (bundle ID `com.13kparkin.pivot`).
5. Create Play Console app **Pivot** (package `com.13kparkin.pivot`).

### Phase B — Repo identity rewire (code)

6. Update `apps/mobile/app.config.ts` to the Locked identity table (names, bundles, schemes, owner/slug placeholders, clear T3 `appleTeamId` / updates URL / projectId until EAS init).
7. Update `apps/mobile/eas.json` — remove T3 `ascAppId`; leave submit block for after ASC app exists.
8. Update deep-link / pairing scheme references (`t3code:` → `pivot:`) on mobile + desktop protocol constants.
9. Update desktop display branding (`T3 Code` → `Pivot`) where users see it (productName, APP_BASE_NAME, menus).
10. Fix CI: GitHub-hosted runners for EAS production (already drafted on this branch); add fork `EXPO_TOKEN` secret later.
11. Smoke: local `APP_VARIANT=development` prebuild shows Pivot Dev + new bundle ID.

### Phase C — Expo / EAS (you + CLI)

12. `cd apps/mobile && eas init` — creates **your** project; paste projectId + updates URL into `app.config.ts`.
13. `eas credentials` — generate iOS + Android creds under **your** Apple/Google accounts (not T3’s).
14. Add GitHub secret `EXPO_TOKEN` for this fork.
15. First internal builds: `eas build --profile preview` (or development client) for device testing.
16. Pair Pivot desktop ↔ Pivot mobile over LAN/Tailscale; confirm control works.

### Phase D — Store submit

17. Fill ASC metadata (screenshots, privacy, age rating). Use showcase workflow once branding assets exist.
18. `eas build --profile production` + submit iOS TestFlight / Play internal.
19. External TestFlight / Play testing → production release when ready.

### Phase E — Optional later

20. Custom icons / splash for Pivot.
21. Own Clerk (or drop cloud auth) if you want hosted pairing / cloud environments.
22. Detach GitHub fork network when ready (separate from store identity).

## Out of scope for “ship mobile control”

- Reusing T3 App Store binary
- Reusing T3 Expo project or ASC app ID
- T3 Connect relay (not required for LAN/Tailscale control)
