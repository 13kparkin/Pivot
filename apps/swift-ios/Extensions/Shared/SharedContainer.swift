import Foundation

enum T3SharedContainer {
    static let appGroupID = "group.com.t3tools.t3code.swiftui"
    static let urlScheme = "t3code-swiftui"

    static var rootURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        )
    }
}
