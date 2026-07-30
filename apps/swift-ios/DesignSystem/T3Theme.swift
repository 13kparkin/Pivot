import SwiftUI

enum T3Colors {
    static let background = Color.black
    static let surface = Color(white: 0.055)
    static let surfaceRaised = Color(white: 0.09)
    static let input = Color(white: 0.075)
    static let border = Color.white.opacity(0.09)
    static let separator = Color.white.opacity(0.07)

    static let textPrimary = Color.white
    static let textSecondary = Color.white.opacity(0.62)
    static let textTertiary = Color.white.opacity(0.4)

    static let accent = Color(red: 0.04, green: 0.52, blue: 1)
    static let success = Color(red: 0.19, green: 0.82, blue: 0.35)
    static let warning = Color(red: 1, green: 0.62, blue: 0.04)
    static let danger = Color(red: 1, green: 0.27, blue: 0.23)
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
