import Foundation
import Observation

@MainActor
@Observable
public final class FeatureRootModel {
    public private(set) var snapshot = FeatureSnapshot()
    public private(set) var details: [String: FeatureThreadDetail] = [:]
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
            snapshot = try await client.initialSnapshot()
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
            snapshot = try await client.initialSnapshot()
        } catch {
            if !Self.isBenignCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
    }

    public func pair(endpoint: String, token: String?) async -> Bool {
        await perform {
            try await client.pair(endpoint: endpoint, token: token)
            details.removeAll()
            snapshot = try await client.initialSnapshot()
        }
    }

    public func activateEnvironment(_ id: String) async {
        await perform {
            try await client.activateEnvironment(id: id)
            snapshot = try await client.initialSnapshot()
            details.removeAll()
        }
    }

    public func removeEnvironment(_ id: String) async {
        await perform {
            try await client.removeEnvironment(id: id)
            snapshot = try await client.initialSnapshot()
            details.removeAll()
        }
    }

    public func disconnect() async {
        isManagingConnections = false
        await client.disconnect()
        snapshot = FeatureSnapshot(
            environments: snapshot.environments,
            settings: snapshot.settings
        )
        details.removeAll()
    }

    public func setConnectionManagementPresented(_ isPresented: Bool) {
        isManagingConnections = isPresented
    }

    public func addProject(path: String) async -> Bool {
        await perform {
            try await client.addProject(path: path)
            snapshot = try await client.initialSnapshot()
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
                runtimeMode: request.runtimeMode,
                interactionMode: request.interactionMode,
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
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].title = title
            details[id]?.thread.title = title
        }
    }

    public func setArchived(_ id: String, archived: Bool) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadArchived(id: id, archived: archived)
            guard currentEnvironmentIdentity == environment else { return }
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].isArchived = archived
            details[id]?.thread.isArchived = archived
        }
    }

    public func setSettled(_ id: String, settled: Bool) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadSettled(id: id, settled: settled)
            guard currentEnvironmentIdentity == environment else { return }
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].isSettled = settled
            snapshot.threads[index].keepsActive = !settled
            snapshot.threads[index].settledAt = settled ? .now : nil
            details[id]?.thread.isSettled = settled
            details[id]?.thread.keepsActive = !settled
            details[id]?.thread.settledAt = settled ? .now : nil
        }
    }

    public func setSnoozed(_ id: String, until: Date?) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setThreadSnoozed(id: id, until: until)
            guard currentEnvironmentIdentity == environment else { return }
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            let snoozedAt = until.map { _ in Date.now }
            snapshot.threads[index].snoozedUntil = until
            snapshot.threads[index].snoozedAt = snoozedAt
            details[id]?.thread.snoozedUntil = until
            details[id]?.thread.snoozedAt = snoozedAt
        }
    }

    public func setRuntimeMode(_ id: String, mode: FeatureRuntimeMode) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setRuntimeMode(id: id, mode: mode)
            guard currentEnvironmentIdentity == environment else { return }
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].runtimeMode = mode
            details[id]?.thread.runtimeMode = mode
        }
    }

    public func setInteractionMode(_ id: String, mode: FeatureInteractionMode) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.setInteractionMode(id: id, mode: mode)
            guard currentEnvironmentIdentity == environment else { return }
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].interactionMode = mode
            details[id]?.thread.interactionMode = mode
        }
    }

    public func deleteThread(_ id: String) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.deleteThread(id: id)
            guard currentEnvironmentIdentity == environment else { return }
            snapshot.threads.removeAll { $0.id == id }
            details[id] = nil
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
            details[id] = detail
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
        details[submission.threadID]?.messages.append(optimistic)

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
            details[submission.threadID]?.messages.removeAll { $0.id == optimisticID }
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
            for key in details.keys {
                details[key]?.approvals.removeAll { $0.id == id }
            }
        }
    }

    public func resolveUserInput(_ id: String, answers: [String: FeatureInputAnswer]) async {
        let environment = currentEnvironmentIdentity
        await perform {
            try await client.resolveUserInput(id: id, answers: answers)
            guard currentEnvironmentIdentity == environment else { return }
            for key in details.keys {
                details[key]?.userInputs.removeAll { $0.id == id }
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
            snapshot = value
        case let .connection(value):
            snapshot.connection = value
        case let .thread(value):
            upsert(value)
            if details[value.id] != nil {
                details[value.id]?.thread = value
            }
        case let .threadRemoved(id):
            snapshot.threads.removeAll { $0.id == id }
            details[id] = nil
        case let .detail(value):
            details[value.thread.id] = value
            upsert(value.thread)
        case let .failure(message):
            errorMessage = message
        }
    }

    private func upsert(_ thread: FeatureThread) {
        if let index = snapshot.threads.firstIndex(where: { $0.id == thread.id }) {
            snapshot.threads[index] = thread
        } else {
            snapshot.threads.append(thread)
        }
    }
}

private extension FeatureDraftAttachment {
    var upload: FeatureUploadAttachment {
        FeatureUploadAttachment(data: data, name: filename, mimeType: mimeType)
    }
}
