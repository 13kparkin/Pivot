import SwiftUI

struct PlatformRootView: View {
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @Bindable private var model: FeatureRootModel

    @State private var navigationRequest: FeatureWorkspaceNavigationRequest?
    @State private var pendingRoute: PlatformRoute?
    @State private var previousThreads: [String: FeatureThread]?
    @State private var lastNotificationPreference: Bool?

    init(model: FeatureRootModel) {
        self.model = model
    }

    var body: some View {
        FeatureRootView(
            model: model,
            navigationRequest: navigationRequest,
            onNavigationRequestConsumed: { requestID in
                guard navigationRequest?.id == requestID else { return }
                navigationRequest = nil
            }
        )
        .onOpenURL { url in
            handle(url: url, letOnboardingConfirmConnection: true)
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL else { return }
            handle(url: url, letOnboardingConfirmConnection: false)
        }
        .onReceive(NotificationCenter.default.publisher(for: .platformRouteReceived)) { note in
            guard let route = note.userInfo?["route"] as? PlatformRoute else { return }
            _ = PlatformRouteMailbox.shared.take()
            handle(route)
        }
        .onChange(of: model.isLoading, initial: true) { _, isLoading in
            guard !isLoading else { return }
            processThreadChanges()
            synchronizeNotificationPreference()
            consumePendingRouteIfPossible()
            consumeMailboxRouteIfAvailable()
        }
        .onChange(of: model.homePresentationRevision) { _, _ in
            processThreadChanges()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                consumeMailboxRouteIfAvailable()
                synchronizeNotificationPreference()
            }
        }
        .onChange(of: model.snapshot.settings.notificationsEnabled) { _, _ in
            synchronizeNotificationPreference()
        }
    }

    private var shouldShowWorkspace: Bool {
        FeatureRootPresentation.showsWorkspace(
            snapshot: model.snapshot,
            isManagingConnections: model.isManagingConnections
        )
    }

    private func handle(url: URL, letOnboardingConfirmConnection: Bool) {
        do {
            let route = try PlatformDeepLinkParser.parse(url)
            if case .connection = route,
               letOnboardingConfirmConnection,
               !shouldShowWorkspace {
                // ConnectionOnboardingView owns the confirmation UI for cold pairing links.
                return
            }
            handle(route)
        } catch {
            model.errorMessage = error.localizedDescription
        }
    }

    private func handle(_ route: PlatformRoute) {
        guard !model.isLoading else {
            pendingRoute = route
            return
        }
        Task { @MainActor in
            await consume(route)
        }
    }

    private func consumePendingRouteIfPossible() {
        guard let route = pendingRoute else { return }
        pendingRoute = nil
        handle(route)
    }

    private func consumeMailboxRouteIfAvailable() {
        guard !model.isLoading, let route = PlatformRouteMailbox.shared.take() else { return }
        handle(route)
    }

    private func synchronizeNotificationPreference() {
        guard !model.isLoading else { return }
        let preference = model.snapshot.settings.notificationsEnabled
        let previous = lastNotificationPreference
        lastNotificationPreference = preference

        Task {
            let authorized: Bool
            if preference, previous == false {
                // The model changes only after Settings is explicitly saved.
                authorized = await PlatformNotificationService.shared.requestAuthorization()
            } else {
                authorized = await PlatformNotificationService.shared.synchronize(enabled: preference)
            }
            guard preference, !authorized, model.snapshot.settings.notificationsEnabled else {
                return
            }

            // Keep the app toggle honest when authorization is absent or revoked.
            var settings = model.snapshot.settings
            settings.notificationsEnabled = false
            await model.saveSettings(settings)
        }
    }

    @MainActor
    private func consume(_ route: PlatformRoute) async {
        switch route {
        case let .connection(endpoint, token):
            if await model.pair(endpoint: endpoint, token: token) {
                PlatformHapticEngine.shared.emit(
                    .success,
                    enabled: model.snapshot.settings.hapticsEnabled
                )
            }
        case let .environment(id):
            guard await activateEnvironmentIfNeeded(id) else { return }
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .thread(environmentID, threadID):
            guard await activateEnvironmentIfNeeded(environmentID),
                  let thread = PlatformRouteResolver.thread(
                      in: model.snapshot,
                      environmentID: environmentID,
                      id: threadID
                  )
            else {
                if model.errorMessage == nil { model.errorMessage = "That thread is not available on this device." }
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .thread(id: thread.id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .project(environmentID, projectID):
            guard await activateEnvironmentIfNeeded(environmentID),
                  let project = PlatformRouteResolver.project(
                      in: model.snapshot,
                      environmentID: environmentID,
                      id: projectID
                  )
            else {
                if model.errorMessage == nil { model.errorMessage = "That project is not available on this device." }
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .project(id: project.id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .newTask(environmentID, projectID):
            guard await activateEnvironmentIfNeeded(environmentID) else { return }
            let resolvedProject = projectID.flatMap {
                PlatformRouteResolver.project(
                    in: model.snapshot,
                    environmentID: environmentID,
                    id: $0
                )
            }
            if projectID != nil, resolvedProject == nil {
                model.errorMessage = "That project is not available on this device."
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .newTask(projectID: resolvedProject?.id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        }
    }

    @MainActor
    private func activateEnvironmentIfNeeded(_ id: String?) async -> Bool {
        guard let id else { return true }
        guard let environment = model.snapshot.environments.first(where: { $0.id == id }) else {
            model.errorMessage = "That environment is not saved on this device."
            return false
        }
        guard !environment.isActive else { return true }
        await model.activateEnvironment(id)
        return model.snapshot.environments.contains { $0.id == id && $0.isActive }
    }

    /// Home revisions are coalesced by FeatureRootModel, so this performs one
    /// bounded scan per meaningful snapshot change rather than on every render.
    private func processThreadChanges() {
        let current = Dictionary(uniqueKeysWithValues: model.snapshot.threads.map { ($0.id, $0) })
        let signals = PlatformThreadTransitionClassifier.signals(
            previous: previousThreads,
            current: model.snapshot.threads
        )
        previousThreads = current
        PlatformRecentThreadStore.shared.update(from: model.snapshot.threads)

        for signal in signals {
            if scenePhase == .active {
                PlatformHapticEngine.shared.emit(
                    signal.kind,
                    enabled: model.snapshot.settings.hapticsEnabled
                )
            } else if model.snapshot.settings.notificationsEnabled {
                Task { await PlatformNotificationService.shared.schedule(signal) }
            }
        }
    }
}
