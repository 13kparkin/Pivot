import Foundation
import Testing
import UIKit
@testable import T3Code

@Suite("Message-first task creation")
struct DailyUXNewTaskTests {
    @Test
    func requestNormalizesLegacyModesAndKeepsImageBytes() {
        let image = FeatureDraftAttachment(
            data: Data([1, 2, 3]),
            filename: "Image 1.jpg",
            mimeType: "image/jpeg"
        )
        let request = NewTaskRequest(
            projectID: "project",
            prompt: "  Build it  \n",
            selection: FeatureSelection(providerID: "codex", modelID: "gpt-5"),
            runtimeMode: .approvalRequired,
            interactionMode: .plan,
            attachments: [image]
        )

        #expect(request.trimmedPrompt == "Build it")
        #expect(request.runtimeMode == .automatic)
        #expect(request.interactionMode == .standard)
        #expect(request.attachments.first?.byteCount == 3)
    }

    @Test
    func mobileModeChoicesOnlyExposeSupportedValues() {
        #expect(FeatureRuntimeMode.allCases == [.automatic, .fullAccess])
        #expect(FeatureInteractionMode.allCases == [.standard])
    }

    @Test
    func passiveProjectsKeepTheirOwnModelCatalogAndDefault() throws {
        let passiveDefault = FeatureSelection(
            providerID: "claudeAgent",
            modelID: "claude-opus-4-1"
        )
        let activeProject = FeatureProject(
            id: "active-project",
            environmentID: "active",
            name: "Active",
            path: "/active"
        )
        let passiveProject = FeatureProject(
            id: "passive-project",
            environmentID: "passive",
            name: "Passive",
            path: "/passive",
            defaultSelection: passiveDefault
        )
        let snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "active",
                    name: "Active",
                    endpoint: "https://active.example",
                    isActive: true,
                    connectionState: .connected
                ),
                .init(
                    id: "passive",
                    name: "Passive",
                    endpoint: "https://passive.example",
                    connectionState: .connected
                ),
                .init(
                    id: "offline",
                    name: "Offline",
                    endpoint: "https://offline.example",
                    connectionState: .disconnected
                ),
            ],
            projects: [
                activeProject,
                passiveProject,
                .init(
                    id: "offline-project",
                    environmentID: "offline",
                    name: "Offline",
                    path: "/offline"
                ),
            ],
            providers: [
                .init(
                    id: "codex",
                    name: "Codex",
                    models: [.init(id: "gpt-5.6-sol", name: "GPT-5.6")]
                ),
            ]
        )

        #expect(
            DailyUXCreationContext.projects(in: snapshot).map(\.id)
                == ["active-project", "passive-project"]
        )
        let passiveProviders = DailyUXCreationContext.providers(
            for: passiveProject,
            in: snapshot
        )
        #expect(passiveProviders.map(\.id) == ["claudeAgent"])
        #expect(passiveProviders.first?.models.map(\.id) == ["claude-opus-4-1"])
        #expect(
            DailyUXCreationContext.initialSelection(for: passiveProject, in: snapshot)
                == passiveDefault
        )
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
