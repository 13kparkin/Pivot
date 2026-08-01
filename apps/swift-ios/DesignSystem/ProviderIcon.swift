import SwiftUI

enum ProviderBrand: String {
    case openAI = "ProviderOpenAI"
    case claude = "ProviderClaude"
    case cursor = "ProviderCursor"
    case grok = "ProviderGrok"
    case openCode = "ProviderOpenCode"

    static func resolve(driver: String, providerID: String) -> ProviderBrand? {
        for value in [driver, providerID] {
            switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "codex", "openai":
                return .openAI
            case "claudeagent", "claude":
                return .claude
            case "cursor":
                return .cursor
            case "grok":
                return .grok
            case "opencode":
                return .openCode
            default:
                continue
            }
        }
        return nil
    }
}

/// Displays the same provider artwork used by the web and marketing surfaces.
/// Unknown provider instances retain a compact initial so custom adapters remain legible.
struct ProviderIcon: View {
    let driver: String
    let providerID: String
    let fallbackName: String
    let size: CGFloat

    var body: some View {
        Group {
            if let brand = ProviderBrand.resolve(driver: driver, providerID: providerID) {
                Image(brand.rawValue)
                    .resizable()
                    .renderingMode(.original)
                    .scaledToFit()
            } else {
                Text(fallbackInitial)
                    .font(.system(size: max(9, size * 0.44), weight: .bold))
                    .foregroundStyle(T3Colors.textPrimary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(
                        T3Colors.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: max(4, size * 0.22))
                    )
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var fallbackInitial: String {
        fallbackName.trimmingCharacters(in: .whitespacesAndNewlines)
            .first
            .map { String($0).uppercased() } ?? "?"
    }
}
