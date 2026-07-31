import Foundation

extension FeatureInputAnswer {
    var jsonValue: JSONValue {
        switch self {
        case let .text(value):
            .string(value)
        case let .selections(values):
            .array(values.map(JSONValue.string))
        }
    }
}

/// Composes the transport-focused Core layer with the UI-focused Features layer.
@MainActor
final class NativeFeatureClient: FeatureClient, FeatureDeviceManaging {
    private let runtime: EnvironmentRuntime
    private let settingsStore: UserDefaults
    private let stream: AsyncStream<FeatureEvent>
    private let continuation: AsyncStream<FeatureEvent>.Continuation

    private var activeEnvironment: Environment?
    private var client: T3Client?
    private var latestShell: OrchestrationShellSnapshot?
    private var environmentClients: [String: T3Client] = [:]
    private var shellsByEnvironmentID: [String: OrchestrationShellSnapshot] = [:]
    private var archivedThreadsByEnvironmentID: [String: [FeatureThread]] = [:]
    private var threadEnvironmentIDs: [String: String] = [:]
    private var environmentConnectionStates: [String: FeatureConnection.State] = [:]
    private var environmentConnectionDetails: [String: String] = [:]
    private var latestServerConfig: ServerConfigSnapshot?
    private var latestSnapshot: FeatureSnapshot?
    private var activeThreadID: String?
    private var activeThreadEnvironmentID: String?
    private var latestDetails: [String: FeatureThreadDetail] = [:]
    private var attachmentURLs: [AttachmentCacheKey: CachedAttachmentURL] = [:]
    private var pendingBootstrapSubmission: PendingBootstrapSubmission?
    private var pendingTurnSubmissions: [String: PendingTurnSubmission] = [:]
    private var attachmentHydrationTasks: [
        String: (id: UUID, task: Task<Void, Never>)
    ] = [:]
    private var approvalThreadIDs: [String: String] = [:]
    private var inputThreadIDs: [String: String] = [:]
    private var terminalIDs: [String: String] = [:]
    private var terminalSnapshots: [String: FeatureTerminalSnapshot] = [:]
    private var terminalContinuations: [
        String: [UUID: AsyncStream<FeatureTerminalSnapshot>.Continuation]
    ] = [:]
    private var pollingTask: Task<Void, Never>?
    private var fallbackPollingTask: Task<Void, Never>?
    private var configurationTask: Task<Void, Never>?
    private var aggregateRefreshTask: Task<Void, Never>?
    private var archivedRefreshTask: Task<Void, Never>?
    private var detailRefreshTask: Task<Void, Never>?
    private var detailRefreshPending = false
    private var detailRefreshGeneration = 0
    private var environmentGeneration = 0
    private var lastShellEventAt: Date?

    init(
        runtime: EnvironmentRuntime = EnvironmentRuntime(),
        settingsStore: UserDefaults = .standard
    ) {
        self.runtime = runtime
        self.settingsStore = settingsStore
        let pair = AsyncStream<FeatureEvent>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    deinit {
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        archivedRefreshTask?.cancel()
        detailRefreshTask?.cancel()
        attachmentHydrationTasks.values.forEach { $0.task.cancel() }
        continuation.finish()
    }

    func initialSnapshot() async throws -> FeatureSnapshot {
        let environments = try await runtime.environments()
        guard let environment = try await runtime.activeEnvironment(),
              let activeClient = try await runtime.activeClient() else {
            await clearActiveEnvironment()
            let snapshot = disconnectedSnapshot(environments: environments)
            latestSnapshot = snapshot
            return snapshot
        }

        await adoptEnvironment(environment, client: activeClient)
        let generation = environmentGeneration
        let loads = await loadEnvironmentShells(environments)
        guard isCurrentSession(client: activeClient, generation: generation) else {
            throw CancellationError()
        }
        reconcileEnvironmentLoads(loads, savedEnvironments: environments)
        latestShell = shellsByEnvironmentID[environment.id]
        startPolling(activeClient)
        let activeIsReachable = loads.contains {
            $0.environment.id == environment.id && $0.shell != nil
        }
        if activeIsReachable {
            scheduleArchivedRefresh(client: activeClient, environment: environment)
        }
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: activeIsReachable ? .connected : .disconnected,
            connectionDetail: activeIsReachable ? nil : "That server is currently unreachable."
        )
        latestSnapshot = snapshot
        startAggregateRefresh(activeClient)
        return snapshot
    }

    func events() -> AsyncStream<FeatureEvent> {
        stream
    }

    func pair(endpoint: String, token: String?) async throws {
        let pairedClient: T3Client
        if let token, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            pairedClient = try await runtime.pair(
                host: endpoint,
                code: token,
                clientLabel: "T3 Code Swift"
            )
        } else {
            pairedClient = try await runtime.pair(url: endpoint, clientLabel: "T3 Code Swift")
        }
        await adoptEnvironment(pairedClient.environment, client: pairedClient)
        startPolling(pairedClient)
    }

    func activateEnvironment(id: String) async throws {
        let activated = try await runtime.activate(id: id)
        await adoptEnvironment(activated.environment, client: activated)
        startPolling(activated)
    }

    func removeEnvironment(id: String) async throws {
        if activeEnvironment?.id == id {
            await clearActiveEnvironment(disconnectClient: false)
        }
        try await runtime.remove(id: id)
    }

    func disconnect() async {
        await clearActiveEnvironment()
    }

    private func adoptEnvironment(
        _ environment: Environment,
        client newClient: T3Client
    ) async {
        if activeEnvironment?.id == environment.id, client === newClient {
            activeEnvironment = environment
            environmentClients[environment.id] = newClient
            latestShell = shellsByEnvironmentID[environment.id]
            return
        }
        let previousClient = client
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        archivedRefreshTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        aggregateRefreshTask = nil
        archivedRefreshTask = nil
        clearEnvironmentState(preserveEnvironmentSnapshots: true)
        activeEnvironment = environment
        client = newClient
        environmentClients[environment.id] = newClient
        latestShell = shellsByEnvironmentID[environment.id]
        if let previousClient, previousClient !== newClient {
            await previousClient.disconnect()
        }
    }

    private func clearActiveEnvironment(disconnectClient: Bool = true) async {
        let previousClient = client
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        aggregateRefreshTask?.cancel()
        archivedRefreshTask?.cancel()
        pollingTask = nil
        fallbackPollingTask = nil
        configurationTask = nil
        aggregateRefreshTask = nil
        archivedRefreshTask = nil
        clearEnvironmentState()
        client = nil
        activeEnvironment = nil
        if disconnectClient, let previousClient {
            await previousClient.disconnect()
        }
    }

    private func clearEnvironmentState(preserveEnvironmentSnapshots: Bool = false) {
        environmentGeneration &+= 1
        resetDetailRefresh()
        attachmentHydrationTasks.values.forEach { $0.task.cancel() }
        attachmentHydrationTasks.removeAll()
        archivedRefreshTask?.cancel()
        archivedRefreshTask = nil
        latestShell = nil
        lastShellEventAt = nil
        latestServerConfig = nil
        if !preserveEnvironmentSnapshots {
            environmentClients.removeAll()
            shellsByEnvironmentID.removeAll()
            archivedThreadsByEnvironmentID.removeAll()
            threadEnvironmentIDs.removeAll()
            environmentConnectionStates.removeAll()
            environmentConnectionDetails.removeAll()
        }
        latestSnapshot = nil
        activeThreadID = nil
        activeThreadEnvironmentID = nil
        latestDetails.removeAll()
        attachmentURLs.removeAll()
        pendingBootstrapSubmission = nil
        pendingTurnSubmissions.removeAll()
        approvalThreadIDs.removeAll()
        inputThreadIDs.removeAll()
        finishTerminalStreams()
        terminalIDs.removeAll()
        terminalSnapshots.removeAll()
    }

    private func isCurrentSession(client: T3Client, generation: Int) -> Bool {
        guard generation == environmentGeneration, let currentClient = self.client else {
            return false
        }
        return currentClient === client
    }

    private func isKnownClient(
        _ client: T3Client,
        environmentID: String,
        generation: Int
    ) -> Bool {
        generation == environmentGeneration
            && environmentClients[environmentID] === client
    }

    func addProject(path: String) async throws {
        let client = try requireClient()
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NativeFeatureClientError.invalidProjectPath
        }
        let title = URL(fileURLWithPath: trimmed).lastPathComponent
        _ = try await client.createProject(
            title: title.isEmpty ? "Project" : title,
            workspaceRoot: trimmed,
            defaultModel: defaultModelSelection()
        )
        try await refresh(client: client)
    }

    func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async throws -> FeatureThread {
        let client = try requireClient()
        let generation = environmentGeneration
        let threadID = UUID().uuidString
        let model = modelSelection(selection, projectID: projectID)
        let resolvedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let threadTitle = resolvedTitle?.isEmpty == false ? resolvedTitle! : "New thread"
        _ = try await client.createThread(
            threadID: threadID,
            projectID: projectID,
            title: threadTitle,
            model: model,
            runtimeMode: .fullAccess
        )
        let shell = try await client.shellSnapshot()
        guard isCurrentSession(client: client, generation: generation) else {
            throw CancellationError()
        }
        guard let environment = activeEnvironment else {
            throw NativeFeatureClientError.notConnected
        }
        latestShell = shell
        shellsByEnvironmentID[environment.id] = shell
        if let created = shell.threads.first(where: { $0.id == threadID }) {
            let mapped = mapThread(created, environment: environment)
            await emitSnapshot(shell)
            return mapped
        }
        await emitSnapshot(shell, environment: environment)
        return FeatureThread(
            id: threadID,
            projectID: projectID,
            environmentID: activeEnvironment?.id,
            environmentName: activeEnvironment?.label,
            title: threadTitle,
            providerID: model.instanceId,
            providerName: providerDisplayName(model.instanceId),
            modelID: model.model
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
        let client = try requireClient()
        let generation = environmentGeneration
        let model = modelSelection(selection, projectID: projectID)
        let title = Self.title(from: prompt, hasAttachments: !attachments.isEmpty)
        let uploads = try makeUploadAttachments(attachments)
        let runtime = coreRuntimeMode(runtimeMode)
        let interaction = coreInteractionMode(interactionMode)
        let signature = BootstrapSubmissionSignature(
            projectID: projectID,
            prompt: prompt,
            model: model,
            runtimeMode: runtime,
            interactionMode: interaction,
            attachments: attachments
        )
        let pending: PendingBootstrapSubmission
        if let existing = pendingBootstrapSubmission,
           existing.signature == signature {
            pending = existing
        } else {
            pending = PendingBootstrapSubmission(
                signature: signature,
                threadID: UUID().uuidString,
                identity: CommandIdentity()
            )
            pendingBootstrapSubmission = pending
        }

        do {
            _ = try await client.createThreadAndSend(
                threadID: pending.threadID,
                projectID: projectID,
                title: title,
                text: prompt,
                model: model,
                runtimeMode: runtime,
                interactionMode: interaction,
                attachments: uploads,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID,
                createdAt: pending.identity.createdAt
            )
        } catch {
            // A connection can disappear after the server accepted the command
            // but before its reply reaches us. Bootstrap expansion creates the
            // thread before dispatching the stable final turn, so recover an
            // interrupted empty thread by sending only that original turn.
            guard try await recoverBootstrap(
                client: client,
                pending: pending,
                projectID: projectID,
                text: prompt,
                model: model,
                runtimeMode: runtime,
                interactionMode: interaction,
                attachments: uploads
            ) else {
                throw error
            }
        }

        guard isCurrentSession(client: client, generation: generation) else {
            throw CancellationError()
        }
        if pendingBootstrapSubmission?.identity == pending.identity {
            pendingBootstrapSubmission = nil
        }
        // Dispatch acceptance is the commit point. A dropped refresh must not
        // turn a successful first turn into a retry that creates a duplicate.
        if let shell = try? await client.shellSnapshot() {
            guard isCurrentSession(client: client, generation: generation) else {
                throw CancellationError()
            }
            guard let environment = activeEnvironment else {
                throw NativeFeatureClientError.notConnected
            }
            latestShell = shell
            shellsByEnvironmentID[environment.id] = shell
            await emitSnapshot(shell)
            if let created = shell.threads.first(where: { $0.id == pending.threadID }) {
                return mapThread(created, environment: environment)
            }
        }
        return FeatureThread(
            id: pending.threadID,
            projectID: projectID,
            environmentID: activeEnvironment?.id,
            environmentName: activeEnvironment?.label,
            title: title,
            providerID: model.instanceId,
            providerName: providerDisplayName(model.instanceId),
            modelID: model.model,
            modelOptions: mapOptionSelections(model.options),
            runtimeMode: runtimeMode,
            interactionMode: interactionMode
        )
    }

    private func recoverBootstrap(
        client: T3Client,
        pending: PendingBootstrapSubmission,
        projectID: String,
        text: String,
        model: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode,
        attachments: [UploadChatImageAttachment]
    ) async throws -> Bool {
        guard let snapshot = try? await client.threadSnapshot(id: pending.threadID) else {
            return false
        }
        if snapshot.thread.messages.contains(where: {
            $0.id == pending.identity.messageID
        }) {
            return true
        }
        guard snapshot.thread.projectId == projectID,
              snapshot.thread.deletedAt == nil,
              snapshot.thread.messages.isEmpty else {
            return false
        }

        do {
            _ = try await client.sendTurn(
                threadID: pending.threadID,
                text: text,
                runtimeMode: runtimeMode,
                interactionMode: interactionMode,
                model: model,
                attachments: attachments,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID,
                createdAt: pending.identity.createdAt
            )
        } catch {
            guard await messageWasCommitted(
                client: client,
                threadID: pending.threadID,
                messageID: pending.identity.messageID
            ) else {
                throw error
            }
        }
        return true
    }

    func renameThread(id: String, title: String) async throws {
        let client = try requireClient(forThreadID: id)
        _ = try await client.rename(threadID: id, title: title)
        try await refresh(client: client)
    }

    func setThreadArchived(id: String, archived: Bool) async throws {
        let client = try requireClient(forThreadID: id)
        _ = try await client.archive(threadID: id, archived: archived)
        try await refresh(client: client, includeArchived: true)
    }

    func setThreadSettled(id: String, settled: Bool) async throws {
        let client = try requireClient(forThreadID: id)
        _ = try await client.settle(threadID: id, settled: settled)
        try await refresh(client: client)
    }

    func setThreadSnoozed(id: String, until: Date?) async throws {
        let client = try requireClient(forThreadID: id)
        _ = try await client.snooze(threadID: id, until: until)
        try await refresh(client: client)
    }

    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws {
        let client = try requireClient(forThreadID: id)
        _ = try await client.setRuntimeMode(threadID: id, mode: coreRuntimeMode(mode))
        try await refresh(client: client)
        if activeThreadID == id {
            try await refreshThread(id: id, client: client)
        }
    }

    func setInteractionMode(id: String, mode: FeatureInteractionMode) async throws {
        let client = try requireClient(forThreadID: id)
        _ = try await client.setInteractionMode(threadID: id, mode: coreInteractionMode(mode))
        try await refresh(client: client)
        if activeThreadID == id {
            try await refreshThread(id: id, client: client)
        }
    }

    func deleteThread(id: String) async throws {
        let client = try requireClient(forThreadID: id)
        _ = try await client.delete(threadID: id)
        if activeThreadID == id {
            resetDetailRefresh()
            activeThreadID = nil
            activeThreadEnvironmentID = nil
        }
        latestDetails[id] = nil
        try await refresh(client: client, includeArchived: true)
    }

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        let client = try requireClient(forThreadID: id)
        let environment = client.environment
        let generation = environmentGeneration
        resetDetailRefresh()
        activeThreadID = id
        activeThreadEnvironmentID = environment.id
        let snapshot = try await client.threadSnapshot(id: id)
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        let detail = mapDetail(snapshot.thread, environment: environment)
        latestDetails[id] = detail
        scheduleAttachmentHydration(
            in: detail,
            threadID: id,
            client: client,
            environmentID: environment.id
        )
        return detail
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?
    ) async throws {
        try await sendMessage(
            threadID: threadID,
            text: text,
            selection: selection,
            attachments: []
        )
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureUploadAttachment]
    ) async throws {
        let client = try requireClient(forThreadID: threadID)
        let environmentID = client.environment.id
        let generation = environmentGeneration
        guard let shellThread = shellsByEnvironmentID[environmentID]?.threads
            .first(where: { $0.id == threadID }) else {
            throw NativeFeatureClientError.threadNotFound
        }
        let model = selection.map(coreModelSelection)
        let uploads = try makeUploadAttachments(attachments)
        let signature = TurnSubmissionSignature(
            text: text,
            model: model,
            runtimeMode: shellThread.runtimeMode,
            interactionMode: shellThread.interactionMode,
            attachments: attachments
        )
        let pending: PendingTurnSubmission
        if let existing = pendingTurnSubmissions[threadID],
           existing.signature == signature {
            pending = existing
        } else {
            pending = PendingTurnSubmission(
                signature: signature,
                identity: CommandIdentity()
            )
            pendingTurnSubmissions[threadID] = pending
        }

        do {
            _ = try await client.sendTurn(
                threadID: threadID,
                text: text,
                runtimeMode: shellThread.runtimeMode,
                interactionMode: shellThread.interactionMode,
                model: model,
                attachments: uploads,
                commandID: pending.identity.commandID,
                messageID: pending.identity.messageID,
                createdAt: pending.identity.createdAt
            )
        } catch {
            guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
                throw CancellationError()
            }
            guard await messageWasCommitted(
                client: client,
                threadID: threadID,
                messageID: pending.identity.messageID
            ) else {
                // Keep the stable identity. Retrying the same restored draft
                // cannot enqueue a duplicate turn after an ambiguous failure.
                throw error
            }
        }
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        if pendingTurnSubmissions[threadID]?.identity == pending.identity {
            pendingTurnSubmissions[threadID] = nil
        }
        // Live sync reconciles these snapshots. Refreshes are opportunistic
        // after the accepted command so transient reads cannot invite a
        // duplicate user turn.
        try? await refreshThread(id: threadID, client: client)
        try? await refresh(client: client)
    }

    private func messageWasCommitted(
        client: T3Client,
        threadID: String,
        messageID: String
    ) async -> Bool {
        guard let snapshot = try? await client.threadSnapshot(id: threadID) else {
            return false
        }
        return snapshot.thread.messages.contains { $0.id == messageID }
    }

    func cancelTurn(threadID: String) async throws {
        let client = try requireClient(forThreadID: threadID)
        let turnID = shellsByEnvironmentID[client.environment.id]?.threads
            .first(where: { $0.id == threadID })?
            .latestTurn?
            .turnId
        _ = try await client.interrupt(threadID: threadID, turnID: turnID)
        try await refresh(client: client)
    }

    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {
        guard let threadID = approvalThreadIDs[id] else {
            throw NativeFeatureClientError.approvalNotFound
        }
        let client = try requireClient(forThreadID: threadID)
        let wireDecision = switch decision {
        case .allowOnce: "accept"
        case .allowForSession: "acceptForSession"
        case .deny: "decline"
        }
        _ = try await client.respondToApproval(
            threadID: threadID,
            requestID: id,
            decision: wireDecision
        )
        try await refreshThread(id: threadID, client: client)
    }

    func resolveUserInput(id: String, answers: [String: FeatureInputAnswer]) async throws {
        guard let threadID = inputThreadIDs[id] else {
            throw NativeFeatureClientError.inputRequestNotFound
        }
        let client = try requireClient(forThreadID: threadID)
        _ = try await client.respondToUserInput(
            threadID: threadID,
            requestID: id,
            answers: answers.mapValues(\.jsonValue)
        )
        try await refreshThread(id: threadID, client: client)
    }

    func saveSettings(_ settings: FeatureSettings) async throws {
        let data = try JSONEncoder().encode(settings)
        settingsStore.set(data, forKey: Self.settingsKey)
    }

    func loadDeviceSessions() async throws -> [FeatureDeviceSession] {
        let client = try requireClient()
        try await requireScope("access:read", client: client)
        return try await client.clientSessions().map { session in
            FeatureDeviceSession(
                sessionID: session.sessionId,
                label: session.client.label,
                deviceType: FeatureDeviceType(rawValue: session.client.deviceType) ?? .unknown,
                operatingSystem: session.client.os,
                browser: session.client.browser,
                ipAddress: session.client.ipAddress,
                issuedAt: parseDate(session.issuedAt),
                expiresAt: parseDate(session.expiresAt),
                lastConnectedAt: session.lastConnectedAt.map(parseDate),
                isConnected: session.connected,
                isCurrent: session.current
            )
        }
    }

    func revokeDeviceSession(id: String) async throws {
        let client = try requireClient()
        try await requireScope("access:write", client: client)
        guard try await client.revokeClientSession(id: id) else {
            throw NativeFeatureClientError.deviceSessionNotFound
        }
    }

    func revokeOtherDeviceSessions() async throws {
        let client = try requireClient()
        try await requireScope("access:write", client: client)
        _ = try await client.revokeOtherClientSessions()
    }

    func listFiles(threadID: String, path: String?) async throws -> [FeatureFileEntry] {
        let client = try requireClient(forThreadID: threadID)
        let context = try workspaceContext(threadID: threadID)
        let result = try await client.listProjectEntries(cwd: context.cwd)
        return NativeWorkspaceMapper.files(result.entries, directory: path)
    }

    func readFile(threadID: String, path: String) async throws -> FeatureFileContent {
        let client = try requireClient(forThreadID: threadID)
        let context = try workspaceContext(threadID: threadID)
        let result = try await client.readProjectFile(
            cwd: context.cwd,
            relativePath: path
        )
        return FeatureFileContent(
            path: result.relativePath,
            text: result.contents,
            language: NativeWorkspaceMapper.language(for: result.relativePath),
            isTruncated: result.truncated,
            totalBytes: result.byteLength
        )
    }

    func loadReview(threadID: String) async throws -> FeatureReview {
        let client = try requireClient(forThreadID: threadID)
        let context = try workspaceContext(threadID: threadID)
        let preview = try await client.reviewDiffPreview(cwd: context.cwd)
        return NativeWorkspaceMapper.review(preview)
    }

    func sourceControlStatus(threadID: String) async throws -> FeatureSourceControlStatus {
        let client = try requireClient(forThreadID: threadID)
        let context = try workspaceContext(threadID: threadID)
        return NativeWorkspaceMapper.sourceControl(
            try await client.refreshVCSStatus(cwd: context.cwd)
        )
    }

    func performSourceControlAction(
        threadID: String,
        action: FeatureSourceControlAction,
        message: String?
    ) async throws -> FeatureSourceControlStatus {
        let client = try requireClient(forThreadID: threadID)
        let context = try workspaceContext(threadID: threadID)

        if action == .pull {
            _ = try await client.pull(cwd: context.cwd)
        } else {
            let progress = try await client.runGitAction(
                cwd: context.cwd,
                action: NativeWorkspaceMapper.gitAction(action),
                commitMessage: message
            )
            for try await event in progress {
                if event.kind == "action_failed" {
                    throw RPCError.remote(event.message ?? "The source-control action failed.")
                }
            }
        }

        return NativeWorkspaceMapper.sourceControl(
            try await client.refreshVCSStatus(cwd: context.cwd)
        )
    }

    func terminalSnapshot(threadID: String) async throws -> FeatureTerminalSnapshot {
        if let snapshot = terminalSnapshots[threadID] {
            return snapshot
        }
        let context = try workspaceContext(threadID: threadID)
        return FeatureTerminalSnapshot(
            threadID: threadID,
            workingDirectory: context.cwd
        )
    }

    func terminalEvents(threadID: String) -> AsyncStream<FeatureTerminalSnapshot> {
        guard let environmentID = threadEnvironmentIDs[threadID],
              let client = environmentClients[environmentID] else {
            return AsyncStream { continuation in continuation.finish() }
        }
        let generation = environmentGeneration
        return AsyncStream { continuation in
            let subscriptionID = UUID()
            terminalContinuations[threadID, default: [:]][subscriptionID] = continuation
            if let snapshot = terminalSnapshots[threadID] {
                continuation.yield(snapshot)
            }
            let task = Task { [weak self] in
                do {
                    for try await event in await client.terminalEvents() {
                        guard !Task.isCancelled else { break }
                        guard let self else { break }
                        guard self.isKnownClient(
                            client,
                            environmentID: environmentID,
                            generation: generation
                        ) else {
                            break
                        }
                        guard event.threadId == threadID else { continue }
                        if let terminalID = self.terminalIDs[threadID],
                           event.terminalId != nil,
                           event.terminalId != terminalID {
                            continue
                        }
                        let snapshot = self.consumeTerminalEvent(event, threadID: threadID)
                        self.publishTerminal(snapshot, threadID: threadID)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    guard let self else {
                        continuation.finish()
                        return
                    }
                    guard self.isKnownClient(
                        client,
                        environmentID: environmentID,
                        generation: generation
                    ) else {
                        continuation.finish()
                        return
                    }
                    var snapshot = self.terminalSnapshots[threadID]
                        ?? FeatureTerminalSnapshot(threadID: threadID)
                    snapshot.state = .failed
                    snapshot.error = error.localizedDescription
                    self.terminalSnapshots[threadID] = snapshot
                    self.publishTerminal(snapshot, threadID: threadID)
                    continuation.finish()
                }
            }
            continuation.onTermination = { @Sendable [weak self] _ in
                task.cancel()
                Task { @MainActor in
                    self?.terminalContinuations[threadID]?[subscriptionID] = nil
                    if self?.terminalContinuations[threadID]?.isEmpty == true {
                        self?.terminalContinuations[threadID] = nil
                    }
                }
            }
        }
    }

    func openTerminal(threadID: String, columns: Int, rows: Int) async throws {
        let client = try requireClient(forThreadID: threadID)
        let environmentID = client.environment.id
        let generation = environmentGeneration
        let context = try workspaceContext(threadID: threadID)
        let terminalID = terminalIDs[threadID] ?? UUID().uuidString
        terminalIDs[threadID] = terminalID
        let snapshot = try await client.openTerminal(
            threadID: threadID,
            terminalID: terminalID,
            cwd: context.cwd,
            worktreePath: context.worktreePath,
            columns: columns,
            rows: rows
        )
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        let mapped = NativeWorkspaceMapper.terminal(snapshot)
        terminalSnapshots[threadID] = mapped
        publishTerminal(mapped, threadID: threadID)
    }

    func writeTerminal(threadID: String, data: String) async throws {
        let client = try requireClient(forThreadID: threadID)
        let terminalID = try requireTerminalID(threadID: threadID)
        try await client.writeTerminal(
            threadID: threadID,
            terminalID: terminalID,
            data: data
        )
    }

    func resizeTerminal(threadID: String, columns: Int, rows: Int) async throws {
        let client = try requireClient(forThreadID: threadID)
        let terminalID = try requireTerminalID(threadID: threadID)
        try await client.resizeTerminal(
            threadID: threadID,
            terminalID: terminalID,
            columns: columns,
            rows: rows
        )
    }

    func closeTerminal(threadID: String) async throws {
        let client = try requireClient(forThreadID: threadID)
        let environmentID = client.environment.id
        let generation = environmentGeneration
        let terminalID = try requireTerminalID(threadID: threadID)
        try await client.closeTerminal(threadID: threadID, terminalID: terminalID)
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            throw CancellationError()
        }
        terminalIDs[threadID] = nil
        let snapshot = FeatureTerminalSnapshot(threadID: threadID)
        terminalSnapshots[threadID] = snapshot
        publishTerminal(snapshot, threadID: threadID)
    }

    private func requireClient() throws -> T3Client {
        guard let client else { throw NativeFeatureClientError.notConnected }
        return client
    }

    private func requireClient(forThreadID threadID: String) throws -> T3Client {
        guard let environmentID = threadEnvironmentIDs[threadID],
              let client = environmentClients[environmentID] else {
            throw NativeFeatureClientError.threadNotFound
        }
        return client
    }

    private func requireTerminalID(threadID: String) throws -> String {
        guard let terminalID = terminalIDs[threadID] else {
            throw NativeFeatureClientError.terminalNotOpen
        }
        return terminalID
    }

    private func workspaceContext(threadID: String) throws -> (
        cwd: String,
        worktreePath: String?
    ) {
        guard let environmentID = threadEnvironmentIDs[threadID],
              let shell = shellsByEnvironmentID[environmentID],
              let thread = shell.threads.first(where: { $0.id == threadID }),
              let project = shell.projects.first(where: { $0.id == thread.projectId }) else {
            throw NativeFeatureClientError.workspaceNotFound
        }
        return (
            cwd: thread.worktreePath ?? project.workspaceRoot,
            worktreePath: thread.worktreePath
        )
    }

    private func consumeTerminalEvent(
        _ event: TerminalEvent,
        threadID: String
    ) -> FeatureTerminalSnapshot {
        if let coreSnapshot = event.snapshot {
            let snapshot = NativeWorkspaceMapper.terminal(coreSnapshot)
            terminalIDs[threadID] = coreSnapshot.terminalId
            terminalSnapshots[threadID] = snapshot
            return snapshot
        }

        var snapshot = terminalSnapshots[threadID]
            ?? FeatureTerminalSnapshot(threadID: threadID)
        switch event.type {
        case "output":
            snapshot.buffer.append(NativeWorkspaceMapper.terminalText(event.data ?? ""))
        case "exited":
            snapshot.state = .exited
            snapshot.exitCode = event.exitCode
        case "closed":
            snapshot.state = .stopped
        case "error":
            snapshot.state = .failed
            snapshot.error = event.message
        case "cleared":
            snapshot.buffer = ""
        case "activity":
            snapshot.title = event.label ?? snapshot.title
        default:
            break
        }
        terminalSnapshots[threadID] = snapshot
        return snapshot
    }

    private func publishTerminal(
        _ snapshot: FeatureTerminalSnapshot,
        threadID: String
    ) {
        for continuation in terminalContinuations[threadID]?.values ?? [:].values {
            continuation.yield(snapshot)
        }
    }

    private func finishTerminalStreams() {
        for continuations in terminalContinuations.values {
            for continuation in continuations.values {
                continuation.finish()
            }
        }
        terminalContinuations.removeAll()
    }

    private func startPolling(_ activeClient: T3Client) {
        pollingTask?.cancel()
        fallbackPollingTask?.cancel()
        configurationTask?.cancel()
        let generation = environmentGeneration
        pollingTask = Task { [weak self] in
            do {
                await activeClient.connect()
                guard let self,
                      self.isCurrentSession(client: activeClient, generation: generation) else {
                    return
                }
                let sequence = self.latestShell?.snapshotSequence
                for try await item in await activeClient.shellEvents(after: sequence) {
                    guard !Task.isCancelled,
                          self.isCurrentSession(
                              client: activeClient,
                              generation: generation
                          ) else {
                        break
                    }
                    self.lastShellEventAt = .now
                    self.emitConnection(.connected)
                    switch item {
                    case let .snapshot(shell):
                        await self.consume(
                            shell: shell,
                            client: activeClient,
                            refreshActiveThread: true
                        )
                    case .projectUpserted, .projectRemoved, .threadUpserted, .threadRemoved:
                        await self.consume(delta: item, client: activeClient)
                    case .synchronized:
                        break
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // The independent HTTP fallback below keeps the workspace
                // fresh while the socket reconnects.
            }

            guard !Task.isCancelled,
                  let self,
                  self.isCurrentSession(client: activeClient, generation: generation) else {
                return
            }
            self.emitConnection(
                .reconnecting,
                detail: "Live updates paused. Refreshing over HTTP."
            )
        }
        fallbackPollingTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            while !Task.isCancelled {
                guard let self,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
                }
                let socketIsSynchronized =
                    await activeClient.liveConnectionActive()
                    && self.lastShellEventAt != nil
                if !socketIsSynchronized {
                    self.emitConnection(
                        .reconnecting,
                        detail: "Live updates reconnecting. Refreshing over HTTP."
                    )
                    do {
                        let shell = try await activeClient.shellSnapshot()
                        guard !Task.isCancelled else { return }
                        await self.consume(
                            shell: shell,
                            client: activeClient,
                            refreshActiveThread: true
                        )
                    } catch is CancellationError {
                        return
                    } catch {
                        self.emitConnection(
                            .reconnecting,
                            detail: "Server unreachable. Retrying automatically."
                        )
                    }
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        configurationTask = Task { [weak self] in
            do {
                for try await event in await activeClient.serverConfigEvents() {
                    guard !Task.isCancelled,
                          let self,
                          self.isCurrentSession(
                              client: activeClient,
                              generation: generation
                          ) else {
                        break
                    }
                    switch event {
                    case let .snapshot(config):
                        self.latestServerConfig = config
                    case let .providerStatuses(providers):
                        self.latestServerConfig = ServerConfigSnapshot(providers: providers)
                    case .unrelated:
                        continue
                    }
                    if let shell = self.latestShell {
                        await self.emitSnapshot(shell)
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // The shell and thread streams remain useful on older servers
                // that do not expose the provider catalogue subscription.
            }
        }
    }

    /// Non-active environments do not hold WebSocket subscriptions. A quiet
    /// HTTP refresh keeps their home rows and reachability useful without
    /// multiplying live streams or creating a high-frequency battery cost.
    private func startAggregateRefresh(_ activeClient: T3Client) {
        aggregateRefreshTask?.cancel()
        let generation = environmentGeneration
        aggregateRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(20))
                } catch {
                    return
                }
                guard let self,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ),
                      let activeEnvironment = self.activeEnvironment,
                      let environments = try? await self.runtime.environments() else {
                    return
                }
                let passiveEnvironments = environments.filter {
                    $0.id != activeEnvironment.id
                }
                guard !passiveEnvironments.isEmpty else { continue }
                let loads = await self.loadEnvironmentShells(passiveEnvironments)
                guard !Task.isCancelled,
                      self.isCurrentSession(
                          client: activeClient,
                          generation: generation
                      ) else {
                    return
                }
                self.reconcileEnvironmentLoads(loads, savedEnvironments: environments)
                let currentConnection = self.latestSnapshot?.connection
                    ?? FeatureConnection(
                        state: .disconnected,
                        environmentName: activeEnvironment.label,
                        endpoint: activeEnvironment.httpBaseURL.absoluteString
                    )
                let snapshot = self.makeSnapshot(
                    environments: environments,
                    activeEnvironment: activeEnvironment,
                    connectionState: currentConnection.state,
                    connectionDetail: currentConnection.detail
                )
                guard self.latestSnapshot != snapshot else { continue }
                self.latestSnapshot = snapshot
                self.continuation.yield(.snapshot(snapshot))
            }
        }
    }

    private func consume(
        shell: OrchestrationShellSnapshot,
        client: T3Client,
        refreshActiveThread: Bool
    ) async {
        guard let currentClient = self.client, currentClient === client else { return }
        latestShell = shell
        await emitSnapshot(shell)
        if refreshActiveThread, let threadID = activeThreadID {
            scheduleDetailRefresh(threadID: threadID, client: client)
        }
    }

    private func consume(delta: ShellStreamItem, client: T3Client) async {
        guard let currentClient = self.client, currentClient === client else { return }
        guard let current = latestShell else {
            if let shell = try? await client.shellSnapshot() {
                await consume(shell: shell, client: client, refreshActiveThread: true)
            }
            return
        }

        let sequence: Int

        switch delta {
        case let .projectUpserted(nextSequence, _):
            sequence = nextSequence
        case let .projectRemoved(nextSequence, _):
            sequence = nextSequence
        case let .threadUpserted(nextSequence, _):
            sequence = nextSequence
        case let .threadRemoved(nextSequence, _):
            sequence = nextSequence
        case .snapshot, .synchronized:
            return
        }

        // Replayed deltas are expected after reconnect. They must be entirely
        // side-effect free, including for cached detail and selection state.
        guard sequence > current.snapshotSequence else { return }

        var projects = current.projects
        var threads = current.threads
        var changedThreadID: String?
        var shouldRefreshArchived = false

        switch delta {
        case let .projectUpserted(_, project):
            if let index = projects.firstIndex(where: { $0.id == project.id }) {
                projects[index] = project
            } else {
                projects.append(project)
            }
        case let .projectRemoved(_, projectID):
            projects.removeAll { $0.id == projectID }
        case let .threadUpserted(_, thread):
            changedThreadID = thread.id
            if let environmentID = activeEnvironment?.id {
                archivedThreadsByEnvironmentID[environmentID]?.removeAll { $0.id == thread.id }
            }
            if let index = threads.firstIndex(where: { $0.id == thread.id }) {
                threads[index] = thread
            } else {
                threads.append(thread)
            }
        case let .threadRemoved(_, threadID):
            changedThreadID = threadID
            shouldRefreshArchived = true
            threads.removeAll { $0.id == threadID }
            latestDetails[threadID] = nil
            if activeThreadID == threadID {
                resetDetailRefresh()
                activeThreadID = nil
                activeThreadEnvironmentID = nil
            }
        case .snapshot, .synchronized:
            return
        }

        let shell = OrchestrationShellSnapshot(
            snapshotSequence: sequence,
            projects: projects,
            threads: threads,
            updatedAt: current.updatedAt
        )
        latestShell = shell
        await emitSnapshot(shell)
        if shouldRefreshArchived, let environment = activeEnvironment {
            scheduleArchivedRefresh(client: client, environment: environment)
        }
        if let changedThreadID, activeThreadID == changedThreadID {
            scheduleDetailRefresh(threadID: changedThreadID, client: client)
        }
    }

    private func scheduleDetailRefresh(threadID: String, client: T3Client) {
        guard activeThreadID == threadID,
              activeThreadEnvironmentID == activeEnvironment?.id else { return }
        guard detailRefreshTask == nil else {
            detailRefreshPending = true
            return
        }
        detailRefreshPending = false
        detailRefreshGeneration &+= 1
        let generation = detailRefreshGeneration
        let sessionGeneration = environmentGeneration
        detailRefreshTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(160))
            } catch {
                self?.finishDetailRefresh(generation: generation, client: client)
                return
            }
            guard let self else { return }
            if !Task.isCancelled,
               self.activeThreadID == threadID,
               self.isCurrentSession(client: client, generation: sessionGeneration) {
                try? await self.refreshThread(id: threadID, client: client)
            }
            self.finishDetailRefresh(generation: generation, client: client)
        }
    }

    private func finishDetailRefresh(generation: Int, client: T3Client) {
        guard detailRefreshGeneration == generation else { return }
        detailRefreshTask = nil
        let needsTrailingRefresh = detailRefreshPending
        detailRefreshPending = false
        if needsTrailingRefresh, let threadID = activeThreadID {
            scheduleDetailRefresh(threadID: threadID, client: client)
        }
    }

    private func resetDetailRefresh() {
        detailRefreshGeneration &+= 1
        detailRefreshTask?.cancel()
        detailRefreshTask = nil
        detailRefreshPending = false
    }

    private func loadEnvironmentShells(
        _ environments: [Environment]
    ) async -> [EnvironmentShellLoad] {
        var clients: [(environment: Environment, client: T3Client)] = []
        clients.reserveCapacity(environments.count)
        for environment in environments {
            clients.append(
                (environment, await runtime.client(for: environment))
            )
        }

        return await withTaskGroup(of: EnvironmentShellLoad.self) { group in
            for pair in clients {
                group.addTask {
                    EnvironmentShellLoad(
                        environment: pair.environment,
                        client: pair.client,
                        shell: try? await pair.client.shellSnapshot()
                    )
                }
            }
            var loads: [EnvironmentShellLoad] = []
            loads.reserveCapacity(environments.count)
            for await load in group {
                loads.append(load)
            }
            return loads
        }
    }

    /// Successful reads replace that environment's cache. Failed reads leave
    /// its last-known rows intact, so one offline machine cannot empty home.
    private func reconcileEnvironmentLoads(
        _ loads: [EnvironmentShellLoad],
        savedEnvironments: [Environment]
    ) {
        let savedIDs = Set(savedEnvironments.map(\.id))
        environmentClients = environmentClients.filter { savedIDs.contains($0.key) }
        shellsByEnvironmentID = shellsByEnvironmentID.filter { savedIDs.contains($0.key) }
        archivedThreadsByEnvironmentID = archivedThreadsByEnvironmentID.filter {
            savedIDs.contains($0.key)
        }
        environmentConnectionStates = environmentConnectionStates.filter {
            savedIDs.contains($0.key)
        }
        environmentConnectionDetails = environmentConnectionDetails.filter {
            savedIDs.contains($0.key)
        }

        for load in loads {
            environmentClients[load.environment.id] = load.client
            if let shell = load.shell {
                shellsByEnvironmentID[load.environment.id] = shell
                environmentConnectionStates[load.environment.id] = .connected
                environmentConnectionDetails[load.environment.id] = nil
            } else {
                environmentConnectionStates[load.environment.id] = .disconnected
                environmentConnectionDetails[load.environment.id] =
                    "That server is currently unreachable."
            }
        }
        rebuildThreadEnvironmentIndex(savedEnvironments)
    }

    private func rebuildThreadEnvironmentIndex(_ environments: [Environment]) {
        var owners: [String: String] = [:]
        // Prefer the active environment only in the vanishingly unlikely case
        // that two independent servers generated the same thread UUID.
        let activeID = activeEnvironment?.id
        let ordered = environments.filter { $0.id != activeID }
            + environments.filter { $0.id == activeID }
        for environment in ordered {
            for thread in shellsByEnvironmentID[environment.id]?.threads ?? [] {
                owners[thread.id] = environment.id
            }
            for thread in archivedThreadsByEnvironmentID[environment.id] ?? [] {
                owners[thread.id] = environment.id
            }
        }
        threadEnvironmentIDs = owners
    }

    private func refresh(client: T3Client, includeArchived: Bool = false) async throws {
        let environment = client.environment
        let generation = environmentGeneration
        let shell = try await client.shellSnapshot()
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        shellsByEnvironmentID[environment.id] = shell
        if activeEnvironment?.id == environment.id {
            latestShell = shell
        }
        rebuildThreadEnvironmentIndex(
            (try? await runtime.environments()) ?? [environment]
        )
        if includeArchived, activeEnvironment?.id == environment.id {
            scheduleArchivedRefresh(client: client, environment: environment)
        }
        await emitSnapshot(shell, environment: environment)
    }

    private func scheduleArchivedRefresh(client: T3Client, environment: Environment) {
        archivedRefreshTask?.cancel()
        let generation = environmentGeneration
        archivedRefreshTask = Task { [weak self] in
            guard let self,
                  let archivedShell = try? await client.archivedShellSnapshot(),
                  !Task.isCancelled,
                  self.isCurrentSession(client: client, generation: generation) else {
                return
            }
            self.archivedThreadsByEnvironmentID[environment.id] = archivedShell.threads.map {
                self.mapThread($0, environment: environment)
            }
            self.rebuildThreadEnvironmentIndex(
                (try? await self.runtime.environments()) ?? [environment]
            )
            if let shell = self.latestShell {
                await self.emitSnapshot(shell)
            }
        }
    }

    private func refreshThread(id: String, client: T3Client) async throws {
        let environment = client.environment
        let generation = environmentGeneration
        let snapshot = try await client.threadSnapshot(id: id)
        guard isKnownClient(client, environmentID: environment.id, generation: generation) else {
            throw CancellationError()
        }
        let detail = mapDetail(snapshot.thread, environment: environment)
        if latestDetails[id] != detail {
            latestDetails[id] = detail
            continuation.yield(.detail(detail))
        }
        let hydrationBase = latestDetails[id] ?? detail
        let hydrated = await hydratedAttachmentURLs(
            in: hydrationBase,
            client: client,
            environmentID: environment.id,
            generation: generation
        )
        guard isKnownClient(client, environmentID: environment.id, generation: generation),
              latestDetails[id] == hydrationBase,
              hydrated != hydrationBase else {
            return
        }
        latestDetails[id] = hydrated
        continuation.yield(.detail(hydrated))
    }

    private func emitSnapshot(
        _ shell: OrchestrationShellSnapshot,
        environment sourceEnvironment: Environment? = nil
    ) async {
        guard let environment = activeEnvironment else { return }
        let sourceEnvironment = sourceEnvironment ?? environment
        let generation = environmentGeneration
        let environments = (try? await runtime.environments()) ?? [environment]
        guard generation == environmentGeneration,
              activeEnvironment?.id == environment.id else {
            return
        }
        shellsByEnvironmentID[sourceEnvironment.id] = shell
        environmentConnectionStates[sourceEnvironment.id] = .connected
        environmentConnectionDetails[sourceEnvironment.id] = nil
        if sourceEnvironment.id == environment.id {
            latestShell = shell
        }
        rebuildThreadEnvironmentIndex(environments)
        let connectionState: FeatureConnection.State
        let connectionDetail: String?
        if sourceEnvironment.id == environment.id {
            connectionState = .connected
            connectionDetail = nil
        } else {
            connectionState = latestSnapshot?.connection.state
                ?? environmentConnectionStates[environment.id]
                ?? .disconnected
            connectionDetail = latestSnapshot?.connection.detail
        }
        let snapshot = makeSnapshot(
            environments: environments,
            activeEnvironment: environment,
            connectionState: connectionState,
            connectionDetail: connectionDetail
        )
        guard latestSnapshot != snapshot else { return }
        latestSnapshot = snapshot
        continuation.yield(.snapshot(snapshot))
    }

    private func disconnectedSnapshot(
        environments: [Environment],
        detail: String? = nil
    ) -> FeatureSnapshot {
        FeatureSnapshot(
            connection: .init(state: .disconnected, detail: detail),
            environments: environments.map { mapEnvironment($0, activeID: nil) },
            settings: loadSettings()
        )
    }

    private func emitConnection(
        _ state: FeatureConnection.State,
        detail: String? = nil
    ) {
        guard let environment = activeEnvironment else { return }
        environmentConnectionStates[environment.id] = state
        environmentConnectionDetails[environment.id] = detail
        let connection = FeatureConnection(
            state: state,
            environmentName: environment.label,
            endpoint: environment.httpBaseURL.absoluteString,
            detail: detail
        )
        if var snapshot = latestSnapshot {
            snapshot.connection = connection
            if let index = snapshot.environments.firstIndex(where: { $0.id == environment.id }) {
                snapshot.environments[index].connectionState = state
                snapshot.environments[index].connectionDetail = detail
            }
            latestSnapshot = snapshot
        }
        continuation.yield(
            .connection(connection)
        )
    }

    private func makeSnapshot(
        environments: [Environment],
        activeEnvironment: Environment,
        connectionState: FeatureConnection.State,
        connectionDetail: String? = nil
    ) -> FeatureSnapshot {
        let threads = environments.flatMap { environment in
            let live = shellsByEnvironmentID[environment.id]?.threads.map {
                mapThread($0, environment: environment)
            } ?? []
            return live + (archivedThreadsByEnvironmentID[environment.id] ?? [])
        }
        let projects = environments.flatMap { environment in
            (shellsByEnvironmentID[environment.id]?.projects ?? []).map { project in
                let count = threads.lazy.filter {
                    $0.environmentID == environment.id && $0.projectID == project.id
                }.count
                return FeatureProject(
                    id: project.id,
                    environmentID: environment.id,
                    name: project.title,
                    path: project.workspaceRoot,
                    threadCount: count,
                    defaultSelection: project.defaultModelSelection.map(mapSelection)
                )
            }
        }
        let activeShell = shellsByEnvironmentID[activeEnvironment.id]
        return FeatureSnapshot(
            connection: FeatureConnection(
                state: connectionState,
                environmentName: activeEnvironment.label,
                endpoint: activeEnvironment.httpBaseURL.absoluteString,
                detail: connectionDetail
            ),
            environments: environments.map {
                mapEnvironment($0, activeID: activeEnvironment.id)
            },
            projects: projects,
            threads: threads,
            providers: activeShell.map(mapProviders) ?? [],
            settings: loadSettings()
        )
    }

    private func mapEnvironment(_ environment: Environment, activeID: String?) -> FeatureEnvironment {
        FeatureEnvironment(
            id: environment.id,
            name: environment.label,
            endpoint: environment.httpBaseURL.absoluteString,
            isActive: environment.id == activeID,
            connectionState: environmentConnectionStates[environment.id],
            connectionDetail: environmentConnectionDetails[environment.id]
        )
    }

    private func mapThread(
        _ thread: OrchestrationThreadShell,
        environment: Environment
    ) -> FeatureThread {
        FeatureThread(
            id: thread.id,
            projectID: thread.projectId,
            environmentID: environment.id,
            environmentName: environment.label,
            title: thread.title,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: mapThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: thread.hasPendingApprovals,
                hasUserInput: thread.hasPendingUserInput
            ),
            providerID: thread.modelSelection.instanceId,
            providerName: threadProviderName(
                session: thread.session,
                modelSelection: thread.modelSelection
            ),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.map(parseDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.latestUserMessageAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            attentionAt: failureDate(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            workingStartedAt: workingStartedAt(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            latestTurnCompletedAt: thread.latestTurn?.completedAt.map(parseDate),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
        )
    }

    private func mapThread(
        _ thread: OrchestrationThread,
        environment: Environment
    ) -> FeatureThread {
        FeatureThread(
            id: thread.id,
            projectID: thread.projectId,
            environmentID: environment.id,
            environmentName: environment.label,
            title: thread.title,
            preview: previewText(thread.messages.last?.text),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: mapThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: false,
                hasUserInput: false
            ),
            providerID: thread.modelSelection.instanceId,
            providerName: threadProviderName(
                session: thread.session,
                modelSelection: thread.modelSelection
            ),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.map(parseDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.messages.last(where: { $0.role == "user" })?.createdAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            attentionAt: failureDate(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            workingStartedAt: workingStartedAt(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            latestTurnCompletedAt: thread.latestTurn?.completedAt.map(parseDate),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
        )
    }

    private func mapDetail(
        _ thread: OrchestrationThread,
        environment: Environment
    ) -> FeatureThreadDetail {
        let approvals = pendingApprovals(thread)
        let userInputs = pendingUserInputs(thread)
        let messages = thread.messages.map { message in
            FeatureMessage(
                id: message.id,
                role: mapRole(message.role),
                text: message.text,
                createdAt: parseDate(message.createdAt),
                state: message.streaming ? .streaming : .complete,
                attachments: (message.attachments ?? []).map {
                    FeatureMessageAttachment(
                        id: $0.id,
                        name: $0.name,
                        mimeType: $0.mimeType,
                        sizeBytes: $0.sizeBytes,
                        url: cachedAttachmentURL(
                            for: $0.id,
                            environmentID: environment.id
                        )
                    )
                }
            )
        }
        let errors = thread.activities.compactMap { activity -> FeatureMessage? in
            guard activity.tone == "error" else { return nil }
            let detail = activity.payload["detail"]?.stringValue
            let text = detail.map { "\(activity.summary)\n\($0)" } ?? activity.summary
            return FeatureMessage(
                id: "activity-\(activity.id)",
                role: activity.tone == "error" ? .system : .tool,
                text: text,
                createdAt: parseDate(activity.createdAt),
                state: .complete,
                toolName: activity.kind
            )
        }
        let mergedMessages = (messages + errors + collapsedWorkLogs(thread.activities))
            .sorted { $0.createdAt < $1.createdAt }
        let mappedThread = FeatureThread(
            id: thread.id,
            projectID: thread.projectId,
            environmentID: environment.id,
            environmentName: environment.label,
            title: thread.title,
            preview: previewText(thread.messages.last?.text),
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            createdAt: parseDate(thread.createdAt),
            updatedAt: parseDate(thread.updatedAt),
            state: mapThreadState(
                latestTurn: thread.latestTurn,
                session: thread.session,
                hasApprovals: !approvals.isEmpty,
                hasUserInput: !userInputs.isEmpty
            ),
            providerID: thread.modelSelection.instanceId,
            providerName: threadProviderName(
                session: thread.session,
                modelSelection: thread.modelSelection
            ),
            modelID: thread.modelSelection.model,
            modelOptions: mapOptionSelections(thread.modelSelection.options),
            isArchived: thread.archivedAt != nil,
            isSettled: isSettled(thread.settledOverride, settledAt: thread.settledAt),
            keepsActive: thread.settledOverride == "active",
            settledAt: thread.settledAt.map(parseDate),
            lastActivityAt: lastActivityDate(
                latestUserMessageAt: thread.messages.last(where: { $0.role == "user" })?.createdAt,
                latestTurn: thread.latestTurn
            ),
            snoozedUntil: thread.snoozedUntil.map(parseDate),
            snoozedAt: thread.snoozedAt.map(parseDate),
            attentionAt: failureDate(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            workingStartedAt: workingStartedAt(
                latestTurn: thread.latestTurn,
                session: thread.session
            ),
            latestTurnCompletedAt: thread.latestTurn?.completedAt.map(parseDate),
            runtimeMode: mapRuntimeMode(thread.runtimeMode),
            interactionMode: mapInteractionMode(thread.interactionMode)
        )
        return FeatureThreadDetail(
            thread: mappedThread,
            messages: mergedMessages,
            approvals: approvals,
            userInputs: userInputs
        )
    }

    /// Lifecycle updates can number in the thousands on a long turn. Keep the
    /// primary transcript message-sized while preserving a bounded, expandable
    /// summary for each turn.
    private func collapsedWorkLogs(
        _ activities: [OrchestrationActivity]
    ) -> [FeatureMessage] {
        let terminalKinds = Set(["tool.completed", "task.completed", "turn.plan.updated"])
        let completed = activities.filter {
            $0.tone != "error" && terminalKinds.contains($0.kind)
        }
        let groups = Dictionary(grouping: completed) { activity in
            activity.turnId ?? "unscoped"
        }

        return groups.values.compactMap { unsorted in
            let group = unsorted.sorted { $0.createdAt < $1.createdAt }
            guard let last = group.last else { return nil }
            let visible = group.suffix(40)
            var lines: [String] = []
            let hiddenCount = group.count - visible.count
            if hiddenCount > 0 {
                lines.append("\(hiddenCount) earlier updates hidden")
            }
            lines.append(
                contentsOf: visible.map { activity in
                    let detail = previewText(activity.payload["detail"]?.stringValue)
                    return "• \(detail ?? activity.summary)"
                }
            )
            return FeatureMessage(
                id: "work-log-\(last.turnId ?? last.id)",
                role: .tool,
                text: lines.joined(separator: "\n"),
                createdAt: parseDate(last.createdAt),
                state: .complete,
                toolName: "Work log · \(group.count)"
            )
        }
    }

    private func pendingApprovals(_ thread: OrchestrationThread) -> [FeatureApproval] {
        var open: [String: FeatureApproval] = [:]
        for activity in thread.activities.sorted(by: {
            parseDate($0.createdAt) < parseDate($1.createdAt)
        }) {
            let requestID = activity.payload["requestId"]?.stringValue
            if activity.kind == "approval.requested", let requestID {
                let requestKind = activity.payload["requestKind"]?.stringValue
                let kind: FeatureApprovalKind = switch requestKind {
                case "command": .command
                case "file-read": .fileRead
                case "file-change": .fileChange
                default: .other
                }
                let detail = activity.payload["detail"]?.stringValue ?? activity.summary
                open[requestID] = FeatureApproval(
                    id: requestID,
                    threadID: thread.id,
                    kind: kind,
                    title: activity.summary,
                    detail: detail
                )
                approvalThreadIDs[requestID] = thread.id
            } else if activity.kind == "approval.resolved", let requestID {
                open[requestID] = nil
                approvalThreadIDs[requestID] = nil
            } else if activity.kind == "provider.approval.respond.failed", let requestID {
                let detail = activity.payload["detail"]?.stringValue?.lowercased() ?? ""
                if detail.contains("stale") || detail.contains("unknown") {
                    open[requestID] = nil
                    approvalThreadIDs[requestID] = nil
                }
            }
        }
        return open.values.sorted { $0.id < $1.id }
    }

    private func pendingUserInputs(_ thread: OrchestrationThread) -> [FeatureUserInput] {
        var open: [String: FeatureUserInput] = [:]
        for activity in thread.activities.sorted(by: {
            parseDate($0.createdAt) < parseDate($1.createdAt)
        }) {
            let requestID = activity.payload["requestId"]?.stringValue
            if activity.kind == "user-input.requested",
               let requestID,
               let questions = parseInputQuestions(activity.payload),
               !questions.isEmpty {
                open[requestID] = FeatureUserInput(
                    id: requestID,
                    threadID: thread.id,
                    questions: questions
                )
                inputThreadIDs[requestID] = thread.id
            } else if activity.kind == "user-input.resolved", let requestID {
                open[requestID] = nil
                inputThreadIDs[requestID] = nil
            } else if activity.kind == "provider.user-input.respond.failed", let requestID {
                let detail = activity.payload["detail"]?.stringValue?.lowercased() ?? ""
                if detail.contains("stale") || detail.contains("unknown") {
                    open[requestID] = nil
                    inputThreadIDs[requestID] = nil
                }
            }
        }
        return open.values.sorted { $0.id < $1.id }
    }

    private func parseInputQuestions(_ payload: JSONValue) -> [FeatureInputQuestion]? {
        guard case let .array(rawQuestions)? = payload["questions"] else { return nil }
        return rawQuestions.compactMap { rawQuestion in
            guard case let .object(question) = rawQuestion,
                  let id = question["id"]?.stringValue,
                  let header = question["header"]?.stringValue,
                  let text = question["question"]?.stringValue else {
                return nil
            }
            let options: [FeatureInputOption]
            if case let .array(rawOptions)? = question["options"] {
                options = rawOptions.compactMap { rawOption in
                    guard case let .object(option) = rawOption,
                          let label = option["label"]?.stringValue else {
                        return nil
                    }
                    return FeatureInputOption(
                        label: label,
                        detail: option["description"]?.stringValue ?? ""
                    )
                }
            } else {
                options = []
            }
            let allowsMultiple: Bool
            if case let .bool(value)? = question["multiSelect"] {
                allowsMultiple = value
            } else {
                allowsMultiple = false
            }
            return FeatureInputQuestion(
                id: id,
                header: header,
                question: text,
                options: options,
                allowsMultiple: allowsMultiple
            )
        }
    }

    private func mapThreadState(
        latestTurn: OrchestrationLatestTurn?,
        session: OrchestrationSession?,
        hasApprovals: Bool,
        hasUserInput: Bool
    ) -> FeatureThreadState {
        if hasApprovals { return .waitingForApproval }
        if hasUserInput { return .waitingForInput }
        if session?.status == "starting" { return .queued }
        if session?.status == "running" || latestTurn?.state == "running" { return .working }
        if session?.status == "error" || latestTurn?.state == "error" { return .failed }
        if latestTurn?.state == "completed" { return .completed }
        return .idle
    }

    private func mapRole(_ role: String) -> FeatureMessageRole {
        switch role {
        case "user": .user
        case "assistant": .assistant
        case "system": .system
        default: .tool
        }
    }

    private func isSettled(_ override: String?, settledAt: String?) -> Bool {
        if override == "active" { return false }
        return override == "settled" || settledAt != nil
    }

    private func mapRuntimeMode(_ mode: RuntimeMode) -> FeatureRuntimeMode {
        switch mode {
        case .approvalRequired: .approvalRequired
        case .autoAcceptEdits: .autoAcceptEdits
        case .auto: .automatic
        case .fullAccess: .fullAccess
        }
    }

    private func coreRuntimeMode(_ mode: FeatureRuntimeMode) -> RuntimeMode {
        switch mode {
        case .approvalRequired: .approvalRequired
        case .autoAcceptEdits: .autoAcceptEdits
        case .automatic: .auto
        case .fullAccess: .fullAccess
        }
    }

    private func mapInteractionMode(_ mode: InteractionMode) -> FeatureInteractionMode {
        mode == .plan ? .plan : .standard
    }

    private func coreInteractionMode(_ mode: FeatureInteractionMode) -> InteractionMode {
        mode == .plan ? .plan : .default
    }

    private func mapProviders(_ shell: OrchestrationShellSnapshot) -> [FeatureProvider] {
        if let providers = latestServerConfig?.providers, !providers.isEmpty {
            return providers.map { provider in
                FeatureProvider(
                    id: provider.instanceId,
                    name: provider.displayName ?? providerDisplayName(provider.driver),
                    isAvailable: provider.enabled
                        && provider.installed
                        && provider.status != "disabled"
                        && provider.status != "error"
                        && provider.auth.status != "unauthenticated"
                        && provider.availability != "unavailable",
                    driver: provider.driver,
                    requiresNewThreadForModelChange:
                        provider.requiresNewThreadForModelChange ?? false,
                    models: provider.models.map { model in
                        let options = (model.capabilities?.optionDescriptors ?? [])
                            .map(mapOptionDescriptor)
                        return FeatureModel(
                            id: model.slug,
                            name: model.name,
                            detail: model.subProvider ?? model.shortName,
                            supportsReasoning: options.contains { descriptor in
                                let searchable = "\(descriptor.id) \(descriptor.label)".lowercased()
                                return searchable.contains("reason")
                                    || searchable.contains("effort")
                                    || searchable.contains("thinking")
                            },
                            isDefault: model.isDefault ?? false,
                            options: options
                        )
                    }
                )
            }
        }

        var modelsByProvider: [String: Set<String>] = [:]
        for selection in shell.projects.compactMap(\.defaultModelSelection)
            + shell.threads.map(\.modelSelection) {
            modelsByProvider[selection.instanceId, default: []].insert(selection.model)
        }
        if modelsByProvider.isEmpty {
            modelsByProvider["codex"] = ["gpt-5.6-sol"]
        }
        return modelsByProvider.keys.sorted().map { providerID in
            FeatureProvider(
                id: providerID,
                name: providerDisplayName(providerID),
                driver: providerID,
                models: (modelsByProvider[providerID] ?? []).sorted().map {
                    FeatureModel(id: $0, name: $0)
                }
            )
        }
    }

    private func modelSelection(
        _ selection: FeatureSelection?,
        projectID: String
    ) -> ModelSelection {
        if let selection {
            return coreModelSelection(selection)
        }
        if let projectDefault = latestShell?.projects
            .first(where: { $0.id == projectID })?
            .defaultModelSelection {
            return projectDefault
        }
        return defaultModelSelection()
    }

    private func defaultModelSelection() -> ModelSelection {
        if let selection = loadSettings().defaultSelection {
            return coreModelSelection(selection)
        }
        return ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
    }

    private func coreModelSelection(_ selection: FeatureSelection) -> ModelSelection {
        let options = selection.options.map { option in
            ModelSelection.OptionSelection(
                id: option.id,
                value: coreOptionValue(option.value)
            )
        }
        return ModelSelection(
            instanceId: selection.providerID,
            model: selection.modelID,
            options: options.isEmpty ? nil : options
        )
    }

    private func mapSelection(_ selection: ModelSelection) -> FeatureSelection {
        FeatureSelection(
            providerID: selection.instanceId,
            modelID: selection.model,
            options: mapOptionSelections(selection.options)
        )
    }

    private func coreOptionValue(_ value: FeatureModelOptionValue) -> JSONValue {
        switch value {
        case let .string(rawValue):
            return .string(rawValue)
        case let .boolean(rawValue):
            return .bool(rawValue)
        }
    }

    private func mapOptionSelections(
        _ selections: [ModelSelection.OptionSelection]?
    ) -> [FeatureModelOptionSelection] {
        (selections ?? []).compactMap { selection in
            let value: FeatureModelOptionValue
            switch selection.value {
            case let .string(rawValue):
                value = .string(rawValue)
            case let .bool(rawValue):
                value = .boolean(rawValue)
            default:
                return nil
            }
            return FeatureModelOptionSelection(id: selection.id, value: value)
        }
    }

    private func mapOptionDescriptor(
        _ descriptor: ServerProviderOptionDescriptor
    ) -> FeatureModelOptionDescriptor {
        switch descriptor {
        case let .select(value):
            let defaultValue = value.currentValue
                ?? value.options.first(where: { $0.isDefault == true })?.id
            return FeatureModelOptionDescriptor(
                id: value.id,
                label: value.label,
                detail: value.description,
                kind: .select,
                choices: value.options.map {
                    FeatureModelOptionChoice(
                        id: $0.id,
                        label: $0.label,
                        detail: $0.description,
                        isDefault: $0.isDefault ?? false
                    )
                },
                defaultValue: defaultValue.map(FeatureModelOptionValue.string)
            )
        case let .boolean(value):
            return FeatureModelOptionDescriptor(
                id: value.id,
                label: value.label,
                detail: value.description,
                kind: .boolean,
                defaultValue: value.currentValue.map(FeatureModelOptionValue.boolean)
            )
        }
    }

    private func providerDisplayName(_ id: String) -> String {
        switch id {
        case "codex": "Codex"
        case "claudeAgent", "claude": "Claude"
        case "cursor": "Cursor"
        case "grok": "Grok"
        case "opencode": "OpenCode"
        default: id
        }
    }

    private func threadProviderName(
        session: OrchestrationSession?,
        modelSelection: ModelSelection
    ) -> String {
        if let name = session?.providerName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            return name
        }
        let providerID = session?.providerInstanceId ?? modelSelection.instanceId
        if let provider = latestServerConfig?.providers.first(where: {
            $0.instanceId == providerID
        }) {
            return provider.displayName ?? providerDisplayName(provider.driver)
        }
        return providerDisplayName(providerID)
    }

    private func cachedAttachmentURL(
        for id: String,
        environmentID: String? = nil
    ) -> URL? {
        guard let environmentID = environmentID ?? activeEnvironment?.id else {
            return nil
        }
        let key = AttachmentCacheKey(environmentID: environmentID, attachmentID: id)
        guard let cached = attachmentURLs[key] else { return nil }
        guard cached.expiresAt > Date().addingTimeInterval(30) else {
            attachmentURLs[key] = nil
            return nil
        }
        return cached.url
    }

    private func scheduleAttachmentHydration(
        in detail: FeatureThreadDetail,
        threadID: String,
        client: T3Client,
        environmentID: String
    ) {
        attachmentHydrationTasks[threadID]?.task.cancel()
        let generation = environmentGeneration
        let workID = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            let hydrated = await self.hydratedAttachmentURLs(
                in: detail,
                client: client,
                environmentID: environmentID,
                generation: generation
            )
            guard self.isKnownClient(
                client,
                environmentID: environmentID,
                generation: generation
            ),
                  self.latestDetails[threadID] == detail,
                  hydrated != detail else {
                self.finishAttachmentHydration(threadID: threadID, workID: workID)
                return
            }
            self.latestDetails[threadID] = hydrated
            self.continuation.yield(.detail(hydrated))
            self.finishAttachmentHydration(threadID: threadID, workID: workID)
        }
        attachmentHydrationTasks[threadID] = (workID, task)
    }

    private func finishAttachmentHydration(threadID: String, workID: UUID) {
        guard attachmentHydrationTasks[threadID]?.id == workID else { return }
        attachmentHydrationTasks[threadID] = nil
    }

    private func hydratedAttachmentURLs(
        in detail: FeatureThreadDetail,
        client: T3Client,
        environmentID: String,
        generation: Int
    ) async -> FeatureThreadDetail {
        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            return detail
        }
        let imageIDs = Set(
            detail.messages.flatMap(\.attachments)
                .filter { $0.mimeType.hasPrefix("image/") }
                .map(\.id)
        )
        let missingIDs = Array(imageIDs.filter {
            cachedAttachmentURL(for: $0, environmentID: environmentID) == nil
        })

        await withTaskGroup(of: (String, ResolvedAssetURL?).self) { group in
            var iterator = missingIDs.makeIterator()
            for _ in 0..<min(4, missingIDs.count) {
                guard let id = iterator.next() else { break }
                group.addTask {
                    (
                        id,
                        try? await client.resolvedAsset(resource: .attachment(id: id))
                    )
                }
            }
            while let (id, resolved) = await group.next() {
                if let resolved,
                   isKnownClient(
                       client,
                       environmentID: environmentID,
                       generation: generation
                   ) {
                    let key = AttachmentCacheKey(
                        environmentID: environmentID,
                        attachmentID: id
                    )
                    attachmentURLs[key] = CachedAttachmentURL(
                        url: resolved.url,
                        expiresAt: resolved.expiresAt
                    )
                }
                if isKnownClient(
                    client,
                    environmentID: environmentID,
                    generation: generation
                ),
                   let nextID = iterator.next() {
                    group.addTask {
                        (
                            nextID,
                            try? await client.resolvedAsset(
                                resource: .attachment(id: nextID)
                            )
                        )
                    }
                }
            }
        }

        guard isKnownClient(client, environmentID: environmentID, generation: generation) else {
            return detail
        }
        var hydrated = detail
        for messageIndex in hydrated.messages.indices {
            for attachmentIndex in hydrated.messages[messageIndex].attachments.indices {
                let id = hydrated.messages[messageIndex].attachments[attachmentIndex].id
                hydrated.messages[messageIndex].attachments[attachmentIndex].url =
                    cachedAttachmentURL(for: id, environmentID: environmentID)
            }
        }
        return hydrated
    }

    private func lastActivityDate(
        latestUserMessageAt: String?,
        latestTurn: OrchestrationLatestTurn?
    ) -> Date? {
        [
            latestUserMessageAt,
            latestTurn?.requestedAt,
            latestTurn?.startedAt,
            latestTurn?.completedAt,
        ]
        .compactMap { $0.flatMap(parseValidDate) }
        .max()
    }

    private func failureDate(
        latestTurn: OrchestrationLatestTurn?,
        session: OrchestrationSession?
    ) -> Date? {
        guard session?.status == "error" || latestTurn?.state == "error" else {
            return nil
        }
        return [
            session?.updatedAt,
            latestTurn?.completedAt,
            latestTurn?.startedAt,
            latestTurn?.requestedAt,
        ]
        .compactMap { $0.flatMap(parseValidDate) }
        .max()
    }

    private func workingStartedAt(
        latestTurn: OrchestrationLatestTurn?,
        session: OrchestrationSession?
    ) -> Date? {
        guard session?.status == "starting"
                || session?.status == "running"
                || latestTurn?.state == "running" else {
            return nil
        }
        let candidates: [String?]
        if let latestTurn, latestTurn.completedAt == nil {
            candidates = [
                latestTurn.startedAt,
                latestTurn.requestedAt,
                session?.updatedAt,
            ]
        } else {
            candidates = [session?.updatedAt]
        }
        return candidates.lazy.compactMap { $0.flatMap(self.parseValidDate) }.first
    }

    private func makeUploadAttachments(
        _ attachments: [FeatureUploadAttachment]
    ) throws -> [UploadChatImageAttachment] {
        guard attachments.count <= 8 else {
            throw NativeFeatureClientError.tooManyAttachments
        }
        return try attachments.map {
            try UploadChatImageAttachment(
                data: $0.data,
                name: $0.name,
                mimeType: $0.mimeType
            )
        }
    }

    private func requireScope(_ scope: String, client: T3Client) async throws {
        let session = try await client.authSession()
        guard session.scopes?.contains(scope) == true else {
            throw NativeFeatureClientError.missingScope(scope)
        }
    }

    private static func title(from prompt: String, hasAttachments: Bool) -> String {
        let compact = prompt
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        guard !compact.isEmpty else {
            return hasAttachments ? "Image task" : "New thread"
        }
        guard compact.count > 72 else { return compact }
        return "\(compact.prefix(69).trimmingCharacters(in: .whitespacesAndNewlines))..."
    }

    private func previewText(_ text: String?) -> String? {
        guard let text else { return nil }
        let compact = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !compact.isEmpty else { return nil }
        return compact.count > 160 ? "\(compact.prefix(157))..." : compact
    }

    private func loadSettings() -> FeatureSettings {
        guard let data = settingsStore.data(forKey: Self.settingsKey),
              let settings = try? JSONDecoder().decode(FeatureSettings.self, from: data) else {
            return FeatureSettings()
        }
        return settings
    }

    private func parseDate(_ value: String) -> Date {
        parseValidDate(value) ?? .distantPast
    }

    private func parseValidDate(_ value: String) -> Date? {
        Self.fractionalDateFormatter.date(from: value)
            ?? Self.dateFormatter.date(from: value)
    }

    private static let settingsKey = "swift-ios.feature-settings.v1"
    private static let fractionalDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let dateFormatter = ISO8601DateFormatter()
}

private struct AttachmentCacheKey: Hashable {
    let environmentID: String
    let attachmentID: String
}

private struct CachedAttachmentURL {
    let url: URL
    let expiresAt: Date
}

private struct EnvironmentShellLoad: Sendable {
    let environment: Environment
    let client: T3Client
    let shell: OrchestrationShellSnapshot?
}

private struct CommandIdentity: Equatable {
    let commandID: String
    let messageID: String
    let createdAt: String

    init(
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString,
        createdAt: String = OrchestrationCommands.now()
    ) {
        self.commandID = commandID
        self.messageID = messageID
        self.createdAt = createdAt
    }
}

private struct BootstrapSubmissionSignature: Equatable {
    let projectID: String
    let prompt: String
    let model: ModelSelection
    let runtimeMode: RuntimeMode
    let interactionMode: InteractionMode
    let attachments: [FeatureUploadAttachment]
}

private struct PendingBootstrapSubmission {
    let signature: BootstrapSubmissionSignature
    let threadID: String
    let identity: CommandIdentity
}

private struct TurnSubmissionSignature: Equatable {
    let text: String
    let model: ModelSelection?
    let runtimeMode: RuntimeMode
    let interactionMode: InteractionMode
    let attachments: [FeatureUploadAttachment]
}

private struct PendingTurnSubmission {
    let signature: TurnSubmissionSignature
    let identity: CommandIdentity
}

private enum NativeFeatureClientError: LocalizedError {
    case notConnected
    case threadNotFound
    case workspaceNotFound
    case approvalNotFound
    case inputRequestNotFound
    case invalidProjectPath
    case terminalNotOpen
    case deviceSessionNotFound
    case missingScope(String)
    case tooManyAttachments

    var errorDescription: String? {
        switch self {
        case .notConnected: "Connect to a T3 environment first."
        case .threadNotFound: "The selected thread is no longer available."
        case .workspaceNotFound: "The thread workspace is no longer available."
        case .approvalNotFound: "The approval request is no longer active."
        case .inputRequestNotFound: "The input request is no longer active."
        case .invalidProjectPath: "Enter a workspace path on the connected environment."
        case .terminalNotOpen: "Open the terminal before sending input."
        case .deviceSessionNotFound: "That device session is no longer active."
        case .missingScope: "This connection does not have permission to manage devices."
        case .tooManyAttachments: "You can attach up to 8 images per message."
        }
    }
}
