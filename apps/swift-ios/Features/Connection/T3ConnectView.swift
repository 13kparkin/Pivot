import ClerkKit
import ClerkKitUI
import SwiftUI

public struct T3ConnectView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var controller: T3ConnectController
    @State private var isAuthPresented = false
    @State private var didFinishInitialRefresh = false
    private let connectEnvironment:
        @MainActor (T3ConnectManagedEnvironmentCredential) async throws -> Void
    private let onConnected: @MainActor () async -> Void

    public init(
        capability: any T3ConnectCapable,
        onConnected: @escaping @MainActor () async -> Void = {}
    ) {
        controller = capability.t3ConnectController
        connectEnvironment = capability.connectT3Environment
        self.onConnected = onConnected
    }

    public var body: some View {
        content
            .navigationTitle("T3 Connect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if controller.account != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Sign out", role: .destructive) {
                            Task { await controller.signOut() }
                        }
                        .disabled(controller.isRefreshing)
                    }
                }
            }
            .refreshable {
                await controller.refresh()
            }
            .task {
                await controller.refresh()
                didFinishInitialRefresh = true
                presentAuthenticationIfNeeded()
            }
            .onChange(of: controller.account?.id) { _, accountID in
                guard didFinishInitialRefresh,
                      accountID == nil,
                      controller.unavailableReason == nil else { return }
                isAuthPresented = true
            }
            .fullScreenCover(
                isPresented: $isAuthPresented,
                onDismiss: handleAuthenticationDismissal
            ) {
                authenticationView
            }
            .alert(
                "T3 Connect",
                isPresented: Binding(
                    get: { controller.errorMessage != nil },
                    set: { if !$0 { controller.errorMessage = nil } }
                )
            ) {
                Button("OK") { controller.errorMessage = nil }
            } message: {
                Text(controller.errorMessage ?? "Something went wrong.")
            }
            .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var content: some View {
        if let reason = controller.unavailableReason {
            connectList {
                unavailableSection(reason)
            }
        } else if let account = controller.account {
            connectList {
                accountSection(account)
                environmentSection
            }
        } else {
            ZStack {
                Color.black.ignoresSafeArea()
                ProgressView()
                    .tint(.white)
            }
        }
    }

    private func connectList<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        List {
            content()
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.black)
    }

    @ViewBuilder
    private var authenticationView: some View {
        if let clerk = controller.clerk {
            AuthView(mode: .signInOrUp)
                .prefetchClerkImages()
                .environment(\.clerkTheme, T3ConnectClerkAppearance.theme)
                .environment(clerk)
                .preferredColorScheme(.dark)
        } else {
            ZStack {
                Color.black.ignoresSafeArea()
                ProgressView()
                    .tint(.white)
            }
        }
    }

    private func presentAuthenticationIfNeeded() {
        guard controller.unavailableReason == nil,
              controller.account == nil else { return }
        isAuthPresented = true
    }

    private func handleAuthenticationDismissal() {
        Task {
            await controller.refresh()
            if controller.account == nil {
                dismiss()
            }
        }
    }

    private func unavailableSection(_ reason: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                Label("Unavailable in this build", systemImage: "cloud.slash")
                    .font(T3Typography.homeTitle)
                Text(reason)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textSecondary)
                Text("Direct and local connections still work without an account.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .padding(.vertical, 8)
            .listRowBackground(Color.black)
        }
    }

    private func accountSection(_ account: T3ConnectAccount) -> some View {
        Section("Account") {
            HStack(spacing: 12) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.title2)
                    .foregroundStyle(T3Colors.textSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.email ?? "T3 account")
                        .font(T3Typography.homeTitle)
                    Text("Signed in")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            .padding(.vertical, 3)
            .listRowBackground(Color.black)
        }
    }

    private var environmentSection: some View {
        Section("Cloud environments") {
            if controller.environments.isEmpty, !controller.isRefreshing {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No linked environments")
                        .font(T3Typography.homeTitle)
                    Text("Link an environment from T3 Code on desktop, then pull to refresh.")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .padding(.vertical, 8)
                .listRowBackground(Color.black)
            }

            ForEach(controller.environments) { item in
                environmentRow(item)
                    .listRowBackground(Color.black)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await controller.unlink(item.environment) }
                        } label: {
                            Label("Unlink", systemImage: "link.badge.minus")
                        }
                    }
            }

            if controller.isRefreshing {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Refreshing environments…")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .listRowBackground(Color.black)
            }
        }
    }

    private func environmentRow(_ item: T3ConnectCloudEnvironment) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusColor(item))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.environment.label)
                    .font(T3Typography.homeTitle)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(statusText(item))
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Button {
                Task { await handleConnect(item.environment) }
            } label: {
                if controller.busyEnvironmentID == item.id {
                    ProgressView()
                        .frame(width: 54)
                } else {
                    Text("Connect")
                        .font(T3Typography.supportingStrong)
                }
            }
            .buttonStyle(.borderless)
            .disabled(controller.busyEnvironmentID != nil || item.status?.status == .offline)
        }
        .padding(.vertical, 5)
    }

    private func handleConnect(_ environment: T3ConnectRelayEnvironment) async {
        do {
            let credential = try await controller.credential(for: environment)
            try await connectEnvironment(credential)
            await onConnected()
        } catch {
            controller.errorMessage = error.localizedDescription
        }
    }

    private func statusText(_ item: T3ConnectCloudEnvironment) -> String {
        if let error = item.statusError { return error }
        switch item.status?.status {
        case .online: return "Online"
        case .offline: return item.status?.error ?? "Offline"
        case nil: return "Checking…"
        }
    }

    private func statusColor(_ item: T3ConnectCloudEnvironment) -> Color {
        switch item.status?.status {
        case .online: T3Colors.success
        case .offline: T3Colors.danger
        case nil: T3Colors.textTertiary
        }
    }
}

@MainActor
private enum T3ConnectClerkAppearance {
    static let theme = ClerkTheme(
        colors: .init(
            primary: .white,
            background: T3Colors.background,
            input: T3Colors.input,
            danger: T3Colors.danger,
            success: T3Colors.success,
            warning: T3Colors.warning,
            foreground: T3Colors.textPrimary,
            mutedForeground: T3Colors.textSecondary,
            primaryForeground: .black,
            inputForeground: T3Colors.textPrimary,
            neutral: .white,
            ring: .white,
            muted: T3Colors.surfaceRaised,
            shadow: .black,
            border: .white
        ),
        design: .init(borderRadius: 12)
    )
}
