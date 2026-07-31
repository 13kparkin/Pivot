# T3 Code for iOS

A dependency-free, native SwiftUI client for T3 Code. The project targets iOS 17
and later on iPhone and iPad.

## Open

Open `T3Code.xcodeproj`, choose the `T3Code` scheme, and run an installed iOS
simulator. Xcode automatically includes Swift files added below `App`, `Core`,
`Features`, and `DesignSystem`.

Pair with the same URL produced by a T3 server. The one-time pairing credential is
exchanged for an access token and stored in the Keychain. Environment metadata and
the active selection are stored separately in Application Support.

## Structure

- `App` owns the app lifecycle and the thin root composition seam.
- `Core` owns persistence, credentials, transport, and the T3 protocol.
- `Features` owns onboarding, environments, threads, messages, and settings.
- `DesignSystem` contains the small set of shared visual tokens.
- `Resources` contains the asset catalog.
- `Tests` covers pairing, wire contracts, persistence, and feature state changes.

`RootView` deliberately accepts any SwiftUI content. Production composition injects
`FeatureRootView(client:)` there, keeping protocol adapters out of the UI shell.

## Included

- Local-network preflight, direct pairing links, QR scanning, token exchange,
  Keychain credentials, and saved environment management.
- A merged Web V2 home across saved environments, with per-device reachability,
  last-known rows, live active-device updates, and low-frequency passive refresh.
- Server-side project creation from a known workspace path, plus thread search,
  creation, rename, archive, restore, delete, settle, snooze, runtime mode, and
  interaction mode.
- Provider/model selection, synchronized conversation history, rich Markdown,
  photo/camera/file image attachments, turn cancellation, approval decisions, and
  structured user-input requests.
- Workspace files and previews, working-tree review, Git status and common actions,
  plus an interactive terminal session scoped to each thread.
- Native settings with persisted appearance and behavior preferences.

The app speaks the existing HTTP and Effect RPC WebSocket contracts directly. No
JavaScript runtime or third-party package is embedded.

## Current gaps

- T3 Connect account sign-in, managed relay environment discovery, and push/live
  activity registration are not implemented. Pairing is direct to an environment.
- Adding a project requires entering a path that exists on the server. Remote
  filesystem browsing, repository cloning, and source-control account discovery are
  not implemented yet.
- The active environment uses the reconnecting WebSocket stream with HTTP polling
  as a fallback. Other environments refresh every 20 seconds, so their home rows
  can lag briefly. Last-known passive rows are retained in memory, not across a
  cold app launch, and passive archived history is not fetched proactively.
- Notification deep links are not implemented. Source-control status currently
  reflects changed paths but the server response does not distinguish staged files
  or individual change kinds.

## Verify

Run the `T3Code` scheme's tests in Xcode, or use:

```sh
xcodebuild test \
  -project T3Code.xcodeproj \
  -scheme T3Code \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```
