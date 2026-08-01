# T3 Code (SwiftUI)

A native SwiftUI client for T3 Code. The project targets iOS 17 and later on
iPhone and iPad. It has its own bundle identifier and can be installed beside the
React Native T3 Code app.

## Requirements

- A current Xcode release with an iOS Simulator runtime.
- iOS 17 or later for physical-device builds.
- A T3 pairing URL for direct connections. T3 Connect builds additionally need
  the cloud settings below.

## Open

Open `T3Code.xcodeproj`, choose the `T3Code` scheme, and run an installed iOS
Simulator. Xcode automatically includes files added below `App`, `Core`,
`Features`, `DesignSystem`, and `Resources`; `Info.plist` is the one resource
excluded from copying because it supplies the target's generated Info.plist.

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
  Keychain credentials, saved environment management, and optional T3 Connect
  account and relay discovery.
- A merged Web V2 home across saved environments, with per-device reachability,
  collision-safe identities, last-known rows, live active-device updates, and
  low-frequency passive refresh.
- Remote filesystem browsing, source discovery, repository cloning, project
  creation, plus thread search, creation, rename, archive, restore, delete,
  settle, and snooze.
- Provider/model selection, synchronized conversation history, rich Markdown,
  photo/camera/file image attachments, turn cancellation, approval decisions, and
  structured user-input requests.
- Workspace files and previews, working-tree review, Git status and common actions,
  plus an interactive terminal session scoped to each thread.
- Native settings with persisted appearance and behavior preferences, platform
  deep links, shortcuts, and local notification routing.

The app speaks the existing HTTP and Effect RPC WebSocket contracts directly. It
does not embed a JavaScript runtime.

## Build configuration

The project expands these user-defined Xcode build settings into its generated
Info.plist:

| Setting | Required | Purpose |
| --- | --- | --- |
| `T3CODE_CLERK_PUBLISHABLE_KEY` | T3 Connect only | Clerk publishable key. |
| `T3CODE_CLERK_JWT_TEMPLATE` | No | Relay JWT template; defaults to `t3-relay`. |
| `T3CODE_RELAY_URL` | T3 Connect only | Relay base URL using HTTPS. |
| `DEVELOPMENT_TEAM` | Device/archive | Apple Developer team used by automatic signing. |
| `PRODUCT_BUNDLE_IDENTIFIER` | No | Defaults to `com.t3tools.t3code.swiftui`. |
| `MARKETING_VERSION` | Release | User-facing version. |
| `CURRENT_PROJECT_VERSION` | Release | Monotonically increasing build number. |

Unset T3 Connect values disable that connection method without affecting direct
pairing. Supply settings on the `xcodebuild` command line or through a local
`.xcconfig`; do not commit private release configuration.

This app registers only the `t3code-swiftui` URL scheme so its routes do not
collide with another installed T3 Code client.

## Verify

Run the `T3Code` scheme's tests in Xcode, or use the same entry point as CI. It
chooses an available iPhone from the newest installed Simulator runtime:

```sh
./Scripts/ci-test.sh
```

Set `T3_SWIFT_SIMULATOR_ID` to pin a specific simulator. The path-filtered
`.github/workflows/swift-ios.yml` workflow runs this native unit-test target on
pull requests and pushes to `main` that change the Swift app.

## Install on a physical device

Enable Developer Mode on the device, connect and trust the Mac, then find its
identifier with `xcrun devicectl list devices`. Xcode must be signed into an Apple
Developer account for the requested team.

```sh
T3_SWIFT_DEVICE_ID="DEVICE-IDENTIFIER" \
T3_SWIFT_DEVELOPMENT_TEAM="TEAMID1234" \
./Scripts/install-device.sh
```

The script builds, provisions, installs, and launches the app. It accepts the T3
Connect build settings above as environment variables. Optional overrides are
`T3_SWIFT_BUNDLE_IDENTIFIER`, `T3_SWIFT_CONFIGURATION`,
`T3_SWIFT_DERIVED_DATA_PATH`, `T3_SWIFT_VERSION`, and
`T3_SWIFT_BUILD_NUMBER`.

## Release checklist

1. Set a unique `MARKETING_VERSION` and a higher `CURRENT_PROJECT_VERSION`.
2. Confirm the production bundle identifier, display name, app icon, signing team,
   and T3 Connect HTTPS relay configuration.
3. Run `./Scripts/ci-test.sh` and confirm the Swift iOS GitHub workflow is green.
4. Smoke-test direct URL and QR pairing, T3 Connect, multi-environment navigation,
   task creation, follow-up messages, attachments, approvals, input requests,
   background/reconnect behavior, and deep links on an iPhone and iPad.
5. If remote push is shipping, add the APNs entitlement and matching provisioning
   before archiving, then verify device-token registration end to end. Local
   notifications do not require that entitlement.
6. Archive the `T3Code` scheme in Release, run Xcode's Validate App and privacy
   report, and confirm `PrivacyInfo.xcprivacy` is bundled. Re-audit the manifest
   whenever code adds a Required Reason API or data collection.
7. Confirm `ITSAppUsesNonExemptEncryption = NO` remains accurate, then distribute
   an internal TestFlight build before App Store submission.
