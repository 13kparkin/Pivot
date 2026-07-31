import SwiftUI

public struct ThreadDetailView: View {
    @Bindable var model: FeatureRootModel
    let thread: FeatureThread
    let submitMessage: (FeatureMessageSubmission) async -> Bool

    @State private var draft = ""
    @State private var selection: FeatureSelection?
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var isSending = false
    @State private var isLoading = true
    @State private var sendFailed = false
    @State private var toolSurface: FeatureThreadToolSurface?
    @FocusState private var composerFocused: Bool

    public init(
        model: FeatureRootModel,
        thread: FeatureThread,
        submitMessage: @escaping (FeatureMessageSubmission) async -> Bool
    ) {
        self.model = model
        self.thread = thread
        self.submitMessage = submitMessage
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
            _ = await model.detail(for: thread.id, force: true)
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
        .alert("Message not sent", isPresented: $sendFailed) {
            Button("OK") {}
        } message: {
            Text("Your draft is still here. Check your connection and try again.")
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
        if let defaultSelection = model.snapshot.settings.defaultSelection,
           defaultSelection.providerID == providerID,
           defaultSelection.modelID == modelID {
            return defaultSelection
        }
        let provider = model.snapshot.providers.first { $0.id == providerID }
        let featureModel = provider?.models.first { $0.id == modelID }
        let savedOptions = detail?.thread.modelOptions ?? thread.modelOptions
        return FeatureSelection(
            providerID: providerID,
            modelID: modelID,
            options: savedOptions.isEmpty
                ? featureModel.map(DailyUXModelOptions.defaults) ?? []
                : savedOptions
        )
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

                    if detail.thread.state == .working || detail.thread.state == .queued {
                        StreamingStatusView(
                            state: detail.thread.state
                        )
                        .id("streaming-status")
                    }

                    Color.clear.frame(height: 1).id("timeline-bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 10)
            }
            .scrollDismissesKeyboard(.interactively)
            .task(id: thread.id) {
                await Task.yield()
                proxy.scrollTo("timeline-bottom", anchor: .bottom)
            }
            .onChange(of: detail.messages.last?.id) {
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo("timeline-bottom", anchor: .bottom)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                FeatureComposerView(
                    text: $draft,
                    selection: $selection,
                    attachments: $attachments,
                    providers: model.snapshot.providers,
                    threadSelection: currentSelection,
                    isSending: isSending,
                    isWorking: detail.thread.state == .working || detail.thread.state == .queued,
                    focused: $composerFocused,
                    onSend: send,
                    onStop: {
                        Task { await model.cancelTurn(threadID: thread.id) }
                    },
                    runtimeMode: currentThread.runtimeMode,
                    onRuntimeModeChange: { mode in
                        Task { await model.setRuntimeMode(thread.id, mode: mode) }
                    },
                    pendingApprovals: detail.approvals,
                    pendingUserInputs: detail.userInputs,
                    isResolvingRequest: model.isPerformingAction,
                    onApprovalDecision: { id, decision in
                        Task { await model.resolveApproval(id, decision: decision) }
                    },
                    onUserInputSubmit: { id, answers in
                        Task { await model.resolveUserInput(id, answers: answers) }
                    }
                )
            }
        }
    }

    private func send() {
        let message = draft
        let pendingAttachments = attachments
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pendingAttachments.isEmpty else {
            return
        }
        draft = ""
        attachments = []
        isSending = true
        Task {
            let sent = await submitMessage(
                FeatureMessageSubmission(
                threadID: thread.id,
                text: message,
                selection: selection,
                attachments: pendingAttachments
                )
            )
            if !sent {
                let currentDraft = draft
                let restoredMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
                if currentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft = message
                } else if !restoredMessage.isEmpty {
                    draft = "\(message)\n\(currentDraft)"
                }
                let pendingIDs = Set(pendingAttachments.map(\.id))
                attachments = pendingAttachments + attachments.filter {
                    !pendingIDs.contains($0.id)
                }
                sendFailed = true
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

struct FeatureMessageView: View {
    let message: FeatureMessage

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 34)
                VStack(alignment: .leading, spacing: 8) {
                    FeatureMessageAttachmentsView(attachments: message.attachments)
                    if !message.text.isEmpty {
                        MarkdownMessageView(message.text)
                    }
                }
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .background(Color.white.opacity(0.11), in: RoundedRectangle(cornerRadius: 15))
            }
            .accessibilityLabel("You")
            .accessibilityValue(accessibilityValue)
            .accessibilityIdentifier("message-\(message.id)")
        case .assistant:
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                    Text(message.state == .streaming ? "Agent · Working" : "Agent")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                FeatureMessageAttachmentsView(attachments: message.attachments)
                if !message.text.isEmpty {
                    MarkdownMessageView(message.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("message-\(message.id)")
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
            .accessibilityIdentifier("message-\(message.id)")
        case .system:
            Text(message.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .accessibilityIdentifier("message-\(message.id)")
        }
    }

    private var accessibilityValue: String {
        let attachmentSummary = message.attachments.isEmpty
            ? ""
            : "\(message.attachments.count) image attachment"
                + (message.attachments.count == 1 ? "" : "s")
        return [message.text, attachmentSummary]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

private struct FeatureMessageAttachmentsView: View {
    let attachments: [FeatureMessageAttachment]
    @State private var previewedAttachment: FeatureMessageAttachment?

    var body: some View {
        if !attachments.isEmpty {
            LazyVGrid(
                columns: [
                    GridItem(.adaptive(minimum: 118, maximum: 190), spacing: 7),
                ],
                alignment: .leading,
                spacing: 7
            ) {
                ForEach(attachments) { attachment in
                    VStack(alignment: .leading, spacing: 6) {
                        if attachment.mimeType.hasPrefix("image/") {
                            Group {
                                if let url = attachment.url {
                                    AsyncImage(url: url) { phase in
                                        switch phase {
                                        case let .success(image):
                                            image
                                                .resizable()
                                                .scaledToFit()
                                        case .failure:
                                            attachmentPlaceholder(
                                                systemImage: "exclamationmark.triangle"
                                            )
                                        case .empty:
                                            attachmentPlaceholder(systemImage: "photo")
                                        @unknown default:
                                            attachmentPlaceholder(systemImage: "photo")
                                        }
                                    }
                                } else {
                                    attachmentPlaceholder(systemImage: "photo")
                                }
                            }
                            .frame(height: 160)
                            .frame(maxWidth: .infinity)
                            .background(T3Colors.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }

                        HStack(spacing: 9) {
                            Image(
                                systemName: attachment.mimeType.hasPrefix("image/")
                                    ? "photo"
                                    : "doc"
                            )
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(T3Colors.textSecondary)
                            .frame(width: 30, height: 30)
                            .background(
                                T3Colors.surfaceRaised,
                                in: RoundedRectangle(cornerRadius: 6)
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text(attachment.name)
                                    .font(.caption.weight(.medium))
                                    .lineLimit(1)
                                Text(
                                    ByteCountFormatter.string(
                                        fromByteCount: Int64(attachment.sizeBytes),
                                        countStyle: .file
                                    )
                                )
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(T3Colors.textSecondary)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(7)
                    .overlay {
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(T3Colors.border, lineWidth: 1)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        attachment.mimeType.hasPrefix("image/")
                            ? "Image attachment"
                            : "File attachment"
                    )
                    .accessibilityValue(attachmentAccessibilityValue(attachment))
                    .accessibilityIdentifier("attachment-\(attachment.id)")
                    .accessibilityAddTraits(
                        attachment.mimeType.hasPrefix("image/") && attachment.url != nil
                            ? .isButton
                            : []
                    )
                    .accessibilityHint(
                        attachment.mimeType.hasPrefix("image/") && attachment.url != nil
                            ? "Opens full-screen preview"
                            : ""
                    )
                    .accessibilityAction {
                        if attachment.mimeType.hasPrefix("image/"), attachment.url != nil {
                            previewedAttachment = attachment
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if attachment.mimeType.hasPrefix("image/"), attachment.url != nil {
                            previewedAttachment = attachment
                        }
                    }
                }
            }
            .fullScreenCover(item: $previewedAttachment) { attachment in
                FeatureAttachmentPreview(attachment: attachment)
            }
        }
    }

    private func attachmentPlaceholder(systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func attachmentAccessibilityValue(
        _ attachment: FeatureMessageAttachment
    ) -> String {
        let size = ByteCountFormatter.string(
            fromByteCount: Int64(attachment.sizeBytes),
            countStyle: .file
        )
        return "\(attachment.name), \(size)"
    }
}

private struct FeatureAttachmentPreview: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let attachment: FeatureMessageAttachment

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let url = attachment.url {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFit()
                        case .failure:
                            ContentUnavailableView(
                                "Image unavailable",
                                systemImage: "exclamationmark.triangle"
                            )
                        case .empty:
                            ProgressView()
                        @unknown default:
                            ProgressView()
                        }
                    }
                    .padding(12)
                }
            }
            .navigationTitle(attachment.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .t3NavigationChrome()
        }
        .preferredColorScheme(.dark)
    }
}

struct StreamingStatusView: View {
    let state: FeatureThreadState

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: state == .queued ? "clock" : "circle.dotted")
                .foregroundStyle(T3Colors.statusRunning)
            Text(state == .queued ? "Queued" : "Agent working")
                .foregroundStyle(T3Colors.textSecondary)
        }
        .font(.caption.monospaced().weight(.medium))
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
