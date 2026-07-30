import SwiftUI

struct FeatureComposerView: View {
    @Binding var text: String
    @Binding var selection: FeatureSelection?
    @Binding var attachments: [FeatureDraftAttachment]
    let providers: [FeatureProvider]
    let threadSelection: FeatureSelection?
    let isSending: Bool
    let isWorking: Bool
    let focused: FocusState<Bool>.Binding
    let onSend: () -> Void
    let onStop: () -> Void

    var body: some View {
        VStack(spacing: 7) {
            FeatureAttachmentStrip(attachments: $attachments)

            HStack(alignment: .bottom, spacing: 9) {
                FeatureImageAttachmentPicker(
                    attachments: $attachments,
                    isEnabled: DailyUXModelOptions.supportsImages(
                        selection: selection,
                        providers: providers
                    )
                )
                    .padding(.leading, 2)
                    .padding(.bottom, 1)

                TextField("Message agent", text: $text, axis: .vertical)
                    .lineLimit(1...7)
                    .focused(focused)
                    .submitLabel(.send)
                    .onSubmit {
                        if canSend { onSend() }
                    }
                    .padding(.vertical, 11)

                Button(action: isWorking && textIsEmpty ? onStop : onSend) {
                    Image(systemName: isWorking && textIsEmpty ? "stop.fill" : "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(width: 32, height: 32)
                        .background(.white, in: Circle())
                }
                .disabled((!isWorking && !canSend) || isSending)
                .padding(.trailing, 7)
                .padding(.bottom, 7)
                .accessibilityLabel(isWorking && textIsEmpty ? "Stop agent" : "Send")
            }
            .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .stroke(T3Colors.border, lineWidth: 1)
            }

            HStack {
                ProviderModelPicker(
                    providers: providers,
                    selection: $selection,
                    style: .compact,
                    threadSelection: threadSelection
                )
                Spacer()
                if !attachments.isEmpty, !imagesAllowed {
                    Text("Choose an image model")
                        .font(.caption2)
                        .foregroundStyle(T3Colors.warning)
                } else if !attachments.isEmpty {
                    Text("\(attachments.count) image\(attachments.count == 1 ? "" : "s")")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            .padding(.horizontal, 3)
        }
        .padding(.horizontal, 12)
        .padding(.top, 9)
        .padding(.bottom, 7)
        .background(.black.opacity(0.97))
        .overlay(alignment: .top) {
            Divider().opacity(0.4)
        }
    }

    private var textIsEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool {
        (!textIsEmpty || !attachments.isEmpty)
            && (attachments.isEmpty || imagesAllowed)
            && !isSending
    }

    private var imagesAllowed: Bool {
        DailyUXModelOptions.supportsImages(selection: selection, providers: providers)
    }
}
