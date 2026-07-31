import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Feature root model")
struct FeatureRootModelTests {
    @Test
    func testPairReloadsConnectedSnapshot() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(connection: .init(state: .disconnected))
        client.snapshotAfterPair = FeatureSnapshot(
            connection: .init(
                state: .connected,
                environmentName: "Studio",
                endpoint: "https://studio.example"
            )
        )
        let oldThread = FeatureThread(id: "same-id", projectID: "old-project", title: "Old")
        client.threadDetail = FeatureThreadDetail(
            thread: oldThread,
            messages: [FeatureMessage(id: "old-message", role: .assistant, text: "Old")]
        )
        let model = FeatureRootModel(client: client)
        _ = await model.detail(for: oldThread.id)

        let result = await model.pair(endpoint: "https://studio.example", token: "pair-token")

        #expect(result)
        #expect(client.pairEndpoint == "https://studio.example")
        #expect(client.pairToken == "pair-token")
        #expect(model.snapshot.connection.state == .connected)
        #expect(model.details.isEmpty)
    }

    @Test
    func testCreateThreadOptimisticallyUpsertsIt() async {
        let client = FeatureClientStub()
        let created = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Build native app",
            providerID: "codex",
            modelID: "gpt-5"
        )
        client.createdThread = created
        let model = FeatureRootModel(client: client)

        let result = await model.createThread(
            projectID: "project-1",
            title: created.title,
            selection: .init(providerID: "codex", modelID: "gpt-5")
        )

        #expect(result == created)
        #expect(model.snapshot.threads == [created])
    }

    @Test
    func testSendAddsQueuedMessageBeforeServerEvent() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        client.threadDetail = FeatureThreadDetail(thread: thread)
        let model = FeatureRootModel(client: client)
        _ = await model.detail(for: thread.id)

        let sent = await model.sendMessage(
            threadID: thread.id,
            text: "  ship it  ",
            selection: nil
        )

        #expect(sent)
        #expect(client.sentText == "ship it")
        #expect(model.details[thread.id]?.messages.last?.text == "ship it")
        #expect(model.details[thread.id]?.messages.last?.state == .queued)
    }

    @Test
    func testNewTaskStartsThreadAndFirstTurnAtomically() async {
        let client = FeatureClientStub()
        let created = FeatureThread(
            id: "thread-atomic",
            projectID: "project-1",
            title: "Ship the native app",
            providerID: "codex",
            modelID: "gpt-5.6-sol"
        )
        client.createdThread = created
        let model = FeatureRootModel(client: client)
        let attachment = FeatureDraftAttachment(
            data: Data([0xFF, 0xD8, 0xFF]),
            filename: "reference.jpg",
            mimeType: "image/jpeg"
        )

        let result = await model.startTask(
            NewTaskRequest(
                projectID: "project-1",
                prompt: "  Ship the native app  ",
                selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
                runtimeMode: .fullAccess,
                interactionMode: .standard,
                attachments: [attachment]
            )
        )

        #expect(result == created)
        #expect(client.startedPrompt == "Ship the native app")
        #expect(client.startedAttachments.map(\.name) == ["reference.jpg"])
        #expect(client.createThreadCallCount == 0)
        #expect(client.sendMessageCallCount == 0)
        #expect(model.snapshot.threads == [created])
    }

    @Test
    func testArchiveAndDeleteKeepLocalListsConsistent() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        client.createdThread = thread
        let model = FeatureRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setArchived(thread.id, archived: true)
        #expect(model.snapshot.threads[0].isArchived)

        await model.deleteThread(thread.id)
        #expect(model.snapshot.threads.isEmpty)
    }

    @Test
    func testCancelledDetailRefreshKeepsCachedContentWithoutAlert() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let detail = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(id: "message-1", role: .assistant, text: "Still here"),
            ]
        )
        client.threadDetail = detail
        let model = FeatureRootModel(client: client)
        _ = await model.detail(for: thread.id)
        client.loadThreadError = CancellationError()

        let refreshed = await model.detail(for: thread.id, force: true)

        #expect(refreshed == detail)
        #expect(model.errorMessage == nil)
    }

    @Test
    func testResnoozeRefreshesTheOptimisticSnoozeTimestamp() async {
        let client = FeatureClientStub()
        var thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Thread",
            state: .failed
        )
        let oldSnooze = Date.now.addingTimeInterval(-600)
        thread.snoozedAt = oldSnooze
        thread.attentionAt = Date.now.addingTimeInterval(-300)
        client.createdThread = thread
        let model = FeatureRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setSnoozed(
            thread.id,
            until: Date.now.addingTimeInterval(3_600)
        )

        let updated = model.snapshot.threads[0]
        #expect(updated.snoozedAt != oldSnooze)
        #expect(updated.snoozedAt! > updated.attentionAt!)
    }

    @Test
    func testResolveUserInputForwardsTypedAnswersAndClearsTheRequest() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let request = FeatureUserInput(
            id: "request-1",
            threadID: thread.id,
            questions: []
        )
        client.threadDetail = FeatureThreadDetail(thread: thread, userInputs: [request])
        let model = FeatureRootModel(client: client)
        _ = await model.detail(for: thread.id)

        let answers: [String: FeatureInputAnswer] = [
            "scope": .selections(["Server", "Web"]),
            "note": .text("Ship it"),
        ]
        await model.resolveUserInput(request.id, answers: answers)

        #expect(client.resolvedInputID == request.id)
        #expect(client.resolvedInputAnswers == answers)
        #expect(model.details[thread.id]?.userInputs.isEmpty == true)
    }
}

@MainActor
private final class FeatureClientStub: FeatureClient {
    var snapshot = FeatureSnapshot()
    var snapshotAfterPair: FeatureSnapshot?
    var createdThread = FeatureThread(id: "created", projectID: "project", title: "Created")
    var threadDetail: FeatureThreadDetail?
    var pairEndpoint: String?
    var pairToken: String?
    var sentText: String?
    var startedPrompt: String?
    var startedAttachments: [FeatureUploadAttachment] = []
    var createThreadCallCount = 0
    var sendMessageCallCount = 0
    var loadThreadError: (any Error)?
    var resolvedInputID: String?
    var resolvedInputAnswers: [String: FeatureInputAnswer]?

    func initialSnapshot() async throws -> FeatureSnapshot {
        if pairEndpoint != nil, let snapshotAfterPair {
            return snapshotAfterPair
        }
        return snapshot
    }

    func pair(endpoint: String, token: String?) async throws {
        pairEndpoint = endpoint
        pairToken = token
    }

    func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async throws -> FeatureThread {
        createThreadCallCount += 1
        return createdThread
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        startedPrompt = prompt
        startedAttachments = attachments
        return createdThread
    }

    func renameThread(id: String, title: String) async throws {}
    func setThreadArchived(id: String, archived: Bool) async throws {}
    func deleteThread(id: String) async throws {}

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        if let loadThreadError {
            throw loadThreadError
        }
        if let threadDetail {
            return threadDetail
        }
        return FeatureThreadDetail(thread: createdThread)
    }

    func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async throws {
        sendMessageCallCount += 1
        sentText = text
    }

    func cancelTurn(threadID: String) async throws {}
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {}
    func resolveUserInput(
        id: String,
        answers: [String: FeatureInputAnswer]
    ) async throws {
        resolvedInputID = id
        resolvedInputAnswers = answers
    }
    func saveSettings(_ settings: FeatureSettings) async throws {}
}
