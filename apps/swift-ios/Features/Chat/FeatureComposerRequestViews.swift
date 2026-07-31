import SwiftUI

struct FeatureComposerApprovalPanel: View {
    let approval: FeatureApproval
    let position: Int
    let total: Int
    let isResponding: Bool
    let onDecision: (FeatureApprovalDecision) -> Void
    let onCancelTurn: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text("Pending approval")
                        .font(.caption2.weight(.bold))
                        .tracking(1.3)
                        .textCase(.uppercase)
                        .foregroundStyle(T3Colors.warning)

                    Spacer()

                    if total > 1 {
                        Text("\(position)/\(total)")
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                }

                Text(approval.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                    .padding(.top, 5)

                VStack(alignment: .leading, spacing: 5) {
                    Text(detailLabel)
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.7)
                        .textCase(.uppercase)
                        .foregroundStyle(T3Colors.textTertiary)

                    Text(approval.detail)
                        .font(approval.kind == .command ? .caption.monospaced() : .callout)
                        .foregroundStyle(Color.white.opacity(0.84))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.black.opacity(0.46), in: RoundedRectangle(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                }
                .padding(.top, 9)
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.024))

            Divider().overlay(T3Colors.separator)

            VStack(spacing: 9) {
                HStack(spacing: 7) {
                    approvalButton(
                        "Approve once",
                        background: T3Colors.accent,
                        action: { onDecision(.allowOnce) }
                    )

                    approvalButton(
                        "Always allow",
                        background: Color.clear,
                        border: Color.white.opacity(0.14),
                        action: { onDecision(.allowForSession) }
                    )
                }

                HStack(spacing: 26) {
                    Button("Decline", role: .destructive) {
                        onDecision(.deny)
                    }
                    .foregroundStyle(T3Colors.danger)

                    Button("Cancel turn", action: onCancelTurn)
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .padding(.bottom, 11)
        }
        .disabled(isResponding)
        .opacity(isResponding ? 0.56 : 1)
        .accessibilityElement(children: .contain)
    }

    private func approvalButton(
        _ title: String,
        background: Color,
        border: Color = .clear,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: T3Metrics.minimumTapTarget)
                .background(background, in: RoundedRectangle(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(border, lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
    }

    private var detailLabel: String {
        switch approval.kind {
        case .command: "Command"
        case .fileRead: "File access"
        case .fileChange: "File change"
        case .patch: "Patch"
        case .other: "Details"
        }
    }
}

struct FeatureComposerUserInputPanel: View {
    let input: FeatureUserInput
    let isResponding: Bool
    let onSubmit: ([String: FeatureInputAnswer]) -> Void

    @State private var answers: [String: FeatureInputAnswer] = [:]
    @State private var questionIndex = 0

    var body: some View {
        if let question = activeQuestion {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        Text(question.header)
                            .font(.caption2.weight(.bold))
                            .tracking(1.3)
                            .textCase(.uppercase)
                            .foregroundStyle(T3Colors.accent)

                        Spacer()

                        if input.questions.count > 1 {
                            Text("\(questionIndex + 1)/\(input.questions.count)")
                                .font(.caption2.monospacedDigit().weight(.semibold))
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                    }

                    Text(question.question)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(T3Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 5)

                    if question.allowsMultiple {
                        Text("Select one or more options")
                            .font(.caption)
                            .foregroundStyle(T3Colors.textTertiary)
                            .padding(.top, 4)
                    }

                }
                .padding(.horizontal, 15)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white.opacity(0.024))

                Divider().overlay(T3Colors.separator)

                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(Array(question.options.enumerated()), id: \.element.label) { index, option in
                            optionButton(option, number: index + 1, question: question)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 10)
                }
                .frame(maxHeight: 252)
                .scrollIndicators(.hidden)

                HStack(spacing: 8) {
                    Image(systemName: "pencil")
                        .font(.caption)
                        .foregroundStyle(T3Colors.textTertiary)

                    TextField(
                        "Write custom answer",
                        text: answerBinding(for: question.id)
                    )
                    .font(.subheadline)
                    .submitLabel(.next)
                    .onSubmit(advanceOrSubmit)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 11))
                .overlay {
                    RoundedRectangle(cornerRadius: 11)
                        .stroke(Color.white.opacity(0.09), lineWidth: 1)
                }
                .padding(.horizontal, 10)
                .padding(.top, 7)

                HStack(spacing: 8) {
                    if questionIndex > 0 {
                        Button("Back") {
                            questionIndex -= 1
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(minWidth: T3Metrics.minimumTapTarget, minHeight: 36)
                    }

                    Spacer()

                    Button(action: advanceOrSubmit) {
                        Text(isLastQuestion ? "Submit" : "Next question")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 18)
                            .frame(height: 36)
                            .background(T3Colors.accent, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canAdvance)
                    .opacity(canAdvance ? 1 : 0.3)
                }
                .padding(.horizontal, 10)
                .padding(.top, 9)
                .padding(.bottom, 11)
            }
            .disabled(isResponding)
            .opacity(isResponding ? 0.56 : 1)
            .onChange(of: input.id) {
                answers = [:]
                questionIndex = 0
            }
        }
    }

    private var activeQuestion: FeatureInputQuestion? {
        guard input.questions.indices.contains(questionIndex) else { return nil }
        return input.questions[questionIndex]
    }

    private var isLastQuestion: Bool {
        questionIndex >= input.questions.count - 1
    }

    private var canAdvance: Bool {
        guard let activeQuestion else { return false }
        return normalizedAnswer(for: activeQuestion.id) != nil
    }

    private var normalizedAnswers: [String: FeatureInputAnswer]? {
        var result: [String: FeatureInputAnswer] = [:]
        for question in input.questions {
            guard let answer = normalizedAnswer(for: question.id) else { return nil }
            result[question.id] = answer
        }
        return result
    }

    private func optionButton(
        _ option: FeatureInputOption,
        number: Int,
        question: FeatureInputQuestion
    ) -> some View {
        let isSelected = isOptionSelected(option.label, for: question)

        return Button {
            select(option.label, for: question)
        } label: {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.white.opacity(0.9))

                    if !option.detail.isEmpty, option.detail != option.label {
                        Text(option.detail)
                            .font(.caption)
                            .foregroundStyle(T3Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 8)

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(T3Colors.accent)
                } else if number <= 9 {
                    Text("\(number)")
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 20, height: 20)
                        .overlay {
                            RoundedRectangle(cornerRadius: 5)
                                .stroke(Color.white.opacity(0.14), lineWidth: 1)
                        }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .background(
                isSelected ? T3Colors.accent.opacity(0.12) : Color.white.opacity(0.045),
                in: RoundedRectangle(cornerRadius: 10)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(
                        isSelected ? T3Colors.accent.opacity(0.46) : Color.clear,
                        lineWidth: 1
                    )
            }
        }
        .buttonStyle(.plain)
    }

    private func answerBinding(for questionID: String) -> Binding<String> {
        Binding(
            get: {
                guard case let .text(value)? = answers[questionID] else { return "" }
                return value
            },
            set: { answers[questionID] = .text($0) }
        )
    }

    private func select(_ label: String, for question: FeatureInputQuestion) {
        answers[question.id] = (answers[question.id] ?? .selections([]))
            .togglingOption(label, allowsMultiple: question.allowsMultiple)
        if question.allowsMultiple {
            return
        }
        guard !isLastQuestion else { return }
        Task { @MainActor in
            await Task.yield()
            questionIndex += 1
        }
    }

    private func advanceOrSubmit() {
        guard canAdvance else { return }
        if !isLastQuestion {
            questionIndex += 1
        } else if let normalizedAnswers {
            onSubmit(normalizedAnswers)
        } else if let unanswered = input.questions.firstIndex(where: {
            normalizedAnswer(for: $0.id) == nil
        }) {
            questionIndex = unanswered
        }
    }

    private func normalizedAnswer(for questionID: String) -> FeatureInputAnswer? {
        answers[questionID]?.normalized
    }

    private func isOptionSelected(_ label: String, for question: FeatureInputQuestion) -> Bool {
        switch answers[question.id] {
        case let .text(value):
            return !question.allowsMultiple && value == label
        case let .selections(values):
            return values.contains(label)
        case nil:
            return false
        }
    }
}
