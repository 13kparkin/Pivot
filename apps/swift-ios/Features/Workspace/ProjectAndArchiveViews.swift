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
