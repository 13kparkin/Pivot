import Foundation

public struct FeatureDraftAttachment: Identifiable, Sendable, Equatable {
    public let id: UUID
    public var data: Data
    public var filename: String
    public var mimeType: String

    public init(
        id: UUID = UUID(),
        data: Data,
        filename: String,
        mimeType: String
    ) {
        self.id = id
        self.data = data
        self.filename = filename
        self.mimeType = mimeType
    }

    public var byteCount: Int {
        data.count
    }
}

public struct NewTaskRequest: Sendable, Equatable {
    public var projectID: String
    public var prompt: String
    public var selection: FeatureSelection?
    public var runtimeMode: FeatureRuntimeMode
    public var interactionMode: FeatureInteractionMode
    public var attachments: [FeatureDraftAttachment]

    public init(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureDraftAttachment] = []
    ) {
        self.projectID = projectID
        self.prompt = prompt
        self.selection = selection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.attachments = attachments
    }

    public var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public struct FeatureMessageSubmission: Sendable, Equatable {
    public var threadID: String
    public var text: String
    public var selection: FeatureSelection?
    public var attachments: [FeatureDraftAttachment]

    public init(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureDraftAttachment] = []
    ) {
        self.threadID = threadID
        self.text = text
        self.selection = selection
        self.attachments = attachments
    }
}

struct DailyUXSidebarIndex {
    let active: [FeatureThread]
    let settled: [FeatureThread]
    let searchResults: [FeatureThread]

    init(
        snapshot: FeatureSnapshot,
        query: String,
        projectID: String? = nil,
        now: Date = .now
    ) {
        let projectByID = Dictionary(uniqueKeysWithValues: snapshot.projects.map { ($0.id, $0) })
        let visible = snapshot.threads.filter { thread in
            guard !thread.isArchived else { return false }
            guard thread.snoozedUntil.map({ $0 > now }) != true else { return false }
            return projectID == nil || thread.projectID == projectID
        }

        active = visible
            .filter { !$0.isEffectivelySettled(at: now) }
            .sorted { lhs, rhs in
                if lhs.createdAt != rhs.createdAt {
                    return lhs.createdAt > rhs.createdAt
                }
                return lhs.id < rhs.id
            }

        settled = visible
            .filter { $0.isEffectivelySettled(at: now) }
            .sorted { lhs, rhs in
                if lhs.updatedAt != rhs.updatedAt {
                    return lhs.updatedAt > rhs.updatedAt
                }
                return lhs.id < rhs.id
            }

        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else {
            searchResults = []
            return
        }

        searchResults = (active + settled).filter { thread in
            let project = projectByID[thread.projectID]
            return [
                thread.title,
                thread.preview ?? "",
                project?.name ?? "",
                project?.path ?? "",
            ].contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
        }
    }
}

extension FeatureThread {
    var needsAttention: Bool {
        state == .waitingForApproval || state == .waitingForInput || state == .failed
    }

    func isEffectivelySettled(at now: Date) -> Bool {
        switch state {
        case .queued, .working, .waitingForApproval, .waitingForInput, .failed:
            return false
        case .idle, .completed:
            break
        }
        if isSettled {
            return true
        }
        return now.timeIntervalSince(updatedAt) >= 3 * 24 * 60 * 60
    }
}

struct DailyUXModelOption: Identifiable, Equatable, Hashable {
    let provider: FeatureProvider
    let model: FeatureModel

    var id: String { Self.key(providerID: provider.id, modelID: model.id) }

    static func key(providerID: String, modelID: String) -> String {
        "\(providerID)::\(modelID)"
    }
}

struct DailyUXModelCatalog {
    let all: [DailyUXModelOption]
    let favorites: [DailyUXModelOption]
    let recents: [DailyUXModelOption]
    let providerGroups: [(provider: FeatureProvider, models: [DailyUXModelOption])]

    init(
        providers: [FeatureProvider],
        query: String,
        favoriteIDs: Set<String>,
        recentIDs: [String]
    ) {
        let available = providers.filter(\.isAvailable)
        let unfiltered = available.flatMap { provider in
            provider.models.map { DailyUXModelOption(provider: provider, model: $0) }
        }
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = normalizedQuery.isEmpty
            ? unfiltered
            : unfiltered.filter { option in
                [
                    option.provider.name,
                    option.model.name,
                    option.model.id,
                    option.model.detail ?? "",
                    option.model.supportsImages ? "images vision" : "",
                    option.model.supportsReasoning ? "reasoning thinking" : "",
                ].contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
            }

        all = matches
        favorites = matches.filter { favoriteIDs.contains($0.id) }

        let byID = Dictionary(uniqueKeysWithValues: matches.map { ($0.id, $0) })
        recents = recentIDs.compactMap { byID[$0] }.filter { !favoriteIDs.contains($0.id) }

        providerGroups = available.compactMap { provider in
            let options = matches.filter { $0.provider.id == provider.id }
            return options.isEmpty ? nil : (provider, options)
        }
    }
}

enum DailyUXModelOptions {
    static func validated(
        _ selection: FeatureSelection?,
        in providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard let selection,
              let provider = providers.first(where: {
                  $0.id == selection.providerID && $0.isAvailable
              }),
              provider.models.contains(where: { $0.id == selection.modelID }) else {
            return nil
        }
        return selection
    }

    static func preferredSelection(in providers: [FeatureProvider]) -> FeatureSelection? {
        let available = providers.filter(\.isAvailable)
        let preferred = available.lazy.compactMap { provider in
            provider.models.first(where: \.isDefault).map { (provider, $0) }
        }.first
            ?? available.first.flatMap { provider in
                provider.models.first.map { (provider, $0) }
            }
        guard let (provider, model) = preferred else { return nil }
        return FeatureSelection(
            providerID: provider.id,
            modelID: model.id,
            options: defaults(for: model)
        )
    }

    static func defaults(for model: FeatureModel) -> [FeatureModelOptionSelection] {
        model.options.compactMap { descriptor in
            if let defaultValue = descriptor.defaultValue {
                return FeatureModelOptionSelection(id: descriptor.id, value: defaultValue)
            }
            switch descriptor.kind {
            case .select:
                guard let choice = descriptor.choices.first(where: \.isDefault)
                    ?? descriptor.choices.first else {
                    return nil
                }
                return FeatureModelOptionSelection(id: descriptor.id, value: .string(choice.id))
            case .boolean:
                return FeatureModelOptionSelection(id: descriptor.id, value: .boolean(false))
            }
        }
    }

    static func value(
        for descriptor: FeatureModelOptionDescriptor,
        in selections: [FeatureModelOptionSelection]
    ) -> FeatureModelOptionValue? {
        if let selected = selections.first(where: { $0.id == descriptor.id })?.value {
            return selected
        }
        if let defaultValue = descriptor.defaultValue {
            return defaultValue
        }
        switch descriptor.kind {
        case .select:
            let choice = descriptor.choices.first(where: \.isDefault)
                ?? descriptor.choices.first
            return choice.map { .string($0.id) }
        case .boolean:
            return .boolean(false)
        }
    }

    static func updating(
        _ selections: [FeatureModelOptionSelection],
        id: String,
        value: FeatureModelOptionValue
    ) -> [FeatureModelOptionSelection] {
        var next = selections.filter { $0.id != id }
        next.append(FeatureModelOptionSelection(id: id, value: value))
        return next
    }

    static func summary(
        for model: FeatureModel,
        selections: [FeatureModelOptionSelection]
    ) -> String? {
        let labels = model.options.compactMap { descriptor -> String? in
            guard let value = value(for: descriptor, in: selections) else { return nil }
            switch value {
            case let .string(choiceID):
                return descriptor.choices.first(where: { $0.id == choiceID })?.label
            case let .boolean(isEnabled):
                return isEnabled ? descriptor.label : nil
            }
        }
        return labels.isEmpty ? nil : labels.joined(separator: " · ")
    }

    static func supportsImages(
        selection: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> Bool {
        // Older environments do not advertise image capability. In that case the
        // server remains the source of truth instead of hiding attachments entirely.
        guard providers.lazy.flatMap(\.models).contains(where: \.supportsImages) else {
            return true
        }
        guard let selection,
              let provider = providers.first(where: { $0.id == selection.providerID }),
              let model = provider.models.first(where: { $0.id == selection.modelID }) else {
            return true
        }
        return model.supportsImages
    }
}
