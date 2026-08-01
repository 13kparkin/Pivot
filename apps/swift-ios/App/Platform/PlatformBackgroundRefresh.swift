import BackgroundTasks
import Foundation

@MainActor
final class PlatformBackgroundRefreshCoordinator {
    typealias RefreshAction = @MainActor @Sendable () async -> Bool

    static let shared = PlatformBackgroundRefreshCoordinator()
    static var identifier: String {
        "\(Bundle.main.bundleIdentifier ?? "com.t3tools.t3code.swiftui").refresh"
    }

    private var refreshAction: RefreshAction?
    private var isRegistered = false

    func install(refreshAction: @escaping RefreshAction) {
        self.refreshAction = refreshAction
    }

    func register() {
        guard !isRegistered else { return }
        isRegistered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.identifier,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { @MainActor in
                await Self.shared.handle(refreshTask)
            }
        }
    }

    func schedule() {
        guard isRegistered else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.identifier)
        request.earliestBeginDate = Date().addingTimeInterval(
            PlatformBackgroundRefreshPolicy.minimumDelay
        )
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handle(_ task: BGAppRefreshTask) async {
        schedule()
        guard let refreshAction else {
            task.setTaskCompleted(success: false)
            return
        }

        let operation = Task { @MainActor in
            await refreshAction()
        }
        task.expirationHandler = {
            operation.cancel()
        }
        let succeeded = await operation.value
        task.setTaskCompleted(success: succeeded && !operation.isCancelled)
    }
}

enum PlatformBackgroundRefreshPolicy {
    /// iOS chooses the actual cadence. Fifteen minutes is merely the earliest
    /// useful retry and avoids repeatedly asking the scheduler for immediate work.
    static let minimumDelay: TimeInterval = 15 * 60
}
