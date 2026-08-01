import SwiftUI

@main
@MainActor
struct T3CodeApp: App {
    @UIApplicationDelegateAdaptor(T3PlatformAppDelegate.self) private var appDelegate
    @State private var model: FeatureRootModel

    init() {
        let client = NativeFeatureClient()
        _model = State(initialValue: FeatureRootModel(client: client))
    }

    var body: some Scene {
        WindowGroup {
            RootView {
                PlatformRootView(model: model)
            }
        }
    }
}
