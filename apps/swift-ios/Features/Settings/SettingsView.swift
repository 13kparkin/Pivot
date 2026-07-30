import SwiftUI

public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    @State private var settings: FeatureSettings
    @State private var isSaving = false
    @State private var showingDisconnect = false

    public init(model: FeatureRootModel) {
        self.model = model
        _settings = State(initialValue: model.snapshot.settings)
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Theme", selection: $settings.appearance) {
                        Text("System").tag(FeatureAppearance.system)
                        Text("Dark").tag(FeatureAppearance.dark)
                    }
                    Toggle("Haptics", isOn: $settings.hapticsEnabled)
                    Toggle("Notifications", isOn: $settings.notificationsEnabled)
                }

                Section("Default agent") {
                    ProviderModelPicker(
                        providers: model.snapshot.providers,
                        selection: $settings.defaultSelection
                    )
                    if let provider = selectedProvider, let selectedModel {
                        LabeledContent("Provider", value: provider.name)
                        if let detail = selectedModel.detail {
                            Text(detail)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Environment") {
                    LabeledContent(
                        "Status",
                        value: model.snapshot.connection.state == .connected ? "Connected" : "Offline"
                    )
                    if let endpoint = model.snapshot.connection.endpoint {
                        LabeledContent("Server") {
                            Text(endpoint)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    ForEach(model.snapshot.environments) { environment in
                        Button {
                            Task { await model.activateEnvironment(environment.id) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(environment.name)
                                        .foregroundStyle(.primary)
                                    Text(environment.endpoint)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if environment.isActive {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.green)
                                }
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                Task { await model.removeEnvironment(environment.id) }
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                Task { await model.removeEnvironment(environment.id) }
                            } label: {
                                Label("Remove Environment", systemImage: "trash")
                            }
                        }
                    }
                    Button("Disconnect", role: .destructive) {
                        showingDisconnect = true
                    }
                }

                Section("About") {
                    LabeledContent("App", value: "T3 Code for iOS")
                    LabeledContent("Platform", value: "Native SwiftUI")
                    Link("Open source", destination: URL(string: "https://github.com/pingdotgg/t3code")!)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        save()
                    }
                    .disabled(isSaving || settings == model.snapshot.settings)
                }
            }
            .confirmationDialog(
                "Disconnect from this environment?",
                isPresented: $showingDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    Task {
                        await model.disconnect()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private var selectedProvider: FeatureProvider? {
        guard let selection = settings.defaultSelection else { return nil }
        return model.snapshot.providers.first { $0.id == selection.providerID }
    }

    private var selectedModel: FeatureModel? {
        guard let selection = settings.defaultSelection else { return nil }
        return selectedProvider?.models.first { $0.id == selection.modelID }
    }

    private func save() {
        isSaving = true
        Task {
            await model.saveSettings(settings)
            isSaving = false
            if model.snapshot.settings == settings {
                dismiss()
            }
        }
    }
}
