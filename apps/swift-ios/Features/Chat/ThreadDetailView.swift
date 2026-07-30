import SwiftUI

public struct ThreadDetailView: View {
    @Bindable var model: FeatureRootModel
    let thread: FeatureThread

    @State private var draft = ""
    @State private var selection: FeatureSelection?
    @State private var isSending = false
    @State private var isLoading = true
    @State private var toolSurface: FeatureThreadToolSurface?
    @FocusState private var composerFocused: Bool

    public init(model: FeatureRootModel, thread: FeatureThread) {
        self.model = model
        self.thread = thread
    }

    public var body: some View {
        Group {
            if isLoading, detail == nil {
                ProgressView("Loading thread…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let detail {
                timeline(detail)
            } else {
                ContentUnavailableView(
                    "Thread unavailable",
                    systemImage: "exclamationmark.bubble",
                    description: Text("The thread could not be loaded.")
                )
            }
        }
        .background(Color.black)
        .navigationTitle(detail?.thread.title ?? thread.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Section("Workspace") {
                        Button {
                            toolSurface = .files
                        } label: {
                            Label("Files", systemImage: "folder")
                        }
                        Button {
                            toolSurface = .review
                        } label: {
                            Label("Review changes", systemImage: "doc.text.magnifyingglass")
                        }
                        Button {
                            toolSurface = .sourceControl
                        } label: {
                            Label("Source Control", systemImage: "arrow.triangle.branch")
                        }
                        Button {
                            toolSurface = .terminal
                        } label: {
                            Label("Terminal", systemImage: "terminal")
                        }
                    }
                    Section("Interaction") {
                        Button {
                            Task {
                                await model.setInteractionMode(
                                    thread.id,
                                    mode: currentThread.interactionMode == .plan ? .standard : .plan
                                )
                            }
                        } label: {
                            Label(
                                currentThread.interactionMode == .plan
                                    ? "Use standard mode"
                                    : "Use plan mode",
                                systemImage: "list.bullet.clipboard"
                            )
                        }
                    }
                    Section("Access") {
                        ForEach(FeatureRuntimeMode.allCases, id: \.self) { mode in
                            Button {
                                Task { await model.setRuntimeMode(thread.id, mode: mode) }
                            } label: {
                                if currentThread.runtimeMode == mode {
                                    Label(runtimeModeLabel(mode), systemImage: "checkmark")
                                } else {
                                    Text(runtimeModeLabel(mode))
                                }
                            }
                        }
                    }
                    Section {
                    Button {
                        Task { _ = await model.detail(for: thread.id, force: true) }
                    } label: {
                        Label("Reload", systemImage: "arrow.clockwise")
                    }
                    Button {
                        Task {
                            await model.setArchived(thread.id, archived: !thread.isArchived)
                        }
                    } label: {
                        Label(
                            thread.isArchived ? "Restore" : "Archive",
                            systemImage: thread.isArchived
                                ? "arrow.uturn.backward"
                                : "archivebox"
                        )
                    }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("Thread actions")
            }
        }
        .task(id: thread.id) {
            isLoading = true
            _ = await model.detail(for: thread.id)
            selection = currentSelection
            isLoading = false
        }
        .sheet(item: $toolSurface) { surface in
            NavigationStack {
                switch surface {
                case .files:
                    FeatureFilesView(client: model.client, threadID: thread.id)
                case .review:
                    FeatureReviewView(client: model.client, threadID: thread.id)
                case .sourceControl:
                    FeatureSourceControlView(client: model.client, threadID: thread.id)
                case .terminal:
                    FeatureTerminalView(client: model.client, threadID: thread.id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        toolSurface = nil
                    }
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

    private var detail: FeatureThreadDetail? {
        model.details[thread.id]
    }

    private var currentThread: FeatureThread {
        detail?.thread ?? thread
    }

    private var currentSelection: FeatureSelection? {
        guard let providerID = detail?.thread.providerID ?? thread.providerID,
              let modelID = detail?.thread.modelID ?? thread.modelID else {
            return model.snapshot.settings.defaultSelection
        }
        return FeatureSelection(providerID: providerID, modelID: modelID)
    }

    private func timeline(_ detail: FeatureThreadDetail) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if detail.messages.isEmpty {
                        ContentUnavailableView(
                            "Ready for a task",
                            systemImage: "sparkles",
                            description: Text("Tell the agent what you want to build.")
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, 80)
                    }

                    ForEach(detail.messages) { message in
                        FeatureMessageView(message: message)
                            .id(message.id)
                    }

                    ForEach(detail.approvals) { approval in
                        ApprovalRequestView(model: model, approval: approval)
                            .id("approval-\(approval.id)")
                    }

                    ForEach(detail.userInputs) { input in
                        UserInputRequestView(model: model, input: input)
                            .id("user-input-\(input.id)")
                    }

                    if detail.thread.state == .working || detail.thread.state == .queued {
                        StreamingStatusView(
                            state: detail.thread.state,
                            onStop: {
                                Task { await model.cancelTurn(threadID: thread.id) }
                            }
                        )
                        .id("streaming-status")
                    }

                    Color.clear.frame(height: 1).id("timeline-bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 10)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: detail.messages.count) {
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo("timeline-bottom", anchor: .bottom)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                FeatureComposerView(
                    text: $draft,
                    selection: $selection,
                    providers: model.snapshot.providers,
                    isSending: isSending,
                    isWorking: detail.thread.state == .working || detail.thread.state == .queued,
                    focused: $composerFocused,
                    onSend: send,
                    onStop: {
                        Task { await model.cancelTurn(threadID: thread.id) }
                    }
                )
            }
        }
    }

    private func send() {
        let message = draft
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        draft = ""
        isSending = true
        Task {
            let sent = await model.sendMessage(
                threadID: thread.id,
                text: message,
                selection: selection
            )
            if !sent {
                draft = message
            }
            isSending = false
            composerFocused = true
        }
    }

    private func runtimeModeLabel(_ mode: FeatureRuntimeMode) -> String {
        switch mode {
        case .approvalRequired: "Ask before changes"
        case .autoAcceptEdits: "Auto-accept edits"
        case .automatic: "Automatic"
        case .fullAccess: "Full access"
        }
    }
}

private enum FeatureThreadToolSurface: String, Identifiable {
    case files
    case review
    case sourceControl
    case terminal

    var id: String { rawValue }
}

private struct UserInputRequestView: View {
    @Bindable var model: FeatureRootModel
    let input: FeatureUserInput
    @State private var answers: [String: String] = [:]
    @State private var isSubmitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Input requested", systemImage: "questionmark.bubble")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.indigo)

            ForEach(input.questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.header)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(question.question)
                        .font(.callout)

                    if !question.options.isEmpty {
                        ForEach(question.options, id: \.label) { option in
                            Button {
                                answers[question.id] = option.label
                            } label: {
                                HStack(alignment: .top, spacing: 9) {
                                    Image(
                                        systemName: answers[question.id] == option.label
                                            ? "checkmark.circle.fill"
                                            : "circle"
                                    )
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(option.label)
                                        if !option.detail.isEmpty {
                                            Text(option.detail)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    TextField(
                        question.options.isEmpty ? "Your answer" : "Or type another answer",
                        text: Binding(
                            get: { answers[question.id] ?? "" },
                            set: { answers[question.id] = $0 }
                        ),
                        axis: .vertical
                    )
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                }
            }

            Button(isSubmitting ? "Submitting…" : "Submit") {
                isSubmitting = true
                Task {
                    await model.resolveUserInput(input.id, answers: answers)
                    isSubmitting = false
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(.black)
            .disabled(
                isSubmitting
                    || input.questions.contains {
                        answers[$0.id]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            != false
                    }
            )
        }
        .padding(13)
        .background(Color.indigo.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.indigo.opacity(0.35), lineWidth: 1)
        }
    }
}

struct FeatureMessageView: View {
    let message: FeatureMessage

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 34)
                Text(.init(message.text))
                    .textSelection(.enabled)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.11), in: RoundedRectangle(cornerRadius: 15))
            }
            .accessibilityLabel("You")
            .accessibilityValue(message.text)
        case .assistant:
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                    Text(message.state == .streaming ? "Agent · Working" : "Agent")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                Text(.init(message.text))
                    .textSelection(.enabled)
                    .lineSpacing(3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .tool:
            DisclosureGroup {
                Text(message.text)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.top, 6)
            } label: {
                Label(message.toolName ?? "Tool output", systemImage: "terminal")
                    .font(.subheadline.weight(.medium))
            }
            .padding(11)
            .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
        case .system:
            Text(message.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

struct StreamingStatusView: View {
    let state: FeatureThreadState
    let onStop: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            ProgressView()
                .controlSize(.small)
            Text(state == .queued ? "Queued" : "Agent is working")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Stop", role: .destructive, action: onStop)
                .font(.footnote.weight(.semibold))
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

struct ApprovalRequestView: View {
    @Bindable var model: FeatureRootModel
    let approval: FeatureApproval

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(approval.title, systemImage: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)

            Text(approval.detail)
                .font(approval.kind == .command ? .caption.monospaced() : .callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            HStack(spacing: 8) {
                Button("Deny", role: .destructive) {
                    decide(.deny)
                }
                .buttonStyle(.bordered)
                Spacer()
                Button("Always Allow") {
                    decide(.allowForSession)
                }
                .buttonStyle(.bordered)
                Button("Allow") {
                    decide(.allowOnce)
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
            }
            .font(.footnote.weight(.semibold))
        }
        .padding(13)
        .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.orange.opacity(0.3), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private var icon: String {
        switch approval.kind {
        case .command: "terminal"
        case .fileRead: "doc.text.magnifyingglass"
        case .fileChange, .patch: "doc.badge.ellipsis"
        case .other: "exclamationmark.shield"
        }
    }

    private func decide(_ decision: FeatureApprovalDecision) {
        Task { await model.resolveApproval(approval.id, decision: decision) }
    }
}
