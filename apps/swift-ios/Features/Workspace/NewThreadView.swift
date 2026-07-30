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
        NavigationStack {
            VStack(spacing: 0) {
                contextBar
                Divider()
                    .overlay(T3Colors.separator)

                ZStack(alignment: .topLeading) {
                    if prompt.isEmpty {
                        Text("What do you want to build?")
                            .font(.title3)
                            .foregroundStyle(T3Colors.textTertiary)
                            .padding(.horizontal, 17)
                            .padding(.top, 17)
                            .allowsHitTesting(false)
                    }

                    TextEditor(text: $prompt)
                        .font(.title3)
                        .lineSpacing(3)
                        .scrollContentBackground(.hidden)
                        .focused($promptFocused)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .accessibilityLabel("Task")
                }

                VStack(spacing: 9) {
                    FeatureAttachmentStrip(attachments: $attachments)

                    HStack(spacing: 8) {
                        FeatureImageAttachmentPicker(
                            attachments: $attachments,
                            isEnabled: DailyUXModelOptions.supportsImages(
                                selection: selection,
                                providers: model.snapshot.providers
                            )
                        )

                        if !attachments.isEmpty, !imagesAllowed {
                            Text("Choose an image model")
                                .font(.caption)
                                .foregroundStyle(T3Colors.warning)
                        } else if !attachments.isEmpty {
                            Text("\(attachments.count) selected")
                                .font(.caption)
                                .foregroundStyle(T3Colors.textSecondary)
                        }

                        Spacer()

                        Button(action: startTask) {
                            HStack(spacing: 7) {
                                if isSubmitting {
                                    ProgressView()
                                        .controlSize(.small)
                                        .tint(.black)
                                } else {
                                    Text("Start task")
                                    Image(systemName: "arrow.up")
                                        .font(.system(size: 13, weight: .bold))
                                }
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 16)
                            .frame(height: 40)
                            .background(.white, in: RoundedRectangle(cornerRadius: 10))
                        }
                        .disabled(!canSubmit)
                        .opacity(canSubmit ? 1 : 0.35)
                        .accessibilityLabel(isSubmitting ? "Starting task" : "Start task")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 10)
                .background(T3Colors.background)
                .overlay(alignment: .top) {
                    Divider().overlay(T3Colors.separator)
                }
            }
            .background(T3Colors.background)
            .navigationTitle("New task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
            }
            .t3NavigationChrome()
            .onAppear {
                if projectID.isEmpty {
                    projectID = model.snapshot.projects.first?.id ?? ""
                }
                if selection == nil {
                    selection = DailyUXModelOptions.validated(
                        model.snapshot.settings.defaultSelection,
                        in: model.snapshot.providers
                    )
                        ?? DailyUXModelOptions.preferredSelection(in: model.snapshot.providers)
                }
                promptFocused = true
            }
            .alert("Couldn’t start task", isPresented: $submissionFailed) {
                Button("OK") {}
            } message: {
                Text("Check your connection and try again.")
            }
        }
        .interactiveDismissDisabled(isSubmitting)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }

    private var contextBar: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 18) {
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
                    contextLabel(
                        icon: "folder",
                        title: selectedProject?.name ?? "Choose project"
                    )
                }

                ProviderModelPicker(
                    providers: model.snapshot.providers,
                    selection: $selection,
                    style: .compact,
                    isLoading: model.isLoading
                )

                Menu {
                    Section("Interaction") {
                        Button {
                            interactionMode = .standard
                        } label: {
                            modeLabel("Build", selected: interactionMode == .standard)
                        }
                        Button {
                            interactionMode = .plan
                        } label: {
                            modeLabel("Plan", selected: interactionMode == .plan)
                        }
                    }

                    Section("Access") {
                        ForEach(FeatureRuntimeMode.allCases, id: \.self) { mode in
                            Button {
                                runtimeMode = mode
                            } label: {
                                modeLabel(runtimeLabel(mode), selected: runtimeMode == mode)
                            }
                        }
                    }
                } label: {
                    contextLabel(
                        icon: interactionMode == .plan ? "list.bullet.clipboard" : "bolt",
                        title: interactionMode == .plan ? "Plan" : runtimeShortLabel
                    )
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
        }
        .scrollIndicators(.hidden)
    }

    private var selectedProject: FeatureProject? {
        model.snapshot.projects.first { $0.id == projectID }
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

    private var runtimeShortLabel: String {
        switch runtimeMode {
        case .approvalRequired: "Ask"
        case .autoAcceptEdits: "Edits"
        case .automatic: "Automatic"
        case .fullAccess: "Full access"
        }
    }

    private func contextLabel(icon: String, title: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
            Text(title)
                .lineLimit(1)
            Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .bold))
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(T3Colors.textSecondary)
        .contentShape(Rectangle())
    }

    private func modeLabel(_ title: String, selected: Bool) -> some View {
        Group {
            if selected {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private func runtimeLabel(_ mode: FeatureRuntimeMode) -> String {
        switch mode {
        case .approvalRequired: "Ask before changes"
        case .autoAcceptEdits: "Auto-accept edits"
        case .automatic: "Automatic"
        case .fullAccess: "Full access"
        }
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
