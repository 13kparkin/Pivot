import Foundation

/// The app-owned adapter between the native feature layer and T3's WebSocket/Core runtime.
/// Implementations are main-actor isolated so UI state never depends on locking.
@MainActor
public protocol FeatureClient: AnyObject {
    func initialSnapshot() async throws -> FeatureSnapshot
    func events() -> AsyncStream<FeatureEvent>

    func pair(endpoint: String, token: String?) async throws
    func activateEnvironment(id: String) async throws
    func removeEnvironment(id: String) async throws
    func disconnect() async

    func addProject(path: String) async throws
    func createThread(projectID: String, title: String?, selection: FeatureSelection?) async throws -> FeatureThread
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread
    func listWorkspaceBranches(
        projectID: String,
        refresh: Bool
    ) async throws -> [FeatureWorkspaceBranch]
    func renameThread(id: String, title: String) async throws
    func setThreadArchived(id: String, archived: Bool) async throws
    func setThreadSettled(id: String, settled: Bool) async throws
    func setThreadSnoozed(id: String, until: Date?) async throws
    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws
    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws
    func deleteThread(id: String) async throws

    func loadThread(id: String) async throws -> FeatureThreadDetail
    func releaseThread(id: String)
    func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async throws
    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws
    func cancelTurn(threadID: String) async throws
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws
    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws

    func saveSettings(_ settings: FeatureSettings) async throws

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry]
    func readFile(threadID: String, path: String) async throws -> FeatureFileContent
    func loadReview(threadID: String) async throws -> FeatureReview

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus
    func performSourceControlAction(
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus

    func terminalSnapshot(threadID: String) async throws -> FeatureTerminalSnapshot
    func terminalEvents(threadID: String) -> AsyncStream<FeatureTerminalSnapshot>
    func openTerminal(threadID: String, columns: Int, rows: Int) async throws
    func writeTerminal(threadID: String, data: String) async throws
    func resizeTerminal(threadID: String, columns: Int, rows: Int) async throws
    func closeTerminal(threadID: String) async throws
}

public extension FeatureClient {
    func events() -> AsyncStream<FeatureEvent> {
        AsyncStream { continuation in continuation.finish() }
    }

    func activateEnvironment(id: String) async throws {}
    func removeEnvironment(id: String) async throws {}
    func disconnect() async {}
    func addProject(path: String) async throws {}
    func releaseThread(id: String) {}
    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws {}

    /// Keeps simple text-only callers source-compatible while the typed API
    /// preserves multi-select answers as arrays.
    func resolveUserInput(id: String, answers: [String: String]) async throws {
        try await resolveUserInput(
            id: id,
            answers: answers.mapValues(FeatureInputAnswer.text)
        )
    }
    func setThreadSettled(id: String, settled: Bool) async throws {}
    func setThreadSnoozed(id: String, until: Date?) async throws {}
    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws {}
    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws {}

    func listWorkspaceBranches(
        projectID: String,
        refresh: Bool
    ) async throws -> [FeatureWorkspaceBranch] {
        []
    }

    /// Legacy clients still create in the current checkout. Native clients
    /// override this overload to prepare worktrees atomically with the first turn.
    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        try await createThreadAndSend(
            projectID: projectID,
            prompt: prompt,
            selection: selection,
            runtimeMode: runtimeMode,
            interactionMode: interactionMode,
            attachments: attachments
        )
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        let thread = try await createThread(
            projectID: projectID,
            title: prompt,
            selection: selection
        )
        try await sendMessage(
            threadID: thread.id,
            text: prompt,
            selection: selection,
            attachments: attachments
        )
        return thread
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws {
        guard attachments.isEmpty else {
            throw FeatureCapabilityUnavailable("Image attachments")
        }
        try await sendMessage(threadID: threadID, text: text, selection: selection)
    }

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry] {
        throw FeatureCapabilityUnavailable("Files")
    }

    func readFile(threadID: String, path: String) async throws -> FeatureFileContent {
        throw FeatureCapabilityUnavailable("File preview")
    }

    func loadReview(threadID: String) async throws -> FeatureReview {
        throw FeatureCapabilityUnavailable("Review")
    }

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus {
        throw FeatureCapabilityUnavailable("Source control")
    }

    func performSourceControlAction(
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus {
        throw FeatureCapabilityUnavailable("Source control actions")
    }

    func terminalSnapshot(threadID: String) async throws -> FeatureTerminalSnapshot {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func terminalEvents(threadID: String) -> AsyncStream<FeatureTerminalSnapshot> {
        AsyncStream { $0.finish() }
    }

    func openTerminal(threadID: String, columns: Int, rows: Int) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func writeTerminal(threadID: String, data: String) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func resizeTerminal(threadID: String, columns: Int, rows: Int) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }

    func closeTerminal(threadID: String) async throws {
        throw FeatureCapabilityUnavailable("Terminal")
    }
}
