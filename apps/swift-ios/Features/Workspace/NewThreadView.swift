import SwiftUI

public struct NewThreadView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let submit: (NewTaskRequest) async -> FeatureThread?
    let onCreated: (FeatureThread) -> Void

    @State private var projectID = ""
    @State private var prompt = ""
    @State private var selection: FeatureSelection?
    @State private var runtimeMode: FeatureRuntimeMode = .fullAccess
    @State private var interactionMode: FeatureInteractionMode = .standard
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var isSubmitting = false
    @State private var submissionFailed = false
    @FocusState private var promptFocused: Bool

    public init(
        model: FeatureRootModel,
        submit: @escaping (NewTaskRequest) async -> FeatureThread?,
        onCreated: @escaping (FeatureThread) -> Void
    ) {
        self.model = model
        self.submit = submit
        self.onCreated = onCreated
    }

    public var body: some View {
        ZStack {
            T3Colors.background.ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                hero
                    .padding(.top, 82)
                Spacer(minLength: 140)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            FeatureComposerView(
                text: $prompt,
                selection: $selection,
                attachments: $attachments,
                providers: model.snapshot.providers,
                threadSelection: initialSelection,
                isSending: isSubmitting,
                isWorking: false,
                focused: $promptFocused,
                onSend: startTask,
                onStop: {},
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                forceExpanded: true,
                onRuntimeModeChange: { runtimeMode = $0 },
                onInteractionModeChange: { interactionMode = $0 }
            )
        }
        .onAppear {
            if projectID.isEmpty {
                projectID = model.snapshot.projects.first?.id ?? ""
            }
            if selection == nil {
                selection = initialSelection
            }
        }
        .onChange(of: projectID) {
            selection = initialSelection
        }
        .alert("Couldn’t start task", isPresented: $submissionFailed) {
            Button("OK") {}
        } message: {
            Text("Check your connection and try again.")
        }
        .interactiveDismissDisabled(isSubmitting)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }

    private var topBar: some View {
        HStack {
            Button("Cancel") { dismiss() }
                .font(.body)
                .foregroundStyle(T3Colors.textSecondary)
                .disabled(isSubmitting)
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 48)
    }

    private var hero: some View {
        VStack(spacing: 10) {
            Text("What should we build")
            HStack(spacing: 3) {
                Text("in")
                Menu {
                    ForEach(model.snapshot.projects) { project in
                        Button {
                            projectID = project.id
                        } label: {
                            if project.id == projectID {
                                Label(project.name, systemImage: "checkmark")
                            } else {
                                Text(project.name)
                            }
                        }
                    }
                } label: {
                    Text(selectedProject?.name ?? "a project")
                        .foregroundStyle(T3Colors.textPrimary)
                        .overlay(alignment: .bottom) {
                            DottedUnderline()
                                .stroke(
                                    T3Colors.textPrimary.opacity(0.58),
                                    style: StrokeStyle(lineWidth: 1, dash: [2, 3])
                                )
                                .frame(height: 1)
                                .offset(y: 3)
                        }
                }
                .buttonStyle(.plain)
                Text("?")
                    .offset(x: -1)
            }
        }
        .font(.system(size: 24, weight: .regular))
        .tracking(-0.35)
        .foregroundStyle(T3Colors.textPrimary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .bottom) {
            HStack(spacing: 6) {
                Image(systemName: "server.rack")
                    .font(.system(size: 11, weight: .medium))
                Text("on \(environmentName)")
            }
            .font(.caption)
            .foregroundStyle(T3Colors.textTertiary)
            .offset(y: 29)
        }
        .accessibilityElement(children: .contain)
    }

    private var selectedProject: FeatureProject? {
        model.snapshot.projects.first { $0.id == projectID }
    }

    private var environmentName: String {
        if let environmentID = selectedProject?.environmentID,
           let environment = model.snapshot.environments.first(where: { $0.id == environmentID }) {
            return environment.name
        }
        return model.snapshot.connection.environmentName ?? "this server"
    }

    private var initialSelection: FeatureSelection? {
        DailyUXModelOptions.initialSelection(
            projectDefault: selectedProject?.defaultSelection,
            appDefault: model.snapshot.settings.defaultSelection,
            providers: model.snapshot.providers
        )
    }

    private var canSubmit: Bool {
        !isSubmitting
            && !projectID.isEmpty
            && (!trimmedPrompt.isEmpty || !attachments.isEmpty)
            && (attachments.isEmpty || imagesAllowed)
    }

    private var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var imagesAllowed: Bool {
        DailyUXModelOptions.supportsImages(
            selection: selection,
            providers: model.snapshot.providers
        )
    }

    private func startTask() {
        guard canSubmit else { return }
        promptFocused = false
        isSubmitting = true
        let request = NewTaskRequest(
            projectID: projectID,
            prompt: trimmedPrompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            attachments: attachments
        )

        Task {
            if let thread = await submit(request) {
                onCreated(thread)
            } else {
                isSubmitting = false
                submissionFailed = true
                promptFocused = true
            }
        }
    }
}

private struct DottedUnderline: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}
