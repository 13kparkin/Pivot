import Foundation
import UniformTypeIdentifiers

struct T3LoadedSharePayload: Sendable {
    var textFragments: [String]
    var images: [T3PendingShareImage]
}

enum T3SharePayloadLoader {
    static func load(from inputItems: [Any]) async -> T3LoadedSharePayload {
        var textFragments: [String] = []
        var images: [T3PendingShareImage] = []

        for case let item as NSExtensionItem in inputItems {
            if let attributedText = item.attributedContentText?.string {
                textFragments.append(attributedText)
            }

            for provider in item.attachments ?? [] {
                if images.count < T3IncomingShareStore.maximumImageCount,
                   let imageType = provider.registeredTypeIdentifiers.first(where: {
                       UTType($0)?.conforms(to: .image) == true
                   }),
                   let data = try? await loadData(from: provider, typeIdentifier: imageType)
                {
                    images.append(
                        T3PendingShareImage(
                            data: data,
                            suggestedName: provider.suggestedName,
                            typeIdentifier: imageType
                        )
                    )
                    continue
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let value = try? await loadItem(
                       from: provider,
                       typeIdentifier: UTType.url.identifier
                   ),
                   let urlText = urlString(from: value)
                {
                    textFragments.append(urlText)
                    continue
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let value = try? await loadItem(
                       from: provider,
                       typeIdentifier: UTType.plainText.identifier
                   ),
                   let text = textString(from: value)
                {
                    textFragments.append(text)
                }
            }
        }

        return T3LoadedSharePayload(textFragments: textFragments, images: images)
    }

    private static func loadData(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, error in
                if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    private static func loadItem(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier) { value, error in
                if let value {
                    continuation.resume(returning: value)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    private static func urlString(from value: NSSecureCoding) -> String? {
        if let url = value as? URL {
            return url.absoluteString
        }
        if let text = value as? String, URL(string: text) != nil {
            return text
        }
        return nil
    }

    private static func textString(from value: NSSecureCoding) -> String? {
        if let text = value as? String {
            return text
        }
        if let attributedText = value as? NSAttributedString {
            return attributedText.string
        }
        return nil
    }
}
