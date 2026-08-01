import UIKit

enum PlatformFeedbackKind: Equatable, Sendable {
    case success
    case warning
    case error
}

struct PlatformThreadSignal: Equatable, Sendable {
    let kind: PlatformFeedbackKind
    let thread: FeatureThread
}

enum PlatformThreadTransitionClassifier {
    static func signals(
        previous: [String: FeatureThread]?,
        current: [FeatureThread]
    ) -> [PlatformThreadSignal] {
        guard let previous else { return [] }

        return current.compactMap { thread in
            guard let old = previous[thread.id], old.state != thread.state else { return nil }
            let kind: PlatformFeedbackKind? = switch thread.state {
            case .waitingForApproval, .waitingForInput:
                .warning
            case .failed:
                .error
            case .completed where old.state == .working || old.state == .queued:
                .success
            default:
                nil
            }
            return kind.map { PlatformThreadSignal(kind: $0, thread: thread) }
        }
    }
}

@MainActor
final class PlatformHapticEngine {
    static let shared = PlatformHapticEngine()

    func emit(_ kind: PlatformFeedbackKind, enabled: Bool) {
        guard enabled else { return }
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        switch kind {
        case .success:
            generator.notificationOccurred(.success)
        case .warning:
            generator.notificationOccurred(.warning)
        case .error:
            generator.notificationOccurred(.error)
        }
    }

    func selection(enabled: Bool) {
        guard enabled else { return }
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
    }
}
