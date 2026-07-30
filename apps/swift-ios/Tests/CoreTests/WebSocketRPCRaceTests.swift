import XCTest
@testable import T3Code

@MainActor
final class WebSocketRPCRaceTests: XCTestCase {
    func testDisconnectWhileUnarySendIsSuspendedFailsWithoutReplay() async throws {
        let first = SuspendedSendConnection()
        let second = AutoReplyConnection()
        let connector = SequencedConnector(connections: [first, second])
        let client = WebSocketRPCClient(
            connector: connector,
            connectionWaitTimeout: .seconds(2),
            endpointProvider: { URL(string: "wss://studio.example/ws")! }
        )

        await client.start()
        await first.waitUntilReceiving()

        let request = Task {
            do {
                let value = try await client.request(
                    "thread.rename",
                    as: JSONValue.self
                )
                return Result<JSONValue, Error>.success(value)
            } catch {
                return Result<JSONValue, Error>.failure(error)
            }
        }

        await first.waitUntilSending()
        await first.failReceive()

        let outcome = await request.value
        guard case let .failure(error) = outcome,
              case .disconnected = error as? RPCError
        else {
            await client.stop()
            await first.releaseSend()
            return XCTFail("An ambiguous unary send must fail as disconnected.")
        }

        await connector.waitUntilConnectionCount(2)
        let replayedRequestCount = await second.sentRequestCount()
        XCTAssertEqual(
            replayedRequestCount,
            0,
            "A unary request that crossed a broken socket must not be replayed."
        )

        await client.stop()
        await first.releaseSend()
    }
}

private actor SequencedConnector: WebSocketConnecting {
    private let connections: [any WebSocketConnection]
    private var nextIndex = 0
    private var countWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    init(connections: [any WebSocketConnection]) {
        self.connections = connections
    }

    func connect(to _: URL) throws -> any WebSocketConnection {
        guard nextIndex < connections.count else {
            throw URLError(.cannotConnectToHost)
        }
        let connection = connections[nextIndex]
        nextIndex += 1
        let completed = countWaiters.filter { nextIndex >= $0.0 }
        countWaiters.removeAll { nextIndex >= $0.0 }
        completed.forEach { $0.1.resume() }
        return connection
    }

    func waitUntilConnectionCount(_ count: Int) async {
        guard nextIndex < count else { return }
        await withCheckedContinuation { continuation in
            countWaiters.append((count, continuation))
        }
    }
}

private actor SuspendedSendConnection: WebSocketConnection {
    private var sendContinuation: CheckedContinuation<Void, Error>?
    private var receiveContinuation: CheckedContinuation<Data, Error>?
    private var sendWaiters: [CheckedContinuation<Void, Never>] = []
    private var receiveWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_: Data) async throws {
        let waiters = sendWaiters
        sendWaiters.removeAll()
        waiters.forEach { $0.resume() }
        try await withCheckedThrowingContinuation { continuation in
            sendContinuation = continuation
        }
    }

    func receive() async throws -> Data {
        let waiters = receiveWaiters
        receiveWaiters.removeAll()
        waiters.forEach { $0.resume() }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() {
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
    }

    func waitUntilSending() async {
        guard sendContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            sendWaiters.append(continuation)
        }
    }

    func waitUntilReceiving() async {
        guard receiveContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            receiveWaiters.append(continuation)
        }
    }

    func failReceive() {
        receiveContinuation?.resume(throwing: URLError(.networkConnectionLost))
        receiveContinuation = nil
    }

    func releaseSend() {
        sendContinuation?.resume()
        sendContinuation = nil
    }
}

private actor AutoReplyConnection: WebSocketConnection {
    private var sentRequests = 0
    private var queuedResponses: [Data] = []
    private var receiveContinuation: CheckedContinuation<Data, Error>?

    func send(_ data: Data) throws {
        sentRequests += 1
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard case let .number(requestID) = request["id"] else { return }
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(requestID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": .object([:]),
            ]),
        ])
        enqueue(try JSONEncoder.t3.encode(response))
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() {
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
    }

    func sentRequestCount() -> Int {
        sentRequests
    }

    private func enqueue(_ data: Data) {
        if let receiveContinuation {
            self.receiveContinuation = nil
            receiveContinuation.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }
}
