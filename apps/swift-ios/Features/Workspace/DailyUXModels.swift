import Foundation

public struct FeatureDraftAttachment: Identifiable, Sendable, Equatable {
    public let id: UUID
    public var data: Data
    public var thumbnailData: Data?
    public var filename: String
    public var mimeType: String

    public init(
        id: UUID = UUID(),
        data: Data,
        thumbnailData: Data? = nil,
        filename: String,
        mimeType: String
    ) {
        self.id = id
        self.data = data
        self.thumbnailData = thumbnailData
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

enum DailyUXCreationContext {
    static func projects(in snapshot: FeatureSnapshot) -> [FeatureProject] {
        guard !snapshot.environments.isEmpty else { return snapshot.projects }
        let availableEnvironmentIDs = Set(
            snapshot.environments.compactMap { environment in
                let state = environment.isActive
                    ? snapshot.connection.state
                    : environment.connectionState
                return state == .disconnected ? nil : environment.id
            }
        )
        return snapshot.projects.filter {
            availableEnvironmentIDs.contains($0.environmentID)
        }
    }

    static func providers(
        for project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> [FeatureProvider] {
        guard let project,
              let activeID = snapshot.environments.first(where: \.isActive)?.id,
              project.environmentID != activeID else {
            return snapshot.providers
        }
        guard let selection = project.defaultSelection else { return [] }
        return [
            FeatureProvider(
                id: selection.providerID,
                name: selection.providerID,
                driver: selection.providerID,
                models: [
                    FeatureModel(
                        id: selection.modelID,
                        name: selection.modelID,
                        isDefault: true
                    ),
                ]
            ),
        ]
    }

    static func initialSelection(
        for project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> FeatureSelection? {
        if let projectDefault = project?.defaultSelection {
            return projectDefault
        }
        return DailyUXModelOptions.initialSelection(
            projectDefault: nil,
            appDefault: snapshot.settings.defaultSelection,
            providers: providers(for: project, in: snapshot)
        )
    }
}

struct DailyUXSidebarIndex {
    let active: [FeatureThread]
    let snoozed: [FeatureThread]
    let settled: [FeatureThread]
    let searchResults: [FeatureThread]

    var needsInput: [FeatureThread] {
        active.filter {
            $0.state == .waitingForApproval || $0.state == .waitingForInput
        }
    }

    var failed: [FeatureThread] {
        active.filter { $0.state == .failed }
    }

    init(
        snapshot: FeatureSnapshot,
        query: String,
        projectID: String? = nil,
        now: Date = .now
    ) {
        let visible = snapshot.threads.filter { thread in
            guard !thread.isArchived else { return false }
            return projectID == nil || thread.projectID == projectID
        }
        let available = visible.filter { !$0.isEffectivelySnoozed(at: now) }

        active = available
            .filter { !$0.isEffectivelySettled(at: now) }
            .sorted { lhs, rhs in
                if lhs.createdAt != rhs.createdAt {
                    return lhs.createdAt > rhs.createdAt
                }
                return lhs.id < rhs.id
            }

        snoozed = visible
            .filter { $0.isEffectivelySnoozed(at: now) }
            .sorted { lhs, rhs in
                let lhsUntil = lhs.snoozedUntil ?? .distantFuture
                let rhsUntil = rhs.snoozedUntil ?? .distantFuture
                if lhsUntil != rhsUntil {
                    return lhsUntil < rhsUntil
                }
                return lhs.id < rhs.id
            }

        settled = available
            .filter { $0.isEffectivelySettled(at: now) }
            .sorted { lhs, rhs in
                if lhs.settledSortDate != rhs.settledSortDate {
                    return lhs.settledSortDate > rhs.settledSortDate
                }
                return lhs.id < rhs.id
            }

        searchResults = Self.matchingThreads(
            active + snoozed + settled,
            snapshot: snapshot,
            query: query
        )
    }

    static func matchingThreads(
        _ candidates: [FeatureThread],
        snapshot: FeatureSnapshot,
        query: String
    ) -> [FeatureThread] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else { return [] }
        // Aggregate snapshots can include legacy fixtures with duplicate raw IDs.
        // Native projects are environment-scoped, while this defensive reduce
        // keeps search non-crashing for older callers during migration.
        let projectByID = snapshot.projects.reduce(into: [String: FeatureProject]()) {
            $0[$1.id] = $1
        }
        return candidates.filter { thread in
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

enum SidebarRelativeAge {
    static func compact(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<60:
            return "now"
        case ..<3_600:
            return "\(seconds / 60)m"
        case ..<86_400:
            return "\(seconds / 3_600)h"
        case ..<604_800:
            return "\(seconds / 86_400)d"
        case ..<31_536_000:
            return "\(seconds / 604_800)w"
        default:
            return "\(seconds / 31_536_000)y"
        }
    }

    static func accessibility(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<60:
            return "Updated just now"
        case ..<3_600:
            return "Updated \(unit(seconds / 60, singular: "minute")) ago"
        case ..<86_400:
            return "Updated \(unit(seconds / 3_600, singular: "hour")) ago"
        case ..<604_800:
            return "Updated \(unit(seconds / 86_400, singular: "day")) ago"
        case ..<31_536_000:
            return "Updated \(unit(seconds / 604_800, singular: "week")) ago"
        default:
            return "Updated \(unit(seconds / 31_536_000, singular: "year")) ago"
        }
    }

    private static func unit(_ value: Int, singular: String) -> String {
        "\(value) \(singular)\(value == 1 ? "" : "s")"
    }
}

enum HomeThreadStatus: String, Sendable, Equatable {
    case approval
    case input
    case working
    case failed
    case done
    case ready
}

enum HomeWorkingDuration {
    static func compact(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        guard seconds >= 60 else { return "\(seconds)s" }
        let minutes = seconds / 60
        guard minutes >= 60 else { return "\(minutes)m" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }
}

extension FeatureThread {
    var homeStatus: HomeThreadStatus {
        switch state {
        case .queued, .working:
            .working
        case .waitingForApproval:
            .approval
        case .waitingForInput:
            .input
        case .failed:
            .failed
        case .completed:
            .done
        case .idle:
            .ready
        }
    }

    var homeStatusLabel: String? {
        switch homeStatus {
        case .approval: "Approval"
        case .input: "Input"
        case .working: "Working"
        case .failed: "Failed"
        case .done: "Done"
        case .ready: nil
        }
    }

    func homeWorkingDuration(at now: Date) -> String? {
        guard homeStatus == .working, let workingStartedAt else { return nil }
        return HomeWorkingDuration.compact(since: workingStartedAt, now: now)
    }

    func homeEnvironmentLabel(in snapshot: FeatureSnapshot) -> String? {
        let projectEnvironmentID = snapshot.projects
            .first(where: { $0.id == projectID })?
            .environmentID
        if let resolvedID = environmentID ?? projectEnvironmentID,
           let currentName = snapshot.environments.first(where: { $0.id == resolvedID })?.name,
           !currentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return currentName
        }
        guard let environmentName = environmentName?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !environmentName.isEmpty else {
            return nil
        }
        return environmentName
    }

    func homeProviderLabel(in snapshot: FeatureSnapshot) -> String? {
        if let providerName = providerName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !providerName.isEmpty {
            return providerName
        }
        guard let providerID else { return nil }
        return snapshot.providers.first(where: { $0.id == providerID })?.name ?? providerID
    }

    var needsAttention: Bool {
        state == .waitingForApproval || state == .waitingForInput || state == .failed
    }

    func isEffectivelySettled(at now: Date) -> Bool {
        switch state {
        case .queued, .working, .waitingForApproval, .waitingForInput:
            return false
        case .idle, .failed, .completed:
            break
        }
        if isSettled {
            return true
        }
        if keepsActive {
            return false
        }
        guard let lastActivityAt else {
            return false
        }
        return now.timeIntervalSince(lastActivityAt) >= 3 * 24 * 60 * 60
    }

    func isEffectivelySnoozed(at now: Date) -> Bool {
        guard let snoozedUntil, snoozedUntil > now else { return false }
        if state == .waitingForApproval || state == .waitingForInput {
            return false
        }
        if state == .failed,
           let snoozedAt,
           let attentionAt,
           attentionAt > snoozedAt {
            return false
        }
        if let snoozedAt,
           let latestTurnCompletedAt,
           latestTurnCompletedAt > snoozedAt {
            return false
        }
        return true
    }

    var settledSortDate: Date {
        settledAt ?? lastActivityAt ?? updatedAt
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
    static func initialSelection(
        projectDefault: FeatureSelection?,
        appDefault: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        validated(projectDefault, in: providers)
            ?? validated(appDefault, in: providers)
            ?? preferredSelection(in: providers)
    }

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
