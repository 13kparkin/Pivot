import Foundation
import XCTest
@testable import T3Code

@MainActor
final class NativeMultiEnvironmentTests: XCTestCase {
    func testSnapshotMergesEnvironmentsAndRoutesThreadWorkToItsOwner() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()

        XCTAssertEqual(Set(snapshot.projects.map(\.environmentID)), ["one", "two"])
        XCTAssertEqual(Set(snapshot.threads.compactMap(\.wireID)), ["thread-one", "thread-two"])
        let remoteThread = try XCTUnwrap(
            snapshot.threads.first(where: { $0.environmentID == "two" })
        )
        XCTAssertEqual(
            remoteThread.environmentName,
            "Steam Box"
        )
        XCTAssertEqual(
            snapshot.environments.first(where: { $0.id == "two" })?.connectionState,
            .connected
        )

        let detail = try await fixture.client.loadThread(id: remoteThread.id)
        XCTAssertEqual(detail.thread.environmentID, "two")
        XCTAssertEqual(detail.thread.environmentName, "Steam Box")

        try await fixture.client.renameThread(id: remoteThread.id, title: "Remote rename")
        try await fixture.client.sendMessage(
            threadID: remoteThread.id,
            text: "Run this on Steam Box",
            selection: nil
        )

        let routedHosts = await fixture.transport.dispatchHosts()
        XCTAssertEqual(routedHosts, ["two.example", "two.example"])
        await fixture.client.disconnect()
    }

    func testFailedEnvironmentKeepsItsLastKnownRowsWithoutHidingHealthyDevices() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.client.initialSnapshot()
        await fixture.transport.setReachable(false, host: "two.example")

        let passiveFailure = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            Set(passiveFailure.threads.compactMap(\.wireID)),
            ["thread-one", "thread-two"]
        )
        XCTAssertEqual(passiveFailure.connection.state, .connected)
        XCTAssertEqual(
            passiveFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .disconnected
        )

        await fixture.transport.setReachable(false, host: "one.example")
        await fixture.transport.setReachable(true, host: "two.example")

        let activeFailure = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            Set(activeFailure.threads.compactMap(\.wireID)),
            ["thread-one", "thread-two"]
        )
        XCTAssertEqual(activeFailure.connection.state, .disconnected)
        XCTAssertEqual(activeFailure.connection.environmentName, "Left Book")
        XCTAssertEqual(
            activeFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .connected
        )
        await fixture.client.disconnect()
    }

    func testDuplicateWireIDsRemainDistinctAndRouteByEnvironment() async throws {
        let fixture = try await makeFixture(duplicateIDs: true)
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()
        XCTAssertEqual(snapshot.projects.count, 2)
        XCTAssertEqual(snapshot.threads.count, 2)
        XCTAssertEqual(Set(snapshot.projects.map(\.id)).count, 2)
        XCTAssertEqual(Set(snapshot.threads.map(\.id)).count, 2)
        XCTAssertEqual(Set(snapshot.projects.compactMap(\.wireID)), ["project-shared"])
        XCTAssertEqual(Set(snapshot.threads.compactMap(\.wireID)), ["thread-shared"])

        let remote = try XCTUnwrap(
            snapshot.threads.first(where: { $0.environmentID == "two" })
        )
        _ = try await fixture.client.loadThread(id: remote.id)
        try await fixture.client.renameThread(id: remote.id, title: "Remote only")

        let hosts = await fixture.transport.dispatchHosts()
        XCTAssertEqual(hosts, ["two.example"])
        await fixture.client.disconnect()
    }

    func testPassiveCreateUsesOwningProjectDefaultAndFallbackRemainsRoutable() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()
        let remoteProject = try XCTUnwrap(
            snapshot.projects.first(where: { $0.environmentID == "two" })
        )
        let created = try await fixture.client.createThread(
            projectID: remoteProject.id,
            title: "Passive task",
            selection: nil
        )

        XCTAssertEqual(created.environmentID, "two")
        XCTAssertEqual(created.projectID, remoteProject.id)
        XCTAssertNotNil(created.wireID)
        try await fixture.client.renameThread(id: created.id, title: "Fallback routed")

        let records = await fixture.transport.dispatchRecords()
        XCTAssertEqual(records.map(\.host), ["two.example", "two.example"])
        XCTAssertEqual(records[0].command["type"]?.stringValue, "thread.create")
        XCTAssertEqual(records[0].command["projectId"]?.stringValue, "project-two")
        XCTAssertEqual(
            records[0].command["modelSelection"]?["instanceId"]?.stringValue,
            "claudeAgent"
        )
        XCTAssertEqual(
            records[1].command["threadId"]?.stringValue,
            created.wireID
        )
        await fixture.client.disconnect()
    }

    private func makeFixture(duplicateIDs: Bool = false) async throws -> MultiEnvironmentFixture {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-multi-\(UUID().uuidString)", isDirectory: true)
        let environments = [
            Environment(
                id: "one",
                label: "Left Book",
                httpBaseURL: URL(string: "https://one.example")!,
                webSocketBaseURL: URL(string: "wss://one.example")!
            ),
            Environment(
                id: "two",
                label: "Steam Box",
                httpBaseURL: URL(string: "https://two.example")!,
                webSocketBaseURL: URL(string: "wss://two.example")!
            ),
        ]
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save(environments)
        try await store.setActiveEnvironment(id: "one")
        let transport = MultiEnvironmentHTTPTransport(
            shells: [
                "one.example": multiEnvironmentShell(
                    projectID: duplicateIDs ? "project-shared" : "project-one",
                    threadID: duplicateIDs ? "thread-shared" : "thread-one",
                    title: "Local work"
                ),
                "two.example": multiEnvironmentShell(
                    projectID: duplicateIDs ? "project-shared" : "project-two",
                    threadID: duplicateIDs ? "thread-shared" : "thread-two",
                    title: "Remote work",
                    providerID: "claudeAgent",
                    modelID: "claude-opus-4-1"
                ),
            ]
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    "one": EnvironmentCredential(accessToken: "one-token"),
                    "two": EnvironmentCredential(accessToken: "two-token"),
                ]
            ),
            httpTransport: transport,
            webSocketConnector: UnavailableMultiEnvironmentWebSocketConnector()
        )
        let settings = UserDefaults(
            suiteName: "t3-native-multi-\(UUID().uuidString)"
        )!
        return MultiEnvironmentFixture(
            directory: directory,
            transport: transport,
            client: NativeFeatureClient(runtime: runtime, settingsStore: settings)
        )
    }
}

private struct MultiEnvironmentFixture {
    let directory: URL
    let transport: MultiEnvironmentHTTPTransport
    let client: NativeFeatureClient
}

private actor MultiEnvironmentHTTPTransport: HTTPTransport {
    private let shells: [String: OrchestrationShellSnapshot]
    private let shellData: [String: Data]
    private var reachableHosts: Set<String>
    private var dispatched: [MultiEnvironmentDispatchRecord] = []

    init(shells: [String: OrchestrationShellSnapshot]) {
        self.shells = shells
        shellData = shells.mapValues { try! JSONEncoder.t3.encode($0) }
        reachableHosts = Set(shells.keys)
    }

    func setReachable(_ reachable: Bool, host: String) {
        if reachable {
            reachableHosts.insert(host)
        } else {
            reachableHosts.remove(host)
        }
    }

    func dispatchHosts() -> [String] {
        dispatched.map(\.host)
    }

    func dispatchRecords() -> [MultiEnvironmentDispatchRecord] {
        dispatched
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let host = request.url?.host ?? ""
        guard reachableHosts.contains(host) else {
            throw URLError(.cannotConnectToHost)
        }
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell", let data = shellData[host] {
            return (data, multiEnvironmentResponse(request))
        }
        if path.hasPrefix("/api/orchestration/threads/") {
            let threadID = request.url?.lastPathComponent.removingPercentEncoding ?? "thread"
            let projectID = shells[host]?.threads
                .first(where: { $0.id == threadID })?
                .projectId ?? shells[host]?.projects.first?.id ?? "project"
            return (
                try JSONEncoder.t3.encode(
                    multiEnvironmentDetail(projectID: projectID, threadID: threadID)
                ),
                multiEnvironmentResponse(request)
            )
        }
        if path == "/api/orchestration/dispatch" {
            guard let body = request.httpBody else { throw URLError(.badServerResponse) }
            dispatched.append(
                MultiEnvironmentDispatchRecord(
                    host: host,
                    command: try JSONDecoder.t3.decode(JSONValue.self, from: body)
                )
            )
            return (
                try JSONEncoder.t3.encode(DispatchResult(sequence: 2)),
                multiEnvironmentResponse(request)
            )
        }
        if path == "/api/auth/websocket-ticket" {
            return (
                Data(
                    """
                    {"ticket":"ticket","expiresAt":"2026-07-31T12:05:00.000Z"}
                    """.utf8
                ),
                multiEnvironmentResponse(request)
            )
        }
        throw URLError(.unsupportedURL)
    }
}

private struct MultiEnvironmentDispatchRecord: Sendable {
    let host: String
    let command: JSONValue
}

private struct UnavailableMultiEnvironmentWebSocketConnector: WebSocketConnecting {
    func connect(to _: URL) async throws -> any WebSocketConnection {
        throw URLError(.cannotConnectToHost)
    }
}

private func multiEnvironmentShell(
    projectID: String,
    threadID: String,
    title: String,
    providerID: String = "codex",
    modelID: String = "gpt-5.6-sol"
) -> OrchestrationShellSnapshot {
    let timestamp = "2026-07-31T12:00:00.000Z"
    let model = ModelSelection(instanceId: providerID, model: modelID)
    return OrchestrationShellSnapshot(
        snapshotSequence: 1,
        projects: [
            OrchestrationProject(
                id: projectID,
                title: title,
                workspaceRoot: "/work/\(projectID)",
                repositoryIdentity: nil,
                defaultModelSelection: model,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: nil
            ),
        ],
        threads: [
            OrchestrationThreadShell(
                id: threadID,
                projectId: projectID,
                title: title,
                modelSelection: model,
                runtimeMode: .fullAccess,
                interactionMode: .default,
                branch: "feat/multi-device",
                worktreePath: nil,
                latestTurn: nil,
                createdAt: timestamp,
                updatedAt: timestamp,
                archivedAt: nil,
                settledOverride: nil,
                settledAt: nil,
                snoozedUntil: nil,
                snoozedAt: nil,
                session: nil,
                latestUserMessageAt: nil,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                hasActionableProposedPlan: false
            ),
        ],
        updatedAt: timestamp
    )
}

private func multiEnvironmentDetail(
    projectID: String,
    threadID: String
) -> OrchestrationThreadDetailSnapshot {
    let timestamp = "2026-07-31T12:00:00.000Z"
    return OrchestrationThreadDetailSnapshot(
        snapshotSequence: 2,
        thread: OrchestrationThread(
            id: threadID,
            projectId: projectID,
            title: threadID,
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: "feat/multi-device",
            worktreePath: nil,
            latestTurn: nil,
            createdAt: timestamp,
            updatedAt: timestamp,
            archivedAt: nil,
            settledOverride: nil,
            settledAt: nil,
            snoozedUntil: nil,
            snoozedAt: nil,
            deletedAt: nil,
            messages: [],
            activities: [],
            checkpoints: [],
            session: nil
        )
    )
}

private func multiEnvironmentResponse(_ request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
    )!
}
