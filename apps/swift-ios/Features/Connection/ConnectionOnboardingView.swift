import SwiftUI

public struct ConnectionOnboardingView: View {
    @Bindable var model: FeatureRootModel
    @State private var endpoint = ""
    @State private var pairingToken = ""
    @State private var isPairing = false

    public init(model: FeatureRootModel) {
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "chevron.left.forwardslash.chevron.right")
                            .font(.system(size: 34, weight: .bold))
                        Text("T3 Code")
                            .font(.largeTitle.bold())
                        Text("Connect this iPhone to a T3 environment.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("SERVER")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)

                        TextField("https://your-server.example", text: $endpoint)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .featureInput()
                            .accessibilityLabel("Server address")

                        SecureField("Pairing token (optional)", text: $pairingToken)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .featureInput()

                        Button {
                            pair()
                        } label: {
                            HStack {
                                if isPairing {
                                    ProgressView().controlSize(.small)
                                }
                                Text(isPairing ? "Connecting…" : "Connect")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(FeaturePrimaryButtonStyle())
                        .disabled(normalizedEndpoint == nil || isPairing)
                    }

                    if !model.snapshot.environments.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("KNOWN ENVIRONMENTS")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)

                            ForEach(model.snapshot.environments) { environment in
                                Button {
                                    endpoint = environment.endpoint
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "server.rack")
                                            .foregroundStyle(.secondary)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(environment.name)
                                                .foregroundStyle(.primary)
                                            Text(environment.endpoint)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                    .contentShape(Rectangle())
                                    .padding(.vertical, 8)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Label("How to pair", systemImage: "info.circle")
                            .font(.subheadline.weight(.semibold))
                        Text("Open T3 Code on the host, copy its mobile pairing link, then paste the server and one-time token above.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.black)
            .navigationTitle("Connect")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var normalizedEndpoint: String? {
        let value = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              components.host != nil else {
            return nil
        }
        return value
    }

    private func pair() {
        guard let endpoint = normalizedEndpoint else { return }
        let trimmedToken = pairingToken.trimmingCharacters(in: .whitespacesAndNewlines)
        isPairing = true
        Task {
            _ = await model.pair(
                endpoint: endpoint,
                token: trimmedToken.isEmpty ? nil : trimmedToken
            )
            isPairing = false
        }
    }
}

private extension View {
    func featureInput() -> some View {
        self
            .padding(.horizontal, 12)
            .frame(minHeight: 46)
            .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color.white.opacity(0.12), lineWidth: 1)
            }
    }
}

struct FeaturePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.black)
            .padding(.horizontal, 16)
            .frame(minHeight: 46)
            .background(configuration.isPressed ? Color.white.opacity(0.75) : .white)
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
