import SwiftUI

@main
struct T3CodeApp: App {
    @State private var client = NativeFeatureClient()

    var body: some Scene {
        WindowGroup {
            RootView {
                FeatureRootView(client: client)
            }
        }
    }
}
