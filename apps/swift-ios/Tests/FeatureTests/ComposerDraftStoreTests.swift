import Foundation
import Testing
@testable import T3Code

@Suite("Composer draft persistence")
struct ComposerDraftStoreTests {
    @Test func roundTripsThreadTextImagesAndSelection() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(fileURL: fileURL)
        let attachment = FeatureDraftAttachment(
            data: Data([0x01, 0x02, 0x03]),
            thumbnailData: Data([0x04]),
            filename: "reference.png",
            mimeType: "image/png"
        )
        let draft = FeatureComposerDraft(
            text: "Keep this work",
            attachments: [attachment],
            selection: FeatureSelection(providerID: "openai", modelID: "gpt-5.6")
        )

        try await store.setDraft(draft, for: "environment:test:thread:one")

        let reloaded = FeatureComposerDraftStore(fileURL: fileURL)
        #expect(try await reloaded.draft(for: "environment:test:thread:one") == draft)
    }

    @Test func emptyDraftRemovesPersistedEntry() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(fileURL: fileURL)
        let key = "environment:test:thread:one"

        try await store.setDraft(FeatureComposerDraft(text: "hello"), for: key)
        try await store.setDraft(FeatureComposerDraft(), for: key)

        #expect(try await store.draft(for: key) == nil)
    }

    @Test func environmentRemovalLeavesOtherDraftsAlone() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        try await store.setDraft(
            FeatureComposerDraft(text: "remove"),
            for: "environment:first:thread:one"
        )
        try await store.setDraft(
            FeatureComposerDraft(text: "keep"),
            for: "environment:second:new-task:two"
        )

        try await store.removeDrafts(environmentID: "first")

        #expect(try await store.draft(for: "environment:first:thread:one") == nil)
        #expect(
            try await store.draft(for: "environment:second:new-task:two")?.text == "keep"
        )
    }
}
