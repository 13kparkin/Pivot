import Foundation
import Observation

@MainActor
@Observable
public final class FeatureRootModel {
    public private(set) var snapshot = FeatureSnapshot()
    public private(set) var details: [String: FeatureThreadDetail] = [:]
    public private(set) var isLoading = true
    public private(set) var isPerformingAction = false
    public var errorMessage: String?

    let client: any FeatureClient

    public init(client: any FeatureClient) {
        self.client = client
    }

    public func start() async {
        do {
            snapshot = try await client.initialSnapshot()
        } catch {
            errorMessage = error.localizedDescription
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
            errorMessage = error.localizedDescription
        }
    }

    public func pair(endpoint: String, token: String?) async -> Bool {
        await perform {
            try await client.pair(endpoint: endpoint, token: token)
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
        await client.disconnect()
        snapshot.connection = .init()
        details.removeAll()
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
        var created: FeatureThread?
        let succeeded = await perform {
            let thread = try await client.createThread(
                projectID: projectID,
                title: title,
                selection: selection
            )
            upsert(thread)
            created = thread
        }
        return succeeded ? created : nil
    }

    public func startTask(_ request: NewTaskRequest) async -> FeatureThread? {
        let prompt = request.trimmedPrompt
        guard !prompt.isEmpty || !request.attachments.isEmpty else { return nil }

        var created: FeatureThread?
        let succeeded = await perform {
            let thread = try await client.createThreadAndSend(
                projectID: request.projectID,
                prompt: prompt,
                selection: request.selection,
                runtimeMode: request.runtimeMode,
                interactionMode: request.interactionMode,
                attachments: request.attachments.map(\.upload)
            )
            upsert(thread)
            created = thread
        }
        return succeeded ? created : nil
    }

    public func renameThread(_ id: String, title: String) async {
        await perform {
            try await client.renameThread(id: id, title: title)
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].title = title
            details[id]?.thread.title = title
        }
    }

    public func setArchived(_ id: String, archived: Bool) async {
        await perform {
            try await client.setThreadArchived(id: id, archived: archived)
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].isArchived = archived
            details[id]?.thread.isArchived = archived
        }
    }

    public func setSettled(_ id: String, settled: Bool) async {
        await perform {
            try await client.setThreadSettled(id: id, settled: settled)
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].isSettled = settled
            details[id]?.thread.isSettled = settled
        }
    }

    public func setSnoozed(_ id: String, until: Date?) async {
        await perform {
            try await client.setThreadSnoozed(id: id, until: until)
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].snoozedUntil = until
            details[id]?.thread.snoozedUntil = until
        }
    }

    public func setRuntimeMode(_ id: String, mode: FeatureRuntimeMode) async {
        await perform {
            try await client.setRuntimeMode(id: id, mode: mode)
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].runtimeMode = mode
            details[id]?.thread.runtimeMode = mode
        }
    }

    public func setInteractionMode(_ id: String, mode: FeatureInteractionMode) async {
        await perform {
            try await client.setInteractionMode(id: id, mode: mode)
            guard let index = snapshot.threads.firstIndex(where: { $0.id == id }) else { return }
            snapshot.threads[index].interactionMode = mode
            details[id]?.thread.interactionMode = mode
        }
    }

    public func deleteThread(_ id: String) async {
        await perform {
            try await client.deleteThread(id: id)
            snapshot.threads.removeAll { $0.id == id }
            details[id] = nil
        }
    }

    public func detail(for id: String, force: Bool = false) async -> FeatureThreadDetail? {
        if !force, let cached = details[id] {
            return cached
        }
        do {
            let detail = try await client.loadThread(id: id)
            details[id] = detail
            upsert(detail.thread)
            return detail
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
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

        let sent = await perform {
            try await client.sendMessage(
                threadID: submission.threadID,
                text: trimmed,
                selection: submission.selection,
                attachments: submission.attachments.map(\.upload)
            )
        }
        if !sent {
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
        await perform {
            try await client.resolveApproval(id: id, decision: decision)
            for key in details.keys {
                details[key]?.approvals.removeAll { $0.id == id }
            }
        }
    }

    public func resolveUserInput(_ id: String, answers: [String: String]) async {
        await perform {
            try await client.resolveUserInput(id: id, answers: answers)
            for key in details.keys {
                details[key]?.userInputs.removeAll { $0.id == id }
            }
        }
    }

    public func saveSettings(_ settings: FeatureSettings) async {
        await perform {
            try await client.saveSettings(settings)
            snapshot.settings = settings
        }
    }

    @discardableResult
    private func perform(_ operation: () async throws -> Void) async -> Bool {
        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            try await operation()
            return true
        } catch {
            if !Self.isBenignCancellation(error) {
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
