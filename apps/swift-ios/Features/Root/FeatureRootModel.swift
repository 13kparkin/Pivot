import Foundation
import Observation

enum FeatureDetailRenderChange: Equatable {
    case full
    case delta(FeatureDetailDelta)
}

struct FeatureDetailRenderUpdate: Equatable {
    let baseRevision: UInt64
    let revision: UInt64
    let change: FeatureDetailRenderChange
}

@MainActor
@Observable
public final class FeatureRootModel {
    public private(set) var snapshot = FeatureSnapshot()
    public private(set) var details: [String: FeatureThreadDetail] = [:]
    /// Advances whenever a Home presentation input changes.
    public private(set) var homePresentationRevision: UInt64 = 0
    /// Advances when a Home-visible thread is inserted, removed, or changed.
    public private(set) var threadCollectionRevision: UInt64 = 0
    /// Advances for any selected-thread metadata, message, approval, or input change.
    public private(set) var detailRevision: UInt64 = 0
    /// The latest detail revision for each loaded thread.
    public private(set) var detailRevisions: [String: UInt64] = [:]
    private(set) var detailRenderUpdates: [String: FeatureDetailRenderUpdate] = [:]
    public private(set) var isLoading = true
    public private(set) var isPerformingAction = false
    public private(set) var isManagingConnections = false
    public var errorMessage: String?

    let client: any FeatureClient

    public init(client: any FeatureClient) {
        self.client = client
    }

    public func start() async {
        do {
            install(try await client.initialSnapshot())
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
        isLoading = false

        for await event in client.events() {
            apply(event)
        }
    }

    public func reload() async {
        do {
            install(try await client.initialSnapshot())
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
    }

    public func pair(endpoint: String, token: String?) async -> Bool {
        await perform {
            try await client.pair(endpoint: endpoint, token: token)
            clearDetails()
            install(try await client.initialSnapshot())
        }
    }

    public func activateEnvironment(_ id: String) async {
        await perform {
            try await client.activateEnvironment(id: id)
            install(try await client.initialSnapshot())
            clearDetails()
        }
    }

    public func removeEnvironment(_ id: String) async {
        await perform {
            try await client.removeEnvironment(id: id)
            install(try await client.initialSnapshot())
            clearDetails()
        }
    }

    public func disconnect() async {
        isManagingConnections = false
        await client.disconnect()
        install(FeatureSnapshot(
            environments: snapshot.environments,
            settings: snapshot.settings
        ))
        clearDetails()
    }

    public func setConnectionManagementPresented(_ isPresented: Bool) {
        isManagingConnections = isPresented
    }

    public func addProject(path: String) async -> Bool {
        await perform {
            try await client.addProject(path: path)
            install(try await client.initialSnapshot())
        }
    }

    public func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async -> FeatureThread? {
        let environment = currentEnvironmentIdentity
        var created: FeatureThread?
        let succeeded = await perform {
            let thread = try await client.createThread(
                projectID: projectID,
                title: title,
                selection: selection
            )
            guard currentEnvironmentIdentity == environment else {
                throw CancellationError()
            }
            upsert(thread)
            created = thread
        }
        return succeeded ? created : nil
    }

    public func startTask(_ request: NewTaskRequest) async -> FeatureThread? {
        let prompt = request.trimmedPrompt
        guard !prompt.isEmpty || !request.attachments.isEmpty else { return nil }

        let environment = currentEnvironmentIdentity
        var created: FeatureThread?
        let succeeded = await perform(reportError: false) {
            let thread = try await client.createThreadAndSend(
                projectID: request.projectID,
                prompt: prompt,
                selection: request.selection,
                runtimeMode: request.runtimeMode.mobileNormalized,
                interactionMode: request.interactionMode.mobileNormalized,
                attachments: request.attachments.map(\.upload)
            )
            guard currentEnvironmentIdentity == environment else {
                throw CancellationError()
            }
            upsert(thread)
            created = thread
        }
        return succeeded ? created : nil
    }

    public func renameThread(_ id: String, title: String) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.renameThread(id: id, title: title)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.title = title }
        }
    }

    public func setArchived(_ id: String, archived: Bool) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadArchived(id: id, archived: archived)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.isArchived = archived }
        }
    }

    public func setSettled(_ id: String, settled: Bool) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadSettled(id: id, settled: settled)
            guard currentEnvironmentIdentity == environment else { return }
            let settledAt = settled ? Date.now : nil
            mutateThread(id: id) {
                $0.isSettled = settled
                $0.keepsActive = !settled
                $0.settledAt = settledAt
            }
        }
    }

    public func setSnoozed(_ id: String, until: Date?) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadSnoozed(id: id, until: until)
            guard currentEnvironmentIdentity == environment else { return }
            let snoozedAt = until.map { _ in Date.now }
            mutateThread(id: id) {
                $0.snoozedUntil = until
                $0.snoozedAt = snoozedAt
            }
        }
    }

    public func setRuntimeMode(_ id: String, mode: FeatureRuntimeMode) async {
        let mode = mode.mobileNormalized
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setRuntimeMode(id: id, mode: mode)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.runtimeMode = mode }
        }
    }

    public func setInteractionMode(_ id: String, mode: FeatureInteractionMode) async {
        let mode = mode.mobileNormalized
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setInteractionMode(id: id, mode: mode)
            guard currentEnvironmentIdentity == environment else { return }
            mutateThread(id: id) { $0.interactionMode = mode }
        }
    }

    public func deleteThread(_ id: String) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.deleteThread(id: id)
            guard currentEnvironmentIdentity == environment else { return }
            removeThread(id: id)
            removeDetail(id: id)
        }
    }

    public func detail(for id: String, force: Bool = false) async -> FeatureThreadDetail? {
        if !force, let cached = details[id] {
            return cached
        }
        let environment = currentEnvironmentIdentity
        do {
            let detail = try await client.loadThread(id: id)
            guard currentEnvironmentIdentity == environment else {
                return details[id]
            }
            store(detail)
            upsert(detail.thread)
            return detail
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return details[id]
        }
    }

    /// Ends any selected-thread transport work when its detail view closes.
    public func releaseThread(_ id: String) {
        client.releaseThread(id: id)
    }

    public func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async -> Bool {
        await sendMessage(
            FeatureMessageSubmission(
                threadID: threadID,
                text: text,
                selection: selection
            )
        )
    }

    public func sendMessage(_ submission: FeatureMessageSubmission) async -> Bool {
        let trimmed = submission.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !submission.attachments.isEmpty else { return false }

        let environment = currentEnvironmentIdentity
        let optimisticID = "local-\(UUID().uuidString)"
        let optimistic = FeatureMessage(
            id: optimisticID,
            role: .user,
            text: trimmed,
            state: .queued,
            attachments: submission.attachments.map {
                FeatureMessageAttachment(
                    id: $0.id.uuidString,
                    name: $0.filename,
                    mimeType: $0.mimeType,
                    sizeBytes: $0.byteCount
                )
            }
        )
        mutateDetail(
            id: submission.threadID,
            change: .delta(FeatureDetailDelta(
                changedMessages: [optimistic],
                appendedMessageIDs: [optimistic.id]
            ))
        ) {
            $0.messages.append(optimistic)
        }

        let sent = await perform(reportError: false) {
            try await client.sendMessage(
                threadID: submission.threadID,
                text: trimmed,
                selection: submission.selection,
                attachments: submission.attachments.map(\.upload)
            )
        }
        if !sent {
            guard currentEnvironmentIdentity == environment else { return false }
            mutateDetail(id: submission.threadID) {
                $0.messages.removeAll { $0.id == optimisticID }
            }
        }
        return sent
    }

    public func cancelTurn(threadID: String) async {
        await perform {
            try await client.cancelTurn(threadID: threadID)
        }
    }

    public func resolveApproval(_ id: String, decision: FeatureApprovalDecision) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.resolveApproval(id: id, decision: decision)
            guard currentEnvironmentIdentity == environment else { return }
            for key in Array(details.keys) {
                mutateDetail(
                    id: key,
                    change: .delta(FeatureDetailDelta(changedMessages: []))
                ) {
                    $0.approvals.removeAll { $0.id == id }
                }
            }
        }
    }

    public func resolveUserInput(_ id: String, answers: [String: FeatureInputAnswer]) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.resolveUserInput(id: id, answers: answers)
            guard currentEnvironmentIdentity == environment else { return }
            for key in Array(details.keys) {
                mutateDetail(
                    id: key,
                    change: .delta(FeatureDetailDelta(changedMessages: []))
                ) {
                    $0.userInputs.removeAll { $0.id == id }
                }
            }
        }
    }

    /// Convenience for callers that only submit free-form or single-select text.
    public func resolveUserInput(_ id: String, answers: [String: String]) async {
        await resolveUserInput(
            id,
            answers: answers.mapValues(FeatureInputAnswer.text)
        )
    }

    public func saveSettings(_ settings: FeatureSettings) async {
        await perform {
            try await client.saveSettings(settings)
            snapshot.settings = settings
        }
    }

    @discardableResult
    private func perform(
        reportError: Bool = true,
        _ operation: () async throws -> Void
    ) async -> Bool {
        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            try await operation()
            return true
        } catch {
            if reportError, !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
            return false
        }
    }

    private static func isBenignCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        let message = error.localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return message == "cancelled" || message == "canceled"
    }

    private var currentEnvironmentIdentity: String {
        let active = snapshot.environments.first(where: \.isActive)
        return [
            active?.id,
            active?.endpoint,
            snapshot.connection.endpoint,
        ]
        .compactMap { $0 }
        .joined(separator: "|")
    }

    private func apply(_ event: FeatureEvent) {
        switch event {
        case let .snapshot(value):
            install(value)
        case let .connection(value):
            guard snapshot.connection != value else { return }
            snapshot.connection = value
            homePresentationRevision &+= 1
        case let .thread(value):
            upsert(value)
            mutateDetail(
                id: value.id,
                change: .delta(FeatureDetailDelta(changedMessages: []))
            ) {
                $0.thread = value
            }
        case let .threadRemoved(id):
            removeThread(id: id)
            removeDetail(id: id)
        case let .detail(value):
            store(value)
            upsert(value.thread)
        case let .detailDelta(value, delta):
            store(value, delta: delta)
            upsert(value.thread)
        case let .failure(message):
            errorMessage = message
        }
    }

    private func upsert(_ thread: FeatureThread) {
        if let index = snapshot.threads.firstIndex(where: { $0.id == thread.id }) {
            let previous = snapshot.threads[index]
            guard previous != thread else { return }
            snapshot.threads[index] = thread
            if previous.projectID != thread.projectID {
                adjustProjectCount(id: previous.projectID, by: -1)
                adjustProjectCount(id: thread.projectID, by: 1)
            }
        } else {
            snapshot.threads.append(thread)
            adjustProjectCount(id: thread.projectID, by: 1)
        }
        threadCollectionRevision &+= 1
        homePresentationRevision &+= 1
    }

    private func removeThread(id: String) {
        guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
        let projectID = snapshot.threads[index].projectID
        snapshot.threads.remove(at: index)
        adjustProjectCount(id: projectID, by: -1)
        threadCollectionRevision &+= 1
        homePresentationRevision &+= 1
    }

    private func adjustProjectCount(id: String, by delta: Int) {
        guard let index = snapshot.projects.firstIndex(where: { $0.id == id }) else { return }
        snapshot.projects[index].threadCount = max(0, snapshot.projects[index].threadCount + delta)
    }

    private func install(_ value: FeatureSnapshot) {
        if snapshot.connection != value.connection
            || snapshot.environments != value.environments
            || snapshot.projects != value.projects
            || snapshot.providers != value.providers
            || snapshot.threads != value.threads {
            homePresentationRevision &+= 1
        }
        if snapshot.threads != value.threads {
            threadCollectionRevision &+= 1
        }
        snapshot = value
    }

    private func mutateThread(
        id: String,
        _ mutation: (inout FeatureThread) -> Void
    ) {
        if let index = snapshot.threads.firstIndex(where: { $0.id == id }) {
            let previous = snapshot.threads[index]
            mutation(&snapshot.threads[index])
            if snapshot.threads[index] != previous {
                threadCollectionRevision &+= 1
                homePresentationRevision &+= 1
            }
        }
        mutateDetail(
            id: id,
            change: .delta(FeatureDetailDelta(changedMessages: []))
        ) {
            mutation(&$0.thread)
        }
    }

    private func store(_ incoming: FeatureThreadDetail) {
        let id = incoming.thread.id
        let next = details[id].map { current in
            FeatureThreadDetail(
                thread: incoming.thread,
                messages: replacingChangedSuffix(current.messages, with: incoming.messages),
                approvals: replacingChangedSuffix(current.approvals, with: incoming.approvals),
                userInputs: replacingChangedSuffix(current.userInputs, with: incoming.userInputs)
            )
        } ?? incoming
        guard details[id] != next else { return }
        details[id] = next
        bumpDetailRevision(id: id, change: .full)
    }

    private func store(_ incoming: FeatureThreadDetail, delta: FeatureDetailDelta) {
        let id = incoming.thread.id
        details[id] = incoming
        bumpDetailRevision(id: id, change: .delta(delta))
    }

    private func mutateDetail(
        id: String,
        change: FeatureDetailRenderChange = .full,
        _ mutation: (inout FeatureThreadDetail) -> Void
    ) {
        guard var detail = details[id] else { return }
        let previous = detail
        mutation(&detail)
        guard detail != previous else { return }
        details[id] = detail
        bumpDetailRevision(id: id, change: change)
    }

    private func removeDetail(id: String) {
        guard details.removeValue(forKey: id) != nil else { return }
        bumpDetailRevision(id: id, change: .full)
    }

    private func clearDetails() {
        guard !details.isEmpty else { return }
        details.removeAll()
        detailRevision &+= 1
        detailRevisions.removeAll()
        detailRenderUpdates.removeAll()
    }

    private func bumpDetailRevision(id: String, change: FeatureDetailRenderChange) {
        let baseRevision = detailRevisions[id] ?? 0
        detailRevision &+= 1
        detailRevisions[id] = detailRevision
        detailRenderUpdates[id] = FeatureDetailRenderUpdate(
            baseRevision: baseRevision,
            revision: detailRevision,
            change: change
        )
    }

    private func replacingChangedSuffix<Element: Equatable>(
        _ current: [Element],
        with incoming: [Element]
    ) -> [Element] {
        guard current != incoming else { return current }
        let prefixCount = zip(current, incoming).prefix { pair in
            pair.0 == pair.1
        }.count
        var result = current
        result.replaceSubrange(prefixCount..., with: incoming.dropFirst(prefixCount))
        return result
    }
}

private extension FeatureDraftAttachment {
    var upload: FeatureUploadAttachment {
        FeatureUploadAttachment(data: data, name: filename, mimeType: mimeType)
    }
}
