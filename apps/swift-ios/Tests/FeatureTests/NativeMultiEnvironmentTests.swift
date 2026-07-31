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
        XCTAssertEqual(Set(snapshot.threads.map(\.id)), ["thread-one", "thread-two"])
        XCTAssertEqual(
            snapshot.threads.first(where: { $0.id == "thread-two" })?.environmentName,
            "Steam Box"
        )
        XCTAssertEqual(
            snapshot.environments.first(where: { $0.id == "two" })?.connectionState,
            .connected
        )

        let detail = try await fixture.client.loadThread(id: "thread-two")
        XCTAssertEqual(detail.thread.environmentID, "two")
        XCTAssertEqual(detail.thread.environmentName, "Steam Box")

        try await fixture.client.renameThread(id: "thread-two", title: "Remote rename")
        try await fixture.client.sendMessage(
            threadID: "thread-two",
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
        XCTAssertEqual(Set(passiveFailure.threads.map(\.id)), ["thread-one", "thread-two"])
        XCTAssertEqual(passiveFailure.connection.state, .connected)
        XCTAssertEqual(
            passiveFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .disconnected
        )

        await fixture.transport.setReachable(false, host: "one.example")
        await fixture.transport.setReachable(true, host: "two.example")

        let activeFailure = try await fixture.client.initialSnapshot()
        XCTAssertEqual(Set(activeFailure.threads.map(\.id)), ["thread-one", "thread-two"])
        XCTAssertEqual(activeFailure.connection.state, .disconnected)
        XCTAssertEqual(activeFailure.connection.environmentName, "Left Book")
        XCTAssertEqual(
            activeFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .connected
        )
        await fixture.client.disconnect()
    }

    private func makeFixture() async throws -> MultiEnvironmentFixture {
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
                    projectID: "project-one",
                    threadID: "thread-one",
                    title: "Local work"
                ),
                "two.example": multiEnvironmentShell(
                    projectID: "project-two",
                    threadID: "thread-two",
                    title: "Remote work"
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
    private let shellData: [String: Data]
    private var reachableHosts: Set<String>
    private var dispatchedToHosts: [String] = []

    init(shells: [String: OrchestrationShellSnapshot]) {
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
        dispatchedToHosts
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
            let projectID = threadID == "thread-two" ? "project-two" : "project-one"
            return (
                try JSONEncoder.t3.encode(
                    multiEnvironmentDetail(projectID: projectID, threadID: threadID)
                ),
                multiEnvironmentResponse(request)
            )
        }
        if path == "/api/orchestration/dispatch" {
            dispatchedToHosts.append(host)
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

private struct UnavailableMultiEnvironmentWebSocketConnector: WebSocketConnecting {
    func connect(to _: URL) async throws -> any WebSocketConnection {
        throw URLError(.cannotConnectToHost)
    }
}

private func multiEnvironmentShell(
    projectID: String,
    threadID: String,
    title: String
) -> OrchestrationShellSnapshot {
    let timestamp = "2026-07-31T12:00:00.000Z"
    let model = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")
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
