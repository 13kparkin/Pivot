import Foundation
import Testing
@testable import T3Code

@Suite("Message-first task creation")
struct DailyUXNewTaskTests {
    @Test
    func requestKeepsPromptModesAndImageBytesTogether() {
        let image = FeatureDraftAttachment(
            data: Data([1, 2, 3]),
            filename: "Image 1.jpg",
            mimeType: "image/jpeg"
        )
        let request = NewTaskRequest(
            projectID: "project",
            prompt: "  Build it  \n",
            selection: FeatureSelection(providerID: "codex", modelID: "gpt-5"),
            runtimeMode: .fullAccess,
            interactionMode: .plan,
            attachments: [image]
        )

        #expect(request.trimmedPrompt == "Build it")
        #expect(request.interactionMode == .plan)
        #expect(request.attachments.first?.byteCount == 3)
    }
}
