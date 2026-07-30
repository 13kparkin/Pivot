import SwiftUI

public struct FeatureRootView: View {
    @State private var model: FeatureRootModel

    public init(client: any FeatureClient) {
        _model = State(initialValue: FeatureRootModel(client: client))
    }

    public var body: some View {
        Group {
            if model.isLoading {
                FeatureLoadingView()
            } else if model.snapshot.connection.state != .disconnected {
                WorkspaceView(
                    model: model,
                    submitNewTask: { request in
                        await model.startTask(request)
                    },
                    submitMessage: { submission in
                        await model.sendMessage(submission)
                    }
                )
            } else {
                ConnectionOnboardingView(model: model)
            }
        }
        .preferredColorScheme(model.snapshot.settings.appearance == .dark ? .dark : nil)
        .tint(.white)
        .background(Color.black.ignoresSafeArea())
        .task { await model.start() }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            ),
            actions: {
                Button("OK") { model.errorMessage = nil }
            },
            message: {
                Text(model.errorMessage ?? "Unknown error")
            }
        )
    }
}

private struct FeatureLoadingView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
                .font(.system(size: 30, weight: .semibold))
            ProgressView()
                .controlSize(.small)
            Text("Connecting to T3 Code")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .accessibilityElement(children: .combine)
    }
}
