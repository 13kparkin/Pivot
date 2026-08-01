import SwiftUI

public struct ProviderModelPicker: View {
    public enum Style {
        case row
        case compact
    }

    let providers: [FeatureProvider]
    @Binding var selection: FeatureSelection?
    let style: Style
    let isLoading: Bool
    let threadSelection: FeatureSelection?

    @State private var isPresented = false

    public init(
        providers: [FeatureProvider],
        selection: Binding<FeatureSelection?>,
        style: Style = .row,
        isLoading: Bool = false,
        threadSelection: FeatureSelection? = nil
    ) {
        self.providers = providers
        _selection = selection
        self.style = style
        self.isLoading = isLoading
        self.threadSelection = threadSelection
    }

    public var body: some View {
        Button {
            isPresented = true
        } label: {
            switch style {
            case .row:
                HStack(spacing: 12) {
                    selectionMark(size: 22)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Model")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                        Text(selectionLabel)
                            .font(T3Typography.control)
                            .foregroundStyle(T3Colors.textPrimary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .contentShape(Rectangle())
            case .compact:
                HStack(spacing: 6) {
                    selectionMark(size: 14)
                    Text(compactSelectionLabel)
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 8, weight: .bold))
                }
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose model")
        .accessibilityValue(selectionLabel)
        .sheet(isPresented: $isPresented) {
            ModelPickerSheet(
                providers: providers,
                selection: $selection,
                isLoading: isLoading,
                threadSelection: threadSelection
            )
        }
    }

    private var selectedOption: DailyUXModelOption? {
        guard let selection,
              let provider = providers.first(where: { $0.id == selection.providerID }),
              let model = provider.models.first(where: { $0.id == selection.modelID }) else {
            return nil
        }
        return DailyUXModelOption(provider: provider, model: model)
    }

    private var selectionLabel: String {
        guard let selectedOption else {
            return selection == nil ? "Automatic" : "Model unavailable"
        }
        let base = "\(selectedOption.provider.name) · \(selectedOption.model.name)"
        guard let selection,
              let summary = DailyUXModelOptions.summary(
                for: selectedOption.model,
                selections: selection.options
              ) else {
            return base
        }
        return "\(base) · \(summary)"
    }

    private var compactSelectionLabel: String {
        guard let selectedOption else {
            return selection == nil ? "Automatic" : "Choose model"
        }
        guard let selection,
              let summary = DailyUXModelOptions.summary(
                for: selectedOption.model,
                selections: selection.options
              ) else {
            return selectedOption.model.name
        }
        return "\(selectedOption.model.name) · \(summary)"
    }

    @ViewBuilder
    private func selectionMark(size: CGFloat) -> some View {
        if let provider = selectedOption?.provider {
            ProviderIcon(
                driver: provider.driver,
                providerID: provider.id,
                fallbackName: provider.name,
                size: size
            )
        } else {
            Image(systemName: selection == nil ? "wand.and.stars" : "cpu")
                .font(.system(size: size * 0.72, weight: .semibold))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: size, height: size)
        }
    }
}

private struct ModelPickerSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let providers: [FeatureProvider]
    @Binding var selection: FeatureSelection?
    let isLoading: Bool
    let threadSelection: FeatureSelection?

    @AppStorage("swift-ios.model-picker.favorites") private var favoriteStorage = ""
    @AppStorage("swift-ios.model-picker.recents") private var recentStorage = ""
    @State private var query = ""
    @State private var configuring: DailyUXModelOption?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading, availableModelCount == 0 {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Loading models")
                            .font(T3Typography.control)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if availableModelCount == 0 {
                    ContentUnavailableView(
                        "No models available",
                        systemImage: "cpu",
                        description: Text("Check the providers enabled on this environment.")
                    )
                } else {
                    modelList
                }
            }
            .background(T3Colors.background)
            .navigationTitle("Choose model")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search models")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationDestination(item: $configuring) { option in
                ModelConfigurationView(
                    option: option,
                    currentSelection: selection
                ) { configuredSelection in
                    selection = configuredSelection
                    recordRecent(option.id)
                    dismiss()
                }
            }
            .t3NavigationChrome()
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }

    private var modelList: some View {
        List {
            if query.isEmpty {
                Section {
                    Button {
                        selection = nil
                        dismiss()
                    } label: {
                        ModelAutomaticRow(isSelected: selection == nil)
                    }
                    .buttonStyle(.plain)
                    .disabled(modelChangesAreLocked)
                    .opacity(modelChangesAreLocked ? 0.36 : 1)
                }
            }

            if modelChangesAreLocked {
                Section {
                    Label(
                        "This provider fixes the model when a task starts.",
                        systemImage: "lock"
                    )
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                }
            }

            if !catalog.favorites.isEmpty {
                Section("Favorites") {
                    ForEach(catalog.favorites) { option in
                        modelRow(option)
                    }
                }
            }

            if !catalog.recents.isEmpty {
                Section("Recent") {
                    ForEach(catalog.recents) { option in
                        modelRow(option)
                    }
                }
            }

            ForEach(catalog.providerGroups, id: \.provider.id) { group in
                Section(group.provider.name) {
                    ForEach(group.models) { option in
                        modelRow(option)
                    }
                }
            }

            if catalog.all.isEmpty {
                ContentUnavailableView.search(text: query)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
    }

    private var availableModelCount: Int {
        providers
            .filter(\.isAvailable)
            .reduce(into: 0) { count, provider in
                count += provider.models.count
            }
    }

    private func modelRow(_ option: DailyUXModelOption) -> some View {
        HStack(spacing: 10) {
            Button {
                select(option)
            } label: {
                ModelOptionLabel(
                    option: option,
                    isSelected: selection?.providerID == option.provider.id
                        && selection?.modelID == option.model.id
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                toggleFavorite(option.id)
            } label: {
                Image(systemName: favoriteIDs.contains(option.id) ? "star.fill" : "star")
                    .font(.system(size: 15))
                    .foregroundStyle(
                        favoriteIDs.contains(option.id)
                            ? T3Colors.warning
                            : T3Colors.textTertiary
                    )
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(
                favoriteIDs.contains(option.id) ? "Remove favorite" : "Add favorite"
            )
        }
        .disabled(isLocked(option))
        .opacity(isLocked(option) ? 0.36 : 1)
        .listRowBackground(T3Colors.background)
    }

    private var favoriteIDs: Set<String> {
        Set(favoriteStorage.split(separator: "\n").map(String.init))
    }

    private var recentIDs: [String] {
        recentStorage.split(separator: "\n").map(String.init)
    }

    private var catalog: DailyUXModelCatalog {
        DailyUXModelCatalog(
            providers: providers,
            query: query,
            favoriteIDs: favoriteIDs,
            recentIDs: recentIDs
        )
    }

    private func select(_ option: DailyUXModelOption) {
        guard !isLocked(option) else { return }
        if option.model.options.isEmpty {
            selection = FeatureSelection(providerID: option.provider.id, modelID: option.model.id)
            recordRecent(option.id)
            dismiss()
        } else {
            configuring = option
        }
    }

    private func recordRecent(_ id: String) {
        recentStorage = ([id] + recentIDs.filter { $0 != id })
            .prefix(8)
            .joined(separator: "\n")
    }

    private var modelChangesAreLocked: Bool {
        guard let threadSelection,
              let provider = providers.first(where: { $0.id == threadSelection.providerID }) else {
            return false
        }
        return provider.requiresNewThreadForModelChange
    }

    private func isLocked(_ option: DailyUXModelOption) -> Bool {
        guard modelChangesAreLocked, let threadSelection else { return false }
        return option.provider.id != threadSelection.providerID
            || option.model.id != threadSelection.modelID
    }

    private func toggleFavorite(_ id: String) {
        var next = favoriteIDs
        if next.contains(id) {
            next.remove(id)
        } else {
            next.insert(id)
        }
        favoriteStorage = next.sorted().joined(separator: "\n")
    }
}

private struct ModelConfigurationView: View {
    let option: DailyUXModelOption
    let onConfirm: (FeatureSelection) -> Void
    @State private var optionSelections: [FeatureModelOptionSelection]

    init(
        option: DailyUXModelOption,
        currentSelection: FeatureSelection?,
        onConfirm: @escaping (FeatureSelection) -> Void
    ) {
        self.option = option
        self.onConfirm = onConfirm
        if currentSelection?.providerID == option.provider.id,
           currentSelection?.modelID == option.model.id {
            _optionSelections = State(initialValue: currentSelection?.options ?? [])
        } else {
            _optionSelections = State(initialValue: DailyUXModelOptions.defaults(for: option.model))
        }
    }

    var body: some View {
        Form {
            Section {
                ModelOptionLabel(option: option, isSelected: false)
            }

            ForEach(option.model.options) { descriptor in
                Section {
                    switch descriptor.kind {
                    case .select:
                        Picker(
                            descriptor.label,
                            selection: stringBinding(for: descriptor)
                        ) {
                            ForEach(descriptor.choices) { choice in
                                VStack(alignment: .leading) {
                                    Text(choice.label)
                                    if let detail = choice.detail {
                                        Text(detail)
                                    }
                                }
                                .tag(choice.id)
                            }
                        }
                        .pickerStyle(.navigationLink)
                    case .boolean:
                        Toggle(
                            descriptor.label,
                            isOn: booleanBinding(for: descriptor)
                        )
                    }
                } footer: {
                    if let detail = descriptor.detail {
                        Text(detail)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .navigationTitle("Model options")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Use model") {
                    onConfirm(
                        FeatureSelection(
                            providerID: option.provider.id,
                            modelID: option.model.id,
                            options: optionSelections
                        )
                    )
                }
                .fontWeight(.semibold)
            }
        }
    }

    private func stringBinding(
        for descriptor: FeatureModelOptionDescriptor
    ) -> Binding<String> {
        Binding(
            get: {
                guard case let .string(value) = DailyUXModelOptions.value(
                    for: descriptor,
                    in: optionSelections
                ) else {
                    return ""
                }
                return value
            },
            set: { value in
                optionSelections = DailyUXModelOptions.updating(
                    optionSelections,
                    id: descriptor.id,
                    value: .string(value)
                )
            }
        )
    }

    private func booleanBinding(
        for descriptor: FeatureModelOptionDescriptor
    ) -> Binding<Bool> {
        Binding(
            get: {
                guard case let .boolean(value) = DailyUXModelOptions.value(
                    for: descriptor,
                    in: optionSelections
                ) else {
                    return false
                }
                return value
            },
            set: { value in
                optionSelections = DailyUXModelOptions.updating(
                    optionSelections,
                    id: descriptor.id,
                    value: .boolean(value)
                )
            }
        )
    }
}

private struct ModelAutomaticRow: View {
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "wand.and.stars")
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text("Automatic")
                    .font(T3Typography.homeTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                Text("Use the environment default")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            Spacer()
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.bold))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }
}

private struct ModelOptionLabel: View {
    let option: DailyUXModelOption
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            providerMark
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(option.model.name)
                        .font(T3Typography.homeTitle)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    if option.model.supportsReasoning {
                        capability("Reasoning", icon: "brain")
                    }
                    if option.model.supportsImages {
                        capability("Images", icon: "photo")
                    }
                }
                Text(option.model.detail ?? option.model.id)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(T3Colors.textPrimary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    private var providerMark: some View {
        ProviderIcon(
            driver: option.provider.driver,
            providerID: option.provider.id,
            fallbackName: option.provider.name,
            size: 26
        )
    }

    private func capability(_ title: String, icon: String) -> some View {
        Label(title, systemImage: icon)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
    }
}
