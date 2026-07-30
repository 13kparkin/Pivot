import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct FeatureImageAttachmentPicker: View {
    @Binding var attachments: [FeatureDraftAttachment]
    let maximumCount: Int
    let isEnabled: Bool

    @State private var selection: [PhotosPickerItem] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    init(
        attachments: Binding<[FeatureDraftAttachment]>,
        maximumCount: Int = 8,
        isEnabled: Bool = true
    ) {
        _attachments = attachments
        self.maximumCount = maximumCount
        self.isEnabled = isEnabled
    }

    var body: some View {
        PhotosPicker(
            selection: $selection,
            maxSelectionCount: max(1, maximumCount - attachments.count),
            matching: .images
        ) {
            Image(systemName: isLoading ? "ellipsis" : "photo")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .disabled(!isEnabled || isLoading || attachments.count >= maximumCount)
        .opacity(isEnabled ? 1 : 0.3)
        .accessibilityLabel(isLoading ? "Adding images" : "Add images")
        .accessibilityHint(isEnabled ? "" : "The selected model does not accept images")
        .onChange(of: selection) {
            loadSelection()
        }
        .alert(
            "Couldn’t add image",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func loadSelection() {
        let items = selection
        guard !items.isEmpty else { return }
        selection = []
        isLoading = true

        Task {
            defer { isLoading = false }
            for item in items.prefix(maximumCount - attachments.count) {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        continue
                    }
                    let type = item.supportedContentTypes.first ?? .jpeg
                    let attachment = try FeatureImageProcessor.attachment(
                        from: data,
                        sourceType: type,
                        ordinal: attachments.count + 1
                    )
                    attachments.append(attachment)
                } catch {
                    errorMessage = error.localizedDescription
                    break
                }
            }
        }
    }
}

struct FeatureAttachmentStrip: View {
    @Binding var attachments: [FeatureDraftAttachment]

    var body: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        FeatureAttachmentThumbnail(attachment: attachment) {
                            attachments.removeAll { $0.id == attachment.id }
                        }
                    }
                }
                .padding(.horizontal, 1)
            }
            .scrollIndicators(.hidden)
            .accessibilityLabel("\(attachments.count) image attachments")
        }
    }
}

private struct FeatureAttachmentThumbnail: View {
    let attachment: FeatureDraftAttachment
    let onRemove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image = UIImage(data: attachment.data) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: "photo")
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            .frame(width: 66, height: 66)
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 9))

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(.black.opacity(0.78), in: Circle())
            }
            .offset(x: 5, y: -5)
            .accessibilityLabel("Remove \(attachment.filename)")
        }
        .padding(.top, 5)
        .padding(.trailing, 5)
    }
}

enum FeatureImageProcessor {
    private static let maximumDimension: CGFloat = 2_048
    private static let maximumEncodedBytes = 10 * 1_024 * 1_024

    static func attachment(
        from sourceData: Data,
        sourceType _: UTType,
        ordinal: Int
    ) throws -> FeatureDraftAttachment {
        guard let sourceImage = UIImage(data: sourceData) else {
            throw FeatureImageAttachmentError.invalidImage
        }

        let image = resized(sourceImage)
        guard let data = image.jpegData(compressionQuality: 0.82) else {
            throw FeatureImageAttachmentError.encodingFailed
        }
        guard data.count <= maximumEncodedBytes else {
            throw FeatureImageAttachmentError.tooLarge
        }

        return FeatureDraftAttachment(
            data: data,
            filename: "Image \(ordinal).jpg",
            mimeType: "image/jpeg"
        )
    }

    private static func resized(_ image: UIImage) -> UIImage {
        let longestSide = max(image.size.width, image.size.height)
        guard longestSide > maximumDimension else { return image }
        let scale = maximumDimension / longestSide
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }
}

enum FeatureImageAttachmentError: LocalizedError {
    case invalidImage
    case encodingFailed
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            "That photo could not be read."
        case .encodingFailed:
            "That photo could not be prepared."
        case .tooLarge:
            "Images must be smaller than 10 MB."
        }
    }
}
