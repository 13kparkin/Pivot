import SwiftUI

public struct NewThreadView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let onCreated: (FeatureThread) -> Void

    @State private var projectID = ""
    @State private var title = ""
    @State private var selection: FeatureSelection?
    @State private var isCreating = false

    public init(model: FeatureRootModel, onCreated: @escaping (FeatureThread) -> Void) {
        self.model = model
        self.onCreated = onCreated
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    Picker("Project", selection: $projectID) {
                        ForEach(model.snapshot.projects) { project in
                            Text(project.name).tag(project.id)
                        }
                    }
                }

                Section("Task") {
                    TextField("Optional title", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                    ProviderModelPicker(
                        providers: model.snapshot.providers,
                        selection: $selection
                    )
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .navigationTitle("New Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isCreating ? "Creating…" : "Create") {
                        create()
                    }
                    .disabled(projectID.isEmpty || isCreating)
                }
            }
            .onAppear {
                if projectID.isEmpty {
                    projectID = model.snapshot.projects.first?.id ?? ""
                }
                if selection == nil {
                    selection = model.snapshot.settings.defaultSelection
                        ?? model.snapshot.providers.first?.models.first.map {
                            FeatureSelection(
                                providerID: model.snapshot.providers.first?.id ?? "",
                                modelID: $0.id
                            )
                        }
                }
            }
        }
    }

    private func create() {
        isCreating = true
        Task {
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            if let thread = await model.createThread(
                projectID: projectID,
                title: trimmed.isEmpty ? nil : trimmed,
                selection: selection
            ) {
                onCreated(thread)
            }
            isCreating = false
        }
    }
}

public struct ProviderModelPicker: View {
    let providers: [FeatureProvider]
    @Binding var selection: FeatureSelection?

    public init(providers: [FeatureProvider], selection: Binding<FeatureSelection?>) {
        self.providers = providers
        _selection = selection
    }

    public var body: some View {
        Menu {
            ForEach(providers.filter(\.isAvailable)) { provider in
                Section(provider.name) {
                    ForEach(provider.models) { model in
                        Button {
                            selection = FeatureSelection(providerID: provider.id, modelID: model.id)
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
            LabeledContent("Model") {
                Text(selectionLabel)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("Provider and model")
    }

    private var selectionLabel: String {
        guard let selection,
              let provider = providers.first(where: { $0.id == selection.providerID }),
              let model = provider.models.first(where: { $0.id == selection.modelID }) else {
            return "Automatic"
        }
        return "\(provider.name) · \(model.name)"
    }
}
