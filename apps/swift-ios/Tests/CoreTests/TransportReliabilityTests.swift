import XCTest
@testable import T3Code

@MainActor
final class TransportReliabilityTests: XCTestCase {
    func testHTTPPolicyOffersGzipWithoutOverwritingCallerPreference() {
        var request = URLRequest(url: URL(string: "https://studio.example/api")!)
        let prepared = HTTPRequestPolicy.prepare(request)
        XCTAssertEqual(prepared.value(forHTTPHeaderField: "Accept-Encoding"), "gzip")
        XCTAssertEqual(prepared.value(forHTTPHeaderField: "Accept"), "application/json")

        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        XCTAssertEqual(
            HTTPRequestPolicy.prepare(request).value(forHTTPHeaderField: "Accept-Encoding"),
            "identity"
        )
    }

    func testEnvironmentAPIDecodesURLSessionDecompressedGzipResponse() async throws {
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {"repositoryIdentity": true}
            }
            """
            return (
                Data(body.utf8),
                transportResponse(
                    request,
                    headers: [
                        "Content-Type": "application/json",
                        // URLSession retains this response header while
                        // returning the already decompressed body.
                        "Content-Encoding": "gzip",
                    ]
                )
            )
        }
        let api = EnvironmentAPI(
            transport: transport,
            credentials: InMemoryCredentialStore()
        )

        let descriptor = try await api.descriptor(
            at: URL(string: "https://studio.example")!
        )
        XCTAssertEqual(descriptor.environmentId, "environment-1")
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept-Encoding"), "gzip")
    }

    func testWebSocketHandshakeOffersPerMessageDeflate() {
        let url = URL(string: "wss://studio.example/ws?wsTicket=secret")!
        let compressed = WebSocketHandshakeRequest.make(url: url)
        XCTAssertEqual(
            compressed.value(forHTTPHeaderField: "Sec-WebSocket-Extensions"),
            "permessage-deflate; client_max_window_bits"
        )
        XCTAssertNil(
            WebSocketHandshakeRequest.make(
                url: url,
                offersPerMessageDeflate: false
            ).value(forHTTPHeaderField: "Sec-WebSocket-Extensions")
        )
    }

    /// Set `T3_SWIFT_WS_DEFLATE_ECHO_URL` to a WebSocket endpoint that rejects
    /// non-deflate handshakes and echoes binary frames. This is intentionally
    /// opt-in because XCTest does not own a Node process. A successful round
    /// trip proves URLSession accepted the server's compressed frame.
    func testLivePerMessageDeflateRoundTripWhenConfigured() async throws {
        guard let value = ProcessInfo.processInfo.environment[
            "T3_SWIFT_WS_DEFLATE_ECHO_URL"
        ], let url = URL(string: value) else {
            throw XCTSkip("Set T3_SWIFT_WS_DEFLATE_ECHO_URL for live compression proof.")
        }
        let connection = try await URLSessionWebSocketConnector().connect(to: url)
        defer { Task { await connection.close() } }
        let payload = Data(repeating: 0x54, count: 64 * 1024)
        try await connection.send(payload)
        let echoed = try await connection.receive()
        XCTAssertEqual(echoed, payload)
    }

    func testPairingInputParsesClipboardQRHostedAndLooseFormats() throws {
        let direct = try PairingURL.parseFields(
            " https://studio.example:3773/pair#token=N735%4BQXJ "
        )
        XCTAssertEqual(direct.host, "https://studio.example:3773")
        XCTAssertEqual(direct.pairingCode, "N735KQXJ")

        let hosted = try PairingURL.parseFields(
            "https://app.t3.codes/pair?host=http%3A%2F%2F192.168.1.7%3A18773"
                + "&label=Big%20O#token=PAIRING"
        )
        XCTAssertEqual(hosted.host, "http://192.168.1.7:18773")
        XCTAssertEqual(hosted.pairingCode, "PAIRING")
        XCTAssertEqual(hosted.label, "Big O")

        let loose = try PairingURL.parseFields("192.168.1.7:18773 N735KQXJ5SJW")
        XCTAssertEqual(loose.host, "https://192.168.1.7:18773")
        XCTAssertEqual(loose.pairingCode, "N735KQXJ5SJW")

        let wrapped = try PairingURL.pairingURL(
            fromQRCode: "t3code://pair?pairingUrl=https%3A%2F%2Fstudio.example"
                + "%2Fpair%23token%3DQR-CODE"
        )
        XCTAssertEqual(wrapped, "https://studio.example/pair#token=QR-CODE")
        XCTAssertEqual(try PairingURL.parseFields(wrapped).pairingCode, "QR-CODE")
    }

    func testSplitPairingFieldsAcceptCompleteURLInHostField() throws {
        let target = try PairingURL.resolve(
            host: "http://192.168.1.7:18773/pair#token=FROM-URL",
            pairingCode: ""
        )
        XCTAssertEqual(target.credential, "FROM-URL")
        XCTAssertEqual(target.httpBaseURL.absoluteString, "http://192.168.1.7:18773/")
        XCTAssertEqual(target.webSocketBaseURL.absoluteString, "ws://192.168.1.7:18773/")
    }

    func testLocalNetworkProbeClassificationDistinguishesFailureModes() {
        XCTAssertTrue(LocalNetworkProbe.isLocalHost("192.168.20.4"))
        XCTAssertTrue(LocalNetworkProbe.isLocalHost("studio.local"))
        XCTAssertFalse(LocalNetworkProbe.isLocalHost("app.t3.codes"))

        let denied = NSError(
            domain: NSURLErrorDomain,
            code: URLError.notConnectedToInternet.rawValue,
            userInfo: [
                NSUnderlyingErrorKey: NSError(
                    domain: NSPOSIXErrorDomain,
                    code: 13
                ),
            ]
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(denied, host: "192.168.20.4", isLocal: true),
            .likelyLocalNetworkDenied("192.168.20.4")
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(
                URLError(.timedOut),
                host: "studio.local",
                isLocal: true
            ),
            .timeout("studio.local")
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(
                URLError(.cannotConnectToHost),
                host: "studio.local",
                isLocal: true
            ),
            .unavailableHost("studio.local")
        )
    }

}

private func transportResponse(
    _ request: URLRequest,
    status: Int = 200,
    headers: [String: String] = ["Content-Type": "application/json"]
) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: headers
    )!
}

private actor RecordingHTTPTransport: HTTPTransport {
    typealias Handler = @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)

    private(set) var requests: [URLRequest] = []
    private let handler: Handler

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return try handler(request)
    }
}
