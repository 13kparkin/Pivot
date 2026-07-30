import Foundation

public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionHTTPTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.httpAdditionalHeaders = [
                "Accept-Encoding": HTTPRequestPolicy.acceptEncoding,
            ]
            self.session = URLSession(configuration: configuration)
        }
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        // URLSession transparently decodes gzip responses before returning
        // their body. Applying the policy here is a final guard for requests
        // constructed outside EnvironmentAPI.
        let (data, response) = try await session.data(for: HTTPRequestPolicy.prepare(request))
        guard let httpResponse = response as? HTTPURLResponse else {
            throw HTTPError.invalidResponse
        }
        return (data, httpResponse)
    }
}

/// Shared wire-level defaults for HTTP requests.
///
/// Foundation's URL loading system transparently decompresses gzip response
/// bodies. The explicit offer matters because T3 only compresses JSON when the
/// client advertises support.
public enum HTTPRequestPolicy {
    public static let acceptEncoding = "gzip"

    public static func prepare(_ request: URLRequest) -> URLRequest {
        var prepared = request
        if prepared.value(forHTTPHeaderField: "Accept-Encoding") == nil {
            prepared.setValue(acceptEncoding, forHTTPHeaderField: "Accept-Encoding")
        }
        if prepared.value(forHTTPHeaderField: "Accept") == nil {
            prepared.setValue("application/json", forHTTPHeaderField: "Accept")
        }
        return prepared
    }
}

public enum HTTPError: LocalizedError, Sendable {
    case invalidResponse
    case status(Int, message: String, traceID: String?)
    case missingCredential

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "The server returned an invalid response."
        case let .status(status, message, traceID):
            traceID.map { "\(message) (trace \($0))" } ?? "\(message) (HTTP \(status))"
        case .missingCredential:
            "This environment has no saved credential."
        }
    }
}

private struct ErrorBody: Decodable {
    let message: String?
    let reason: String?
    let traceId: String?
}

public actor EnvironmentAPI {
    private let transport: any HTTPTransport
    private let credentials: any CredentialStore

    public init(
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        credentials: any CredentialStore
    ) {
        self.transport = transport
        self.credentials = credentials
    }

    public func descriptor(at httpBaseURL: URL) async throws -> EnvironmentDescriptor {
        try await send(
            URLRequest(url: endpoint(httpBaseURL, path: "/.well-known/t3/environment")),
            as: EnvironmentDescriptor.self
        )
    }

    public func shellSnapshot(for environment: Environment) async throws
        -> OrchestrationShellSnapshot
    {
        try await authorized(
            environment: environment,
            path: "/api/orchestration/shell",
            method: "GET",
            as: OrchestrationShellSnapshot.self
        )
    }

    public func readModel(for environment: Environment) async throws -> OrchestrationReadModel {
        try await authorized(
            environment: environment,
            path: "/api/orchestration/snapshot",
            method: "GET",
            as: OrchestrationReadModel.self
        )
    }

    public func threadSnapshot(
        id: String,
        environment: Environment
    ) async throws -> OrchestrationThreadDetailSnapshot {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await authorized(
            environment: environment,
            path: "/api/orchestration/threads/\(encodedID)",
            method: "GET",
            as: OrchestrationThreadDetailSnapshot.self
        )
    }

    public func dispatch(
        _ command: JSONValue,
        environment: Environment
    ) async throws -> DispatchResult {
        try await authorized(
            environment: environment,
            path: "/api/orchestration/dispatch",
            method: "POST",
            body: JSONEncoder.t3.encode(command),
            as: DispatchResult.self
        )
    }

    public func webSocketTicket(for environment: Environment) async throws -> WebSocketTicket {
        try await authorized(
            environment: environment,
            path: "/api/auth/websocket-ticket",
            method: "POST",
            as: WebSocketTicket.self
        )
    }

    public func session(for environment: Environment) async throws -> AuthSessionState {
        try await authorized(
            environment: environment,
            path: "/api/auth/session",
            method: "GET",
            as: AuthSessionState.self
        )
    }

    public func clientSessions(for environment: Environment) async throws
        -> [AuthClientSession]
    {
        try await authorized(
            environment: environment,
            path: "/api/auth/clients",
            method: "GET",
            as: [AuthClientSession].self
        )
    }

    public func revokeClientSession(
        id: String,
        environment: Environment
    ) async throws -> AuthClientSessionRevokeResult {
        try await authorized(
            environment: environment,
            path: "/api/auth/clients/revoke",
            method: "POST",
            body: JSONEncoder.t3.encode(["sessionId": id]),
            as: AuthClientSessionRevokeResult.self
        )
    }

    public func revokeOtherClientSessions(
        for environment: Environment
    ) async throws -> AuthOtherClientSessionsRevokeResult {
        try await authorized(
            environment: environment,
            path: "/api/auth/clients/revoke-others",
            method: "POST",
            as: AuthOtherClientSessionsRevokeResult.self
        )
    }

    private func authorized<Result: Decodable & Sendable>(
        environment: Environment,
        path: String,
        method: String,
        body: Data? = nil,
        as type: Result.Type
    ) async throws -> Result {
        guard let credential = try await credentials.credential(for: environment.id) else {
            throw HTTPError.missingCredential
        }
        var request = URLRequest(url: endpoint(environment.httpBaseURL, path: path))
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await send(request, as: type)
    }

    private func send<Result: Decodable & Sendable>(
        _ request: URLRequest,
        as type: Result.Type
    ) async throws -> Result {
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(ErrorBody.self, from: data)
            throw HTTPError.status(
                response.statusCode,
                message: body?.message ?? body?.reason ?? "Environment request failed.",
                traceID: body?.traceId
            )
        }
        return try JSONDecoder.t3.decode(type, from: data)
    }
}

public struct DispatchResult: Codable, Equatable, Sendable {
    public let sequence: Int
}

public struct WebSocketTicket: Codable, Equatable, Sendable {
    public let ticket: String
    public let expiresAt: String
}

public struct AuthSessionState: Codable, Equatable, Sendable {
    public let authenticated: Bool
    public let scopes: [String]?
    public let sessionMethod: String?
    public let expiresAt: String?
}

public struct AuthClientMetadata: Codable, Equatable, Sendable {
    public let label: String?
    public let ipAddress: String?
    public let userAgent: String?
    public let deviceType: String
    public let os: String?
    public let browser: String?
}

public struct AuthClientSession: Codable, Identifiable, Equatable, Sendable {
    public var id: String { sessionId }

    public let sessionId: String
    public let subject: String
    public let scopes: [String]
    public let method: String
    public let client: AuthClientMetadata
    public let issuedAt: String
    public let expiresAt: String
    public let lastConnectedAt: String?
    public let connected: Bool
    public let current: Bool
}

public struct AuthClientSessionRevokeResult: Codable, Equatable, Sendable {
    public let revoked: Bool
}

public struct AuthOtherClientSessionsRevokeResult: Codable, Equatable, Sendable {
    public let revokedCount: Int
}

func endpoint(_ baseURL: URL, path: String) -> URL {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    components.path = path
    components.query = nil
    components.fragment = nil
    return components.url!
}
