import SwiftUI

struct FeatureComposerView: View {
    @Binding var text: String
    @Binding var selection: FeatureSelection?
    let providers: [FeatureProvider]
    let isSending: Bool
    let isWorking: Bool
    let focused: FocusState<Bool>.Binding
    let onSend: () -> Void
    let onStop: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 9) {
                TextField("Message agent", text: $text, axis: .vertical)
                    .lineLimit(1...7)
                    .focused(focused)
                    .submitLabel(.send)
                    .onSubmit {
                        if canSend { onSend() }
                    }
                    .padding(.leading, 12)
                    .padding(.vertical, 10)

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
            .background(Color.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.white.opacity(0.14), lineWidth: 1)
            }

            HStack {
                CompactModelMenu(providers: providers, selection: $selection)
                Spacer()
                Text("Return to send")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
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
        !textIsEmpty && !isSending
    }
}

private struct CompactModelMenu: View {
    let providers: [FeatureProvider]
    @Binding var selection: FeatureSelection?

    var body: some View {
        Menu {
            ForEach(providers.filter(\.isAvailable)) { provider in
                Section(provider.name) {
                    ForEach(provider.models) { model in
                        Button {
                            selection = .init(providerID: provider.id, modelID: model.id)
                        } label: {
                            if selection?.providerID == provider.id, selection?.modelID == model.id {
                                Label(model.name, systemImage: "checkmark")
                            } else {
                                Text(model.name)
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "cpu")
                Text(label)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Choose model")
    }

    private var label: String {
        guard let selection,
              let provider = providers.first(where: { $0.id == selection.providerID }),
              let model = provider.models.first(where: { $0.id == selection.modelID }) else {
            return "Automatic"
        }
        return model.name
    }
}
