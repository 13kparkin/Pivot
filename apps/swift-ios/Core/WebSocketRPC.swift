import Foundation

public protocol WebSocketConnection: Sendable {
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func close() async
}

public protocol WebSocketConnecting: Sendable {
    func connect(to url: URL) async throws -> any WebSocketConnection
}

public enum WebSocketHandshakeRequest {
    public static let perMessageDeflateOffer = "permessage-deflate; client_max_window_bits"

    /// URLSessionWebSocketTask accepts a URLRequest for its opening handshake.
    /// It does not expose the 101 response headers or negotiated extensions,
    /// so callers can know that compression was offered, not prove that a
    /// particular connection accepted it.
    public static func make(
        url: URL,
        offersPerMessageDeflate: Bool = true
    ) -> URLRequest {
        var request = URLRequest(url: url)
        if offersPerMessageDeflate {
            request.setValue(
                perMessageDeflateOffer,
                forHTTPHeaderField: "Sec-WebSocket-Extensions"
            )
        }
        return request
    }
}

public struct URLSessionWebSocketConnector: WebSocketConnecting {
    private let session: URLSession
    private let offersPerMessageDeflate: Bool

    public init(
        session: URLSession = .shared,
        offersPerMessageDeflate: Bool = true
    ) {
        self.session = session
        self.offersPerMessageDeflate = offersPerMessageDeflate
    }

    public func connect(to url: URL) async throws -> any WebSocketConnection {
        let request = WebSocketHandshakeRequest.make(
            url: url,
            offersPerMessageDeflate: offersPerMessageDeflate
        )
        let connection = URLSessionWebSocketConnection(session: session, request: request)
        await connection.open()
        return connection
    }
}

private actor URLSessionWebSocketConnection: WebSocketConnection {
    private let task: URLSessionWebSocketTask

    init(session: URLSession, request: URLRequest) {
        task = session.webSocketTask(with: request)
    }

    func open() {
        task.resume()
    }

    func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    func receive() async throws -> Data {
        switch try await task.receive() {
        case let .data(data):
            return data
        case let .string(string):
            guard let data = string.data(using: .utf8) else {
                throw RPCError.protocolViolation("WebSocket text was not UTF-8.")
            }
            return data
        @unknown default:
            throw RPCError.protocolViolation("Unknown WebSocket message.")
        }
    }

    func close() {
        task.cancel(with: .goingAway, reason: nil)
    }
}

public enum RPCError: LocalizedError, Sendable {
    case connectionUnavailable
    case disconnected
    case responseTimedOut
    case remote(String)
    case protocolViolation(String)

    public var errorDescription: String? {
        switch self {
        case .connectionUnavailable:
            "The live command connection is unavailable."
        case .disconnected: "The environment disconnected."
        case .responseTimedOut: "The environment did not answer the command in time."
        case let .remote(message): message
        case let .protocolViolation(message): message
        }
    }
}

private struct RPCRequestEnvelope: Encodable, Sendable {
    let _tag = "Request"
    let id: Int
    let tag: String
    let payload: JSONValue
    let headers: [[String]]
}

private struct RPCControlEnvelope: Encodable, Sendable {
    let _tag: String
    let requestId: Int?

    init(_ tag: String, requestID: Int? = nil) {
        _tag = tag
        requestId = requestID
    }
}

private struct RPCResponseEnvelope: Decodable, Sendable {
    struct Exit: Decodable, Sendable {
        struct Cause: Decodable, Sendable {
            let _tag: String
            let error: JSONValue?
            let defect: JSONValue?
        }

        let _tag: String
        let value: JSONValue?
        let cause: [Cause]?
    }

    let _tag: String
    let requestId: Int?
    let values: [JSONValue]?
    let exit: Exit?
    let defect: JSONValue?
}

/// Implements Effect RPC's JSON socket framing. Subscriptions survive
/// reconnects; unary calls that crossed a broken connection fail rather than
/// being replayed, because replaying a command could duplicate side effects.
public actor WebSocketRPCClient {
    public typealias EndpointProvider = @Sendable () async throws -> URL

    private struct UnaryRequest {
        let envelope: RPCRequestEnvelope
        var sent: Bool
        var connectionWaitTask: Task<Void, Never>?
        var sendDeadlineTask: Task<Void, Never>?
        var responseDeadlineTask: Task<Void, Never>?
        let resume: @Sendable (Result<JSONValue, Error>) -> Void
    }

    private struct Subscription {
        let tag: String
        let payload: JSONValue
        let reconnect: Bool
        var requestID: Int?
        let yield: @Sendable (JSONValue) -> Void
        let finish: @Sendable (Error?) -> Void
    }

    private let connector: any WebSocketConnecting
    private let endpointProvider: EndpointProvider
    private let connectionWaitTimeout: Duration
    private let responseTimeout: Duration
    private var connection: (any WebSocketConnection)?
    private var connectionID: UUID?
    private var loopTask: Task<Void, Never>?
    private var keepaliveTask: Task<Void, Never>?
    private var desired = false
    private var nextRequestID = 1
    private var unary: [Int: UnaryRequest] = [:]
    private var subscriptions: [UUID: Subscription] = [:]
    private var subscriptionByRequestID: [Int: UUID] = [:]

    public init(
        connector: any WebSocketConnecting = URLSessionWebSocketConnector(),
        connectionWaitTimeout: Duration = .seconds(4),
        responseTimeout: Duration = .seconds(30),
        endpointProvider: @escaping EndpointProvider
    ) {
        self.connector = connector
        self.connectionWaitTimeout = connectionWaitTimeout
        self.responseTimeout = responseTimeout
        self.endpointProvider = endpointProvider
    }

    deinit {
        loopTask?.cancel()
        keepaliveTask?.cancel()
    }

    public func start() {
        desired = true
        guard loopTask == nil else { return }
        loopTask = Task { await self.connectionLoop() }
    }

    public func isConnected() -> Bool {
        connection != nil
    }

    public func stop() async {
        desired = false
        loopTask?.cancel()
        loopTask = nil
        keepaliveTask?.cancel()
        keepaliveTask = nil
        if let connection {
            await connection.close()
        }
        connection = nil
        connectionID = nil
        failUnary(RPCError.disconnected, includingUnsent: true)
        let active = subscriptions.values
        subscriptions.removeAll()
        subscriptionByRequestID.removeAll()
        active.forEach { $0.finish(RPCError.disconnected) }
    }

    public func request<Result: Decodable & Sendable>(
        _ tag: String,
        payload: JSONValue = .object([:]),
        as type: Result.Type
    ) async throws -> Result {
        let raw = try await requestRaw(tag, payload: payload)
        return try raw.decode(type)
    }

    public func request(
        _ tag: String,
        payload: JSONValue = .object([:])
    ) async throws {
        _ = try await requestRaw(tag, payload: payload)
    }

    public func subscribe<Value: Decodable & Sendable>(
        _ tag: String,
        payload: JSONValue = .object([:]),
        reconnect: Bool = true,
        as type: Value.Type
    ) -> AsyncThrowingStream<Value, Error> {
        let subscriptionID = UUID()
        return AsyncThrowingStream { continuation in
            subscriptions[subscriptionID] = Subscription(
                tag: tag,
                payload: payload,
                reconnect: reconnect,
                requestID: nil,
                yield: { value in
                    do {
                        continuation.yield(try value.decode(type))
                    } catch {
                        continuation.finish(throwing: error)
                    }
                },
                finish: { error in
                    if let error {
                        continuation.finish(throwing: error)
                    } else {
                        continuation.finish()
                    }
                }
            )
            continuation.onTermination = { @Sendable _ in
                Task { await self.removeSubscription(subscriptionID) }
            }
            if connection != nil {
                Task { await self.sendSubscription(subscriptionID) }
            }
            start()
        }
    }

    private func requestRaw(_ tag: String, payload: JSONValue) async throws -> JSONValue {
        start()
        let id = allocateRequestID()
        let envelope = RPCRequestEnvelope(
            id: id,
            tag: tag,
            payload: payload,
            headers: []
        )
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                unary[id] = UnaryRequest(
                    envelope: envelope,
                    sent: false,
                    connectionWaitTask: nil,
                    sendDeadlineTask: nil,
                    responseDeadlineTask: nil,
                    resume: { continuation.resume(with: $0) }
                )
                installUnaryDeadlines(id)
                if connection != nil {
                    Task { await self.sendUnary(id) }
                }
            }
        } onCancel: {
            Task { await self.cancelUnary(id) }
        }
    }

    private func connectionLoop() async {
        var retry = 0
        while desired, !Task.isCancelled {
            do {
                let url = try await endpointProvider()
                let opened = try await connector.connect(to: url)
                let openedID = UUID()
                connection = opened
                connectionID = openedID
                retry = 0
                await connected()
                // Sending queued work during setup is actor-reentrant. A send
                // failure can discard this socket before setup completes, so
                // never enter its receive loop after ownership has moved on.
                guard connectionID == openedID else {
                    throw RPCError.disconnected
                }
                try await receiveLoop(opened)
            } catch {
                await disconnected()
                guard desired, !Task.isCancelled else { break }
                retry += 1
                let delay = min(5.0, 0.35 * pow(1.7, Double(retry - 1)))
                try? await Task.sleep(for: .seconds(delay))
            }
        }
        loopTask = nil
    }

    private func connected() async {
        keepaliveTask?.cancel()
        keepaliveTask = Task { await self.keepaliveLoop() }
        for id in unary.keys {
            await sendUnary(id)
        }
        subscriptionByRequestID.removeAll()
        for id in subscriptions.keys {
            await sendSubscription(id)
        }
    }

    private func disconnected(expectedConnectionID: UUID? = nil) async {
        if let expectedConnectionID, connectionID != expectedConnectionID {
            return
        }
        let closingConnection = connection
        keepaliveTask?.cancel()
        keepaliveTask = nil
        connection = nil
        connectionID = nil
        failUnary(RPCError.disconnected, includingUnsent: false)
        subscriptionByRequestID.removeAll()
        let oneShotSubscriptions = subscriptions.filter { !$0.value.reconnect }
        for (id, subscription) in oneShotSubscriptions {
            subscriptions.removeValue(forKey: id)
            subscription.finish(RPCError.disconnected)
        }
        for id in subscriptions.keys {
            subscriptions[id]?.requestID = nil
        }
        await closingConnection?.close()
    }

    private func receiveLoop(_ opened: any WebSocketConnection) async throws {
        while desired, !Task.isCancelled {
            let data = try await opened.receive()
            let response = try JSONDecoder.t3.decode(RPCResponseEnvelope.self, from: data)
            try await handle(response)
        }
    }

    private func handle(_ response: RPCResponseEnvelope) async throws {
        switch response._tag {
        case "Pong":
            return
        case "Chunk":
            guard let requestID = response.requestId,
                  let subscriptionID = subscriptionByRequestID[requestID],
                  let subscription = subscriptions[subscriptionID]
            else { return }
            response.values?.forEach(subscription.yield)
            try await sendControl("Ack", requestID: requestID)
        case "Exit":
            guard let requestID = response.requestId, let exit = response.exit else { return }
            if unary[requestID] != nil {
                if exit._tag == "Success" {
                    completeUnary(requestID, with: .success(exit.value ?? .null))
                } else {
                    completeUnary(requestID, with: .failure(remoteError(exit)))
                }
                return
            }
            guard let subscriptionID = subscriptionByRequestID.removeValue(forKey: requestID),
                  let subscription = subscriptions.removeValue(forKey: subscriptionID)
            else { return }
            subscription.finish(exit._tag == "Success" ? nil : remoteError(exit))
        case "Defect", "ClientProtocolError":
            throw RPCError.remote(
                response.defect?.stringValue ?? "The server reported an RPC protocol error."
            )
        default:
            throw RPCError.protocolViolation("Unknown RPC response \(response._tag).")
        }
    }

    private func sendUnary(_ id: Int) async {
        guard let connection,
              let connectionID,
              var request = unary[id],
              !request.sent else { return }
        // Actor methods are reentrant at the send below. Record that this
        // command crossed the socket boundary first so a concurrent
        // disconnect fails it instead of replaying an ambiguous mutation.
        request.sent = true
        unary[id] = request
        startUnarySendDeadline(id, connectionID: connectionID)
        do {
            try await connection.send(JSONEncoder.t3.encode(request.envelope))
            startUnaryResponseDeadline(id)
        } catch {
            // A response, disconnect, or stop may have completed the request
            // while send was suspended. Only its current owner may resume it.
            completeUnary(id, with: .failure(RPCError.disconnected))
            await disconnected(expectedConnectionID: connectionID)
        }
    }

    private func sendSubscription(_ subscriptionID: UUID) async {
        guard let connection,
              let connectionID,
              var subscription = subscriptions[subscriptionID] else { return }
        let requestID = allocateRequestID()
        let envelope = RPCRequestEnvelope(
            id: requestID,
            tag: subscription.tag,
            payload: subscription.payload,
            headers: []
        )
        do {
            try await connection.send(JSONEncoder.t3.encode(envelope))
            subscription.requestID = requestID
            subscriptions[subscriptionID] = subscription
            subscriptionByRequestID[requestID] = subscriptionID
        } catch {
            // Retain the subscription for the next socket, but make the send
            // failure visible to the connection loop by closing this socket.
            await disconnected(expectedConnectionID: connectionID)
        }
    }

    private func removeSubscription(_ id: UUID) async {
        guard let subscription = subscriptions.removeValue(forKey: id) else { return }
        if let requestID = subscription.requestID {
            subscriptionByRequestID.removeValue(forKey: requestID)
            try? await sendControl("Interrupt", requestID: requestID)
        }
    }

    private func keepaliveLoop() async {
        while desired, connection != nil, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            guard desired, connection != nil, !Task.isCancelled else { return }
            try? await sendControl("Ping", requestID: nil)
        }
    }

    private func sendControl(_ tag: String, requestID: Int?) async throws {
        guard let connection, let connectionID else { throw RPCError.disconnected }
        do {
            try await connection.send(
                JSONEncoder.t3.encode(RPCControlEnvelope(tag, requestID: requestID))
            )
        } catch {
            await disconnected(expectedConnectionID: connectionID)
            throw RPCError.disconnected
        }
    }

    private func failUnary(_ error: Error, includingUnsent: Bool) {
        let failedIDs = unary.compactMap { id, request in
            includingUnsent || request.sent ? id : nil
        }
        for id in failedIDs {
            completeUnary(id, with: .failure(error))
        }
    }

    private func failUnaryIfUnsent(_ id: Int) {
        guard let request = unary[id], !request.sent else { return }
        completeUnary(id, with: .failure(RPCError.connectionUnavailable))
    }

    private func installUnaryDeadlines(_ id: Int) {
        guard var request = unary[id] else { return }
        let connectionWaitTimeout = connectionWaitTimeout
        request.connectionWaitTask = Task { [weak self] in
            do {
                try await Task.sleep(for: connectionWaitTimeout)
            } catch {
                return
            }
            await self?.failUnaryIfUnsent(id)
        }
        unary[id] = request
    }

    private func startUnaryResponseDeadline(_ id: Int) {
        guard var request = unary[id], request.sent else { return }
        request.connectionWaitTask?.cancel()
        request.connectionWaitTask = nil
        request.sendDeadlineTask?.cancel()
        request.sendDeadlineTask = nil
        let responseTimeout = responseTimeout
        request.responseDeadlineTask = Task { [weak self] in
            do {
                try await Task.sleep(for: responseTimeout)
            } catch {
                return
            }
            await self?.failUnaryOnResponseDeadline(id)
        }
        unary[id] = request
    }

    private func startUnarySendDeadline(_ id: Int, connectionID: UUID) {
        guard var request = unary[id], request.sent else { return }
        request.connectionWaitTask?.cancel()
        request.connectionWaitTask = nil
        let sendTimeout = responseTimeout
        request.sendDeadlineTask = Task { [weak self] in
            do {
                try await Task.sleep(for: sendTimeout)
            } catch {
                return
            }
            await self?.failUnaryOnSendDeadline(id, connectionID: connectionID)
        }
        unary[id] = request
    }

    private func failUnaryOnSendDeadline(_ id: Int, connectionID: UUID) async {
        guard let request = unary[id],
              request.sent,
              request.responseDeadlineTask == nil else { return }
        completeUnary(id, with: .failure(RPCError.responseTimedOut))
        await disconnected(expectedConnectionID: connectionID)
    }

    private func failUnaryOnResponseDeadline(_ id: Int) async {
        guard let request = unary[id] else { return }
        let sent = request.sent
        completeUnary(id, with: .failure(RPCError.responseTimedOut))
        if sent {
            try? await sendControl("Interrupt", requestID: id)
        }
    }

    private func cancelUnary(_ id: Int) async {
        guard let request = unary[id] else { return }
        let sent = request.sent
        completeUnary(id, with: .failure(CancellationError()))
        if sent {
            try? await sendControl("Interrupt", requestID: id)
        }
    }

    private func completeUnary(_ id: Int, with result: Result<JSONValue, Error>) {
        guard let request = unary.removeValue(forKey: id) else { return }
        request.connectionWaitTask?.cancel()
        request.sendDeadlineTask?.cancel()
        request.responseDeadlineTask?.cancel()
        request.resume(result)
    }

    private func remoteError(_ exit: RPCResponseEnvelope.Exit) -> RPCError {
        let value = exit.cause?.first?.error
        let message = value?["message"]?.stringValue
            ?? value?["detail"]?.stringValue
            ?? "The environment rejected the RPC request."
        return .remote(message)
    }

    private func allocateRequestID() -> Int {
        defer { nextRequestID += 1 }
        return nextRequestID
    }
}
