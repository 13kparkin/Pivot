import SwiftUI

struct FeatureComposerView: View {
    @State private var isManuallyExpanded = false
    @State private var attachmentPreparation = FeatureAttachmentPreparationState()

    @Binding private var text: String
    @Binding private var selection: FeatureSelection?
    @Binding private var attachments: [FeatureDraftAttachment]

    private let providers: [FeatureProvider]
    private let threadSelection: FeatureSelection?
    private let isSending: Bool
    private let isWorking: Bool
    private let focused: FocusState<Bool>.Binding
    private let runtimeMode: FeatureRuntimeMode?
    private let interactionMode: FeatureInteractionMode?
    private let contextUsage: Double?
    private let forceExpanded: Bool
    private let pendingApprovals: [FeatureApproval]
    private let pendingUserInputs: [FeatureUserInput]
    private let isResolvingRequest: Bool
    private let onSend: () -> Void
    private let onStop: () -> Void
    private let onRuntimeModeChange: ((FeatureRuntimeMode) -> Void)?
    private let onInteractionModeChange: ((FeatureInteractionMode) -> Void)?
    private let onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)?
    private let onUserInputSubmit: ((String, [String: FeatureInputAnswer]) -> Void)?

    init(
        text: Binding<String>,
        selection: Binding<FeatureSelection?>,
        attachments: Binding<[FeatureDraftAttachment]>,
        providers: [FeatureProvider],
        threadSelection: FeatureSelection?,
        isSending: Bool,
        isWorking: Bool,
        focused: FocusState<Bool>.Binding,
        onSend: @escaping () -> Void,
        onStop: @escaping () -> Void,
        runtimeMode: FeatureRuntimeMode? = nil,
        interactionMode: FeatureInteractionMode? = nil,
        contextUsage: Double? = nil,
        forceExpanded: Bool = false,
        onRuntimeModeChange: ((FeatureRuntimeMode) -> Void)? = nil,
        onInteractionModeChange: ((FeatureInteractionMode) -> Void)? = nil,
        pendingApprovals: [FeatureApproval] = [],
        pendingUserInputs: [FeatureUserInput] = [],
        isResolvingRequest: Bool = false,
        onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)? = nil,
        onUserInputSubmit: ((String, [String: FeatureInputAnswer]) -> Void)? = nil
    ) {
        _text = text
        _selection = selection
        _attachments = attachments
        self.providers = providers
        self.threadSelection = threadSelection
        self.isSending = isSending
        self.isWorking = isWorking
        self.focused = focused
        self.onSend = onSend
        self.onStop = onStop
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.contextUsage = contextUsage
        self.forceExpanded = forceExpanded
        self.onRuntimeModeChange = onRuntimeModeChange
        self.onInteractionModeChange = onInteractionModeChange
        self.pendingApprovals = pendingApprovals
        self.pendingUserInputs = pendingUserInputs
        self.isResolvingRequest = isResolvingRequest
        self.onApprovalDecision = onApprovalDecision
        self.onUserInputSubmit = onUserInputSubmit
    }

    var body: some View {
        VStack(spacing: 0) {
            if let approval = pendingApprovals.first, let onApprovalDecision {
                FeatureComposerApprovalPanel(
                    approval: approval,
                    position: 1,
                    total: pendingApprovals.count,
                    isResponding: isResolvingRequest,
                    onDecision: { decision in
                        onApprovalDecision(approval.id, decision)
                    },
                    onCancelTurn: onStop
                )
            } else if let input = pendingUserInputs.first, let onUserInputSubmit {
                FeatureComposerUserInputPanel(
                    input: input,
                    isResponding: isResolvingRequest,
                    onSubmit: { answers in
                        onUserInputSubmit(input.id, answers)
                    }
                )
            } else if isExpanded {
                expandedComposer
            } else {
                collapsedComposer
            }
        }
        .background(Color(white: 0.052).opacity(0.98), in: composerShape)
        .overlay {
            composerShape
                .stroke(Color.white.opacity(0.105), lineWidth: 1)
        }
        .clipShape(composerShape)
        .padding(.horizontal, 10)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background {
            LinearGradient(
                colors: [.clear, .black.opacity(0.94), .black],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()
        }
        .onChange(of: focused.wrappedValue) {
            if !focused.wrappedValue,
               textIsEmpty,
               attachments.isEmpty,
               !attachmentPreparation.isPreparing {
                isManuallyExpanded = false
            }
        }
    }

    private var collapsedComposer: some View {
        HStack(spacing: 4) {
            Button {
                isManuallyExpanded = true
                Task { @MainActor in
                    await Task.yield()
                    focused.wrappedValue = true
                }
            } label: {
                Text(isWorking ? "Message to queue…" : "Ask anything…")
                    .font(.body)
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .accessibilityLabel("Message agent")
            .accessibilityHint("Opens the message editor")

            submitButton
                .padding(.trailing, 7)
        }
        .padding(.leading, 12)
        .padding(.vertical, 5)
    }

    private var expandedComposer: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty {
                FeatureAttachmentStrip(attachments: $attachments)
                    .padding(.horizontal, 12)
                    .padding(.top, 3)

                Divider()
                    .overlay(T3Colors.separator)
                    .padding(.horizontal, 13)
            }

            TextField(
                isWorking ? "Message to queue…" : "Ask anything…",
                text: $text,
                axis: .vertical
            )
            .font(.body)
            .lineLimit(1...7)
            .focused(focused)
            .submitLabel(.send)
            .onSubmit {
                if canSend { onSend() }
            }
            .padding(.horizontal, 15)
            .padding(.top, 12)
            .padding(.bottom, 5)
            .frame(minHeight: 57, alignment: .top)

            if !attachments.isEmpty, !imagesAllowed {
                Label("Choose a model that accepts images", systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(T3Colors.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 15)
                    .padding(.bottom, 4)
            }

            if attachmentPreparation.isPreparing {
                Label(attachmentPreparation.statusLabel, systemImage: "hourglass")
                    .font(.caption)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 15)
                    .padding(.bottom, 4)
                    .accessibilityIdentifier("attachment-preparing")
            }

            composerFooter
        }
    }

    private var composerFooter: some View {
        HStack(spacing: 2) {
            FeatureImageAttachmentPicker(
                attachments: $attachments,
                preparationState: $attachmentPreparation,
                isEnabled: imagesAllowed
            )

            ProviderModelPicker(
                providers: providers,
                selection: $selection,
                style: .compact,
                threadSelection: threadSelection
            )
            .frame(maxWidth: 156, alignment: .leading)
            .layoutPriority(2)

            if runtimeMode != nil || interactionMode != nil {
                modePicker(
                    runtimeMode: runtimeMode,
                    interactionMode: interactionMode
                )
            }

            Spacer(minLength: 0)

            if let contextUsage {
                FeatureContextMeter(usage: contextUsage)
            }

            submitButton
                .padding(.leading, 4)
        }
        .padding(.horizontal, 7)
        .padding(.top, 2)
        .padding(.bottom, 8)
    }

    private func modePicker(
        runtimeMode: FeatureRuntimeMode?,
        interactionMode: FeatureInteractionMode?
    ) -> some View {
        Menu {
            if let interactionMode, let onInteractionModeChange {
                Section("Interaction") {
                    ForEach(FeatureInteractionMode.allCases, id: \.self) { mode in
                        Button {
                            onInteractionModeChange(mode)
                        } label: {
                            if mode == interactionMode {
                                Label(interactionModeLabel(mode), systemImage: "checkmark")
                            } else {
                                Text(interactionModeLabel(mode))
                            }
                        }
                    }
                }
            }
            if let runtimeMode, let onRuntimeModeChange {
                Section("Access") {
                    ForEach(FeatureRuntimeMode.allCases, id: \.self) { mode in
                        Button {
                            onRuntimeModeChange(mode)
                        } label: {
                            if mode == runtimeMode {
                                Label(runtimeModeLabel(mode), systemImage: "checkmark")
                            } else {
                                Text(runtimeModeLabel(mode))
                            }
                        }
                    }
                }
            }
        } label: {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    Image(systemName: interactionMode == .plan ? "list.bullet.clipboard" : "lock")
                    Text(modeControlLabel(runtimeMode: runtimeMode, interactionMode: interactionMode))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                }

                Image(systemName: "lock")
                    .frame(width: 30)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(T3Colors.textSecondary)
            .frame(minHeight: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 116)
        .accessibilityLabel("Interaction and access mode")
        .accessibilityValue(
            modeControlLabel(runtimeMode: runtimeMode, interactionMode: interactionMode)
        )
    }

    private var submitButton: some View {
        Button(action: performPrimaryAction) {
            Group {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    Image(systemName: showsStop ? "stop.fill" : "arrow.up")
                        .font(.system(size: showsStop ? 11 : 14, weight: .bold))
                }
            }
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(showsStop ? T3Colors.danger : T3Colors.accent, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(submitDisabled)
        .opacity(submitDisabled ? 0.3 : 1)
        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityLabel(showsStop ? "Stop agent" : "Send")
        .accessibilityIdentifier(showsStop ? "thread-stop" : "message-send")
    }

    private var composerShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
    }

    private var isExpanded: Bool {
        forceExpanded
            || isManuallyExpanded
            || focused.wrappedValue
            || !textIsEmpty
            || !attachments.isEmpty
            || attachmentPreparation.isPreparing
    }

    private var showsStop: Bool {
        isWorking && textIsEmpty && attachments.isEmpty
    }

    private var submitDisabled: Bool {
        isSending || (!showsStop && !canSend)
    }

    private var textIsEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool {
        FeatureComposerSubmissionEligibility.canSend(
            text: text,
            attachmentCount: attachments.count,
            imagesAllowed: imagesAllowed,
            isSending: isSending,
            preparationState: attachmentPreparation
        )
    }

    private var imagesAllowed: Bool {
        DailyUXModelOptions.supportsImages(selection: selection, providers: providers)
    }

    private func performPrimaryAction() {
        if showsStop {
            onStop()
        } else if canSend {
            onSend()
        }
    }

    private func runtimeModeLabel(_ mode: FeatureRuntimeMode) -> String {
        switch mode {
        case .approvalRequired: "Supervised"
        case .autoAcceptEdits: "Auto-accept edits"
        case .automatic: "Auto"
        case .fullAccess: "Full access"
        }
    }

    private func interactionModeLabel(_ mode: FeatureInteractionMode) -> String {
        switch mode {
        case .standard: "Build"
        case .plan: "Plan"
        }
    }

    private func modeControlLabel(
        runtimeMode: FeatureRuntimeMode?,
        interactionMode: FeatureInteractionMode?
    ) -> String {
        if interactionMode == .plan { return "Plan" }
        return runtimeMode.map(runtimeModeLabel) ?? "Mode"
    }
}

enum FeatureComposerSubmissionEligibility {
    static func canSend(
        text: String,
        attachmentCount: Int,
        imagesAllowed: Bool,
        isSending: Bool,
        preparationState: FeatureAttachmentPreparationState
    ) -> Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = attachmentCount > 0
        return !isSending
            && !preparationState.isPreparing
            && (hasText || hasAttachments)
            && (!hasAttachments || imagesAllowed)
    }
}

private struct FeatureContextMeter: View {
    let usage: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.13), lineWidth: 2)
            Circle()
                .trim(from: 0, to: clampedUsage)
                .stroke(
                    T3Colors.textSecondary,
                    style: StrokeStyle(lineWidth: 2, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18)
        .frame(width: 30, height: T3Metrics.minimumTapTarget)
        .accessibilityElement()
        .accessibilityLabel("Context used")
        .accessibilityValue("\(Int((clampedUsage * 100).rounded())) percent")
    }

    private var clampedUsage: Double {
        min(max(usage, 0), 1)
    }
}
