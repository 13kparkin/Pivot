import SwiftUI

enum T3Colors {
    static let background = Color.black
    static let surface = Color(white: 0.055)
    static let surfaceRaised = Color(white: 0.09)
    static let input = Color(white: 0.075)
    static let border = Color.white.opacity(0.09)
    static let separator = Color.white.opacity(0.07)
    static let ledgerSurface = Color(white: 0.055)
    static let ledgerSelected = Color(white: 0.051)

    static let textPrimary = Color.white
    static let textSecondary = Color.white.opacity(0.7)
    static let textTertiary = Color.white.opacity(0.57)

    static let accent = Color(red: 0.04, green: 0.52, blue: 1)
    static let statusRunning = Color(red: 0.13, green: 0.83, blue: 0.93)
    static let success = Color(red: 0.19, green: 0.82, blue: 0.35)
    static let warning = Color(red: 1, green: 0.62, blue: 0.04)
    static let danger = Color(red: 1, green: 0.27, blue: 0.23)
}

/// The native client uses semantic fonts so every surface follows Dynamic Type.
/// Keep roles here instead of introducing one-off point sizes in feature views.
enum T3Typography {
    static let homeTitle = Font.system(.body, design: .default, weight: .semibold)
    static let homeMetadata = Font.system(.footnote, design: .default)

    static let navigationTitle = Font.system(.headline, design: .default, weight: .semibold)
    static let navigationMetadata = Font.system(.footnote, design: .default)
    static let status = Font.system(.footnote, design: .default, weight: .semibold)

    static let threadBody = Font.system(.body, design: .default)
    static let threadHeading1 = Font.system(.title2, design: .default, weight: .bold)
    static let threadHeading2 = Font.system(.title3, design: .default, weight: .bold)
    static let threadHeading3 = Font.system(.headline, design: .default, weight: .bold)
    static let threadHeading4 = Font.system(.body, design: .default, weight: .semibold)
    static let code = Font.system(.callout, design: .monospaced)
    static let tool = Font.system(.footnote, design: .monospaced)

    static let composer = Font.system(.body, design: .default)
    static let control = Font.system(.callout, design: .default, weight: .medium)
    static let supporting = Font.system(.footnote, design: .default)
    static let supportingStrong = Font.system(.footnote, design: .default, weight: .semibold)
    static let eyebrow = Font.system(.footnote, design: .default, weight: .bold)
}

enum T3Metrics {
    static let minimumTapTarget: CGFloat = 44
    static let sidebarWidth: CGFloat = 320
    static let minimumSidebarWidth: CGFloat = 280
    static let maximumSidebarWidth: CGFloat = 380
    static let readingWidth: CGFloat = 760
}

extension View {
    func t3NavigationChrome() -> some View {
        toolbarBackground(T3Colors.background.opacity(0.97), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}
