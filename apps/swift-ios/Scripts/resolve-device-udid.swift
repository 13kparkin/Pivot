import Foundation

private struct DeviceList: Decodable {
    struct Result: Decodable {
        struct Device: Decodable {
            struct HardwareProperties: Decodable {
                let udid: String
            }

            let identifier: String
            let hardwareProperties: HardwareProperties
        }

        let devices: [Device]
    }

    let result: Result
}

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: resolve-device-udid <devices.json> <identifier>\n".utf8))
    exit(64)
}

do {
    let payload = try JSONDecoder().decode(
        DeviceList.self,
        from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    )
    let requested = CommandLine.arguments[2]
    guard let device = payload.result.devices.first(where: {
        $0.identifier.caseInsensitiveCompare(requested) == .orderedSame
            || $0.hardwareProperties.udid.caseInsensitiveCompare(requested) == .orderedSame
    }) else {
        throw CocoaError(.fileNoSuchFile)
    }
    print(device.hardwareProperties.udid)
} catch {
    FileHandle.standardError.write(
        Data("Could not resolve that device identifier: \(error.localizedDescription)\n".utf8)
    )
    exit(1)
}
