import Foundation

public struct T3ConnectPreparedEnvironmentConnection: Sendable {
    public let authorization: T3ConnectEnvironmentAccessToken
    public let webSocketURL: URL

    public init(
        authorization: T3ConnectEnvironmentAccessToken,
        webSocketURL: URL
    ) {
        self.authorization = authorization
        self.webSocketURL = webSocketURL
    }
}

/// Converts the relay's short-lived environment bootstrap credential into the
/// DPoP access token and one-time WebSocket ticket understood by a T3 server.
/// The same signer must authorize every later HTTP request for that token.
public actor T3ConnectManagedEnvironmentAuthorizer {
    public static let standardScopes = [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
    ]

    private struct AccessTokenResponse: Decodable, Sendable {
        let accessToken: String
        let issuedTokenType: String
        let tokenType: String
        let expiresIn: Double
        let scope: String

        private enum CodingKeys: String, CodingKey {
            case accessToken = "access_token"
            case issuedTokenType = "issued_token_type"
            case tokenType = "token_type"
            case expiresIn = "expires_in"
            case scope
        }
    }

    private struct WebSocketTicketResponse: Decodable, Sendable {
        let ticket: String
        let expiresAt: String
    }

    private struct ErrorBody: Decodable, Sendable {
        let message: String?
        let reason: String?
        let traceId: String?
    }

    private let transport: any HTTPTransport
    private let signer: T3ConnectDPoPSigner

    public init(
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        signer: T3ConnectDPoPSigner = T3ConnectDPoPSigner()
    ) {
        self.transport = transport
        self.signer = signer
    }

    public func prepare(
        _ credential: T3ConnectManagedEnvironmentCredential,
        scopes: [String] = standardScopes,
        clientLabel: String? = nil
    ) async throws -> T3ConnectPreparedEnvironmentConnection {
        let accessToken = try await exchange(
            credential,
            scopes: scopes,
            clientLabel: clientLabel
        )
        let webSocketURL = try await webSocketURL(using: accessToken)
        return T3ConnectPreparedEnvironmentConnection(
            authorization: accessToken,
            webSocketURL: webSocketURL
        )
    }

    public func exchange(
        _ credential: T3ConnectManagedEnvironmentCredential,
        scopes: [String] = standardScopes,
        clientLabel: String? = nil
    ) async throws -> T3ConnectEnvironmentAccessToken {
        guard let httpBaseURL = credential.endpoint.httpBaseURL else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed environment HTTP URL is invalid."
            )
        }
        let target = endpoint(httpBaseURL, path: ["oauth", "token"])
        let proof = try await signer.proof(method: "POST", url: target)
        var fields = [
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": credential.bootstrapCredential,
            "subject_token_type": "urn:t3:params:oauth:token-type:environment-bootstrap",
            "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
            "scope": scopes.joined(separator: " "),
            "client_device_type": "mobile",
            "client_os": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        if let clientLabel, !clientLabel.isEmpty {
            fields["client_label"] = clientLabel
        }
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.httpBody = Self.formEncoded(fields)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(proof.value, forHTTPHeaderField: "DPoP")
        let response = try await send(request, as: AccessTokenResponse.self)
        guard response.tokenType == "DPoP" else { throw T3ConnectRelayError.invalidResponse }
        let thumbprint = try await signer.thumbprint()
        guard thumbprint == credential.proofKeyThumbprint else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed credential is bound to a different device identity."
            )
        }
        return T3ConnectEnvironmentAccessToken(
            environmentID: credential.environmentID,
            label: credential.label,
            endpoint: credential.endpoint,
            accessToken: response.accessToken,
            expiresAt: Date().addingTimeInterval(response.expiresIn),
            scopes: response.scope.split(separator: " ").map(String.init),
            proofKeyThumbprint: thumbprint
        )
    }

    /// Adds a fresh request-bound proof. Call this immediately before sending;
    /// reusing a proof defeats replay protection and is rejected by the server.
    public func authorize(
        _ request: URLRequest,
        using authorization: T3ConnectEnvironmentAccessToken
    ) async throws -> URLRequest {
        guard let url = request.url else { throw T3ConnectDPoPError.invalidURL }
        let proof = try await signer.proof(
            method: request.httpMethod ?? "GET",
            url: url,
            accessToken: authorization.accessToken
        )
        guard proof.thumbprint == authorization.proofKeyThumbprint else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The environment token is bound to a different device identity."
            )
        }
        var authorized = request
        authorized.setValue(
            "DPoP \(authorization.accessToken)",
            forHTTPHeaderField: "Authorization"
        )
        authorized.setValue(proof.value, forHTTPHeaderField: "DPoP")
        return authorized
    }

    public func webSocketURL(
        using authorization: T3ConnectEnvironmentAccessToken
    ) async throws -> URL {
        guard
            let httpBaseURL = authorization.endpoint.httpBaseURL,
            let webSocketBaseURL = authorization.endpoint.webSocketBaseURL
        else {
            throw T3ConnectRelayError.invalidConfiguration(
                "The managed environment endpoint is invalid."
            )
        }
        let target = endpoint(
            httpBaseURL,
            path: ["api", "auth", "websocket-ticket"]
        )
        var ticketRequest = URLRequest(url: target)
        ticketRequest.httpMethod = "POST"
        ticketRequest = try await authorize(ticketRequest, using: authorization)
        let ticket = try await send(ticketRequest, as: WebSocketTicketResponse.self)

        var components = URLComponents(
            url: webSocketBaseURL,
            resolvingAgainstBaseURL: false
        )
        if components?.path.isEmpty == true || components?.path == "/" {
            components?.path = "/ws"
        }
        var queryItems = components?.queryItems ?? []
        queryItems.removeAll { $0.name == "wsTicket" }
        queryItems.append(URLQueryItem(name: "wsTicket", value: ticket.ticket))
        components?.queryItems = queryItems
        guard let url = components?.url else { throw T3ConnectDPoPError.invalidURL }
        return url
    }

    private func endpoint(_ baseURL: URL, path: [String]) -> URL {
        path.reduce(baseURL) { partial, component in
            partial.appendingPathComponent(component)
        }
    }

    private func send<Response: Decodable & Sendable>(
        _ request: URLRequest,
        as type: Response.Type
    ) async throws -> Response {
        let (data, response) = try await transport.data(for: HTTPRequestPolicy.prepare(request))
        guard (200..<300).contains(response.statusCode) else {
            let body = try? JSONDecoder.t3.decode(ErrorBody.self, from: data)
            throw T3ConnectRelayError.response(
                status: response.statusCode,
                message: body?.message ?? body?.reason ?? "Environment authorization failed.",
                traceID: body?.traceId
            )
        }
        do {
            return try JSONDecoder.t3.decode(type, from: data)
        } catch {
            throw T3ConnectRelayError.invalidResponse
        }
    }

    private static func formEncoded(_ fields: [String: String]) -> Data {
        var components = URLComponents()
        components.queryItems = fields.keys.sorted().map {
            URLQueryItem(name: $0, value: fields[$0])
        }
        return Data((components.percentEncodedQuery ?? "").utf8)
    }
}
