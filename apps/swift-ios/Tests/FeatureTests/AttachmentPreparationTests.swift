import Foundation
import Testing
import UniformTypeIdentifiers
import UIKit
@testable import T3Code

@Suite("Attachment preparation")
struct AttachmentPreparationTests {
    @Test
    func overlappingPreparationOnlyFinishesAfterEveryOperation() {
        var state = FeatureAttachmentPreparationState()
        let firstID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let secondID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let first = state.begin(itemCount: 2, id: firstID)
        let second = state.begin(itemCount: 1, id: secondID)

        #expect(state.isPreparing)
        #expect(state.pendingItemCount == 3)
        #expect(state.statusLabel == "Preparing 3 images…")

        state.finish(first)

        #expect(state.isPreparing)
        #expect(state.pendingItemCount == 1)
        #expect(state.statusLabel == "Preparing image…")

        state.finish(second)

        #expect(!state.isPreparing)
        #expect(state.pendingItemCount == 0)
    }

    @Test
    func textOnlySubmissionWaitsForSelectedImagePreparation() {
        var state = FeatureAttachmentPreparationState()
        let operation = state.begin(itemCount: 1)

        #expect(!FeatureComposerSubmissionEligibility.canSend(
            text: "Explain this screenshot",
            attachmentCount: 0,
            imagesAllowed: true,
            isSending: false,
            preparationState: state
        ))

        state.finish(operation)

        #expect(FeatureComposerSubmissionEligibility.canSend(
            text: "Explain this screenshot",
            attachmentCount: 1,
            imagesAllowed: true,
            isSending: false,
            preparationState: state
        ))
    }

    @Test
    func attachmentSubmissionStillRequiresImageCapableModel() {
        let state = FeatureAttachmentPreparationState()

        #expect(!FeatureComposerSubmissionEligibility.canSend(
            text: "",
            attachmentCount: 1,
            imagesAllowed: false,
            isSending: false,
            preparationState: state
        ))
        #expect(FeatureComposerSubmissionEligibility.canSend(
            text: "Text still works",
            attachmentCount: 0,
            imagesAllowed: false,
            isSending: false,
            preparationState: state
        ))
    }

    @Test
    func photoLibraryItemLoadsItsConcreteImageRepresentation() async throws {
        let expected = Data([0x89, 0x50, 0x4E, 0x47])
        let provider = NSItemProvider()
        provider.registerDataRepresentation(
            forTypeIdentifier: UTType.png.identifier,
            visibility: .all
        ) { completion in
            completion(expected, nil)
            return nil
        }

        let loaded = try await FeaturePhotoLibraryItem(provider: provider).loadData()

        #expect(loaded == expected)
    }

    @Test
    func photoLibraryItemRejectsProvidersWithoutAnImage() async {
        let provider = NSItemProvider(
            item: "not an image" as NSString,
            typeIdentifier: UTType.plainText.identifier
        )

        do {
            _ = try await FeaturePhotoLibraryItem(provider: provider).loadData()
            Issue.record("Expected a non-image provider to be rejected")
        } catch FeatureImageAttachmentError.invalidImage {
            // Expected.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }
}
