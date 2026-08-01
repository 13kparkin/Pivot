import Foundation
import Observation

@MainActor
public protocol T3ConnectCapable: AnyObject {
    var t3ConnectController: T3ConnectController { get }

    /// Save and activate the relay-managed environment without treating its
    /// bootstrap credential as a bearer token. Implementations prepare the
    /// DPoP access token and socket ticket through `managedAuthorizer`.
    func connectT3Environment(
        _ credential: T3ConnectManagedEnvironmentCredential
    ) async throws
}

public struct T3ConnectCloudEnvironment: Identifiable, Equatable, Sendable {
    public var id: String { environment.environmentId }

    public let environment: T3ConnectRelayEnvironment
    public let status: T3ConnectRelayEnvironmentStatus?
    public let statusError: String?

    public init(
        environment: T3ConnectRelayEnvironment,
        status: T3ConnectRelayEnvironmentStatus? = nil,
        statusError: String? = nil
    ) {
        self.environment = environment
        self.status = status
        self.statusError = statusError
    }
}

@MainActor
@Observable
public final class T3ConnectController {
    public let resolution: T3ConnectConfigurationResolution
    public let managedAuthorizer: T3ConnectManagedEnvironmentAuthorizer

    public private(set) var account: T3ConnectAccount?
    public private(set) var environments: [T3ConnectCloudEnvironment] = []
    public private(set) var isRefreshing = false
    public private(set) var busyEnvironmentID: String?
    public var errorMessage: String?

    private let auth: T3ConnectClerkSession?
    private let relay: T3ConnectRelayClient?

    public init(
        resolution: T3ConnectConfigurationResolution = T3ConnectConfiguration.resolve(),
        transport: any HTTPTransport = URLSessionHTTPTransport(),
        signer: T3ConnectDPoPSigner = T3ConnectDPoPSigner()
    ) {
        self.resolution = resolution
        managedAuthorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        guard let configuration = resolution.configuration else {
            auth = nil
            relay = nil
            return
        }
        auth = T3ConnectClerkSession(configuration: configuration)
        relay = T3ConnectRelayClient(
            configuration: configuration,
            transport: transport,
            signer: signer
        )
    }

    public var unavailableReason: String? {
        guard case let .unavailable(reason) = resolution else { return nil }
        return reason
    }

    public func refresh() async {
        guard let auth, let relay else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            if !auth.isLoaded { try await auth.refresh() }
            account = auth.account
            guard account != nil else {
                environments = []
                return
            }
            let token = try await auth.relayToken()
            let records = try await relay.listEnvironments(clerkToken: token)
            environments = records.map { T3ConnectCloudEnvironment(environment: $0) }
            environments = await withTaskGroup(
                of: T3ConnectCloudEnvironment.self,
                returning: [T3ConnectCloudEnvironment].self
            ) { group in
                for record in records {
                    group.addTask {
                        do {
                            let status = try await relay.status(for: record, clerkToken: token)
                            return T3ConnectCloudEnvironment(
                                environment: record,
                                status: status
                            )
                        } catch {
                            return T3ConnectCloudEnvironment(
                                environment: record,
                                statusError: error.localizedDescription
                            )
                        }
                    }
                }
                var loaded: [T3ConnectCloudEnvironment] = []
                for await environment in group { loaded.append(environment) }
                return loaded.sorted {
                    $0.environment.linkedAt > $1.environment.linkedAt
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func signIn(with provider: T3ConnectSignInProvider) async {
        guard let auth else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            try await auth.signIn(with: provider)
            account = auth.account
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func signOut() async {
        guard let auth, let relay else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            try await auth.signOut()
            await relay.clearTokenCache()
            account = nil
            environments = []
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func credential(
        for environment: T3ConnectRelayEnvironment,
        deviceID: String? = nil
    ) async throws -> T3ConnectManagedEnvironmentCredential {
        guard let auth, let relay else {
            throw T3ConnectRelayError.invalidConfiguration(
                unavailableReason ?? "T3 Connect is unavailable in this build."
            )
        }
        busyEnvironmentID = environment.environmentId
        defer { busyEnvironmentID = nil }
        let token = try await auth.relayToken()
        return try await relay.connect(
            to: environment,
            clerkToken: token,
            deviceID: deviceID
        )
    }

    public func unlink(_ environment: T3ConnectRelayEnvironment) async {
        guard let auth, let relay else { return }
        busyEnvironmentID = environment.environmentId
        defer { busyEnvironmentID = nil }
        do {
            let token = try await auth.relayToken()
            try await relay.unlinkEnvironment(
                environmentID: environment.environmentId,
                clerkToken: token
            )
            environments.removeAll { $0.id == environment.environmentId }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func registerDevice(_ registration: T3ConnectDeviceRegistration) async throws {
        guard let auth, let relay else {
            throw T3ConnectRelayError.invalidConfiguration(
                unavailableReason ?? "T3 Connect is unavailable in this build."
            )
        }
        let token = try await auth.relayToken()
        try await relay.registerDevice(registration, clerkToken: token)
    }
}
