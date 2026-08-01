import SwiftUI

public struct T3ConnectView: View {
    @Bindable private var controller: T3ConnectController
    private let connectEnvironment:
        @MainActor (T3ConnectManagedEnvironmentCredential) async throws -> Void

    public init(capability: any T3ConnectCapable) {
        controller = capability.t3ConnectController
        connectEnvironment = capability.connectT3Environment
    }

    public var body: some View {
        List {
            if let reason = controller.unavailableReason {
                unavailableSection(reason)
            } else if let account = controller.account {
                accountSection(account)
                environmentSection
            } else {
                signInSection
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.black)
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

    private var signInSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Text("Your environments, on every device.")
                    .font(T3Typography.homeTitle)
                Text("T3 Connect is optional. Sign in to reach environments linked to your T3 account.")
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .padding(.vertical, 8)
            .listRowBackground(Color.black)

            ForEach(T3ConnectSignInProvider.allCases) { provider in
                Button {
                    Task { await controller.signIn(with: provider) }
                } label: {
                    HStack {
                        Text(provider.title)
                            .font(T3Typography.homeTitle)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.body.weight(.semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.vertical, 6)
                }
                .disabled(controller.isRefreshing)
                .listRowBackground(Color.black)
            }

            if controller.isRefreshing {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Opening secure sign in…")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .listRowBackground(Color.black)
            }
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
