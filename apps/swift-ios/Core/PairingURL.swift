import Foundation

public struct PairingTarget: Equatable, Sendable {
    public let credential: String
    public let httpBaseURL: URL
    public let webSocketBaseURL: URL
}

public enum PairingURLError: LocalizedError, Equatable {
    case invalidURL
    case unsupportedScheme
    case missingToken
    case missingHost

    public var errorDescription: String? {
        switch self {
        case .invalidURL: "Pairing URL is invalid."
        case .unsupportedScheme: "Pairing URL uses an unsupported scheme."
        case .missingToken: "Pairing URL is missing its token."
        case .missingHost: "Pairing URL is missing its environment host."
        }
    }
}

public enum PairingURL {
    public static func resolve(_ rawValue: String) throws -> PairingTarget {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed), components.url != nil else {
            throw PairingURLError.invalidURL
        }
        guard ["http", "https", "ws", "wss"].contains(components.scheme?.lowercased() ?? "") else {
            throw PairingURLError.unsupportedScheme
        }

        let query = components.queryItems ?? []
        let fragment = URLComponents(string: "?\(components.fragment ?? "")")?.queryItems ?? []
        let token = (fragment + query)
            .first(where: { $0.name == "token" })?
            .value?
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if let hosted = query.first(where: { $0.name == "host" })?.value,
           !hosted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return try directTarget(host: hosted, credential: requireToken(token))
        }

        components.path = "/"
        components.query = nil
        components.fragment = nil
        guard let base = components.url, base.host != nil else { throw PairingURLError.missingHost }
        return try target(baseURL: base, credential: requireToken(token))
    }

    public static func resolve(host: String, pairingCode: String) throws -> PairingTarget {
        let normalized = host.contains("://") ? host : "https://\(host)"
        guard let url = URL(string: normalized), url.host != nil else {
            throw PairingURLError.invalidURL
        }
        return try directTarget(host: normalized, credential: requireToken(pairingCode))
    }

    private static func directTarget(host: String, credential: String) throws -> PairingTarget {
        let normalized = host.contains("://") ? host : "https://\(host)"
        guard var components = URLComponents(string: normalized), let url = components.url else {
            throw PairingURLError.invalidURL
        }
        guard ["http", "https", "ws", "wss"].contains(components.scheme?.lowercased() ?? "") else {
            throw PairingURLError.unsupportedScheme
        }
        components.path = "/"
        components.query = nil
        components.fragment = nil
        guard let base = components.url, url.host != nil else { throw PairingURLError.missingHost }
        return try target(baseURL: base, credential: credential)
    }

    private static func target(baseURL: URL, credential: String) throws -> PairingTarget {
        guard var http = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              var socket = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else {
            throw PairingURLError.invalidURL
        }
        switch http.scheme?.lowercased() {
        case "ws": http.scheme = "http"
        case "wss": http.scheme = "https"
        default: break
        }
        switch socket.scheme?.lowercased() {
        case "http": socket.scheme = "ws"
        case "https": socket.scheme = "wss"
        default: break
        }
        guard let httpURL = http.url, let socketURL = socket.url else {
            throw PairingURLError.invalidURL
        }
        return PairingTarget(
            credential: credential,
            httpBaseURL: httpURL,
            webSocketBaseURL: socketURL
        )
    }

    private static func requireToken(_ token: String?) throws -> String {
        let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { throw PairingURLError.missingToken }
        return trimmed
    }
}
