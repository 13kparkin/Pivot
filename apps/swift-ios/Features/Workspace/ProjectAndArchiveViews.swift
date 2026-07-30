import SwiftUI

public struct AddProjectView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    @State private var path = ""
    @State private var isAdding = false

    public init(model: FeatureRootModel) {
        self.model = model
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("/path/to/project", text: $path)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Workspace path")
                } footer: {
                    Text("The path is resolved by the connected T3 environment.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .navigationTitle("Add Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isAdding ? "Adding…" : "Add") { add() }
                        .disabled(trimmedPath.isEmpty || isAdding)
                }
            }
        }
    }

    private var trimmedPath: String {
        path.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func add() {
        isAdding = true
        Task {
            if await model.addProject(path: trimmedPath) {
                dismiss()
            }
            isAdding = false
        }
    }
}

public struct ArchivedThreadsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let onSelect: (FeatureThread) -> Void

    public init(model: FeatureRootModel, onSelect: @escaping (FeatureThread) -> Void) {
        self.model = model
        self.onSelect = onSelect
    }

    public var body: some View {
        NavigationStack {
            List {
                if archived.isEmpty {
                    ContentUnavailableView(
                        "No archived threads",
                        systemImage: "archivebox",
                        description: Text("Archived work will appear here.")
                    )
                    .listRowBackground(Color.clear)
                }
                ForEach(archived) { thread in
                    HStack(spacing: 12) {
                        Button {
                            onSelect(thread)
                        } label: {
                            FeatureThreadRow(
                                thread: thread,
                                projectName: projectName(for: thread.projectID)
                            )
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)

                        Button {
                            Task { await model.setArchived(thread.id, archived: false) }
                        } label: {
                            Image(systemName: "arrow.uturn.backward")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Restore \(thread.title)")
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await model.deleteThread(thread.id) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        Button {
                            Task { await model.setArchived(thread.id, archived: false) }
                        } label: {
                            Label("Restore", systemImage: "arrow.uturn.backward")
                        }
                        .tint(.blue)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .navigationTitle("Archived")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var archived: [FeatureThread] {
        model.snapshot.threads
            .filter(\.isArchived)
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private func projectName(for id: String) -> String {
        model.snapshot.projects.first(where: { $0.id == id })?.name ?? "Unknown project"
    }
}
