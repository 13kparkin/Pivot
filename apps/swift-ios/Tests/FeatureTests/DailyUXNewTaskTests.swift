import Foundation
import Testing
import UIKit
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

    @Test @MainActor
    func imageProcessorDownsamplesUploadAndBuildsSmallThumbnail() throws {
        let source = UIGraphicsImageRenderer(size: CGSize(width: 2_400, height: 1_200))
            .image { context in
                UIColor.systemPink.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 2_400, height: 1_200))
            }
        let sourceData = try #require(source.pngData())

        let attachment = try FeatureImageProcessor.attachment(
            from: sourceData,
            ordinal: 1
        )
        let prepared = try #require(UIImage(data: attachment.data))
        let thumbnail = try #require(
            attachment.thumbnailData.flatMap(UIImage.init(data:))
        )

        #expect(max(prepared.size.width, prepared.size.height) <= 2_048)
        #expect(max(thumbnail.size.width, thumbnail.size.height) <= 160)
        #expect(attachment.mimeType == "image/jpeg")
    }
}
