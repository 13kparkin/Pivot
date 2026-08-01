import Foundation

public struct FeatureComposerDraft: Sendable, Equatable {
    public var text: String
    public var attachments: [FeatureDraftAttachment]
    public var selection: FeatureSelection?

    public init(
        text: String = "",
        attachments: [FeatureDraftAttachment] = [],
        selection: FeatureSelection? = nil
    ) {
        self.text = text
        self.attachments = attachments
        self.selection = selection
    }

    public var isEmpty: Bool {
        text.isEmpty && attachments.isEmpty && selection == nil
    }
}

/// Persists composer state independently of view navigation. Draft writes are
/// atomic, and callers debounce high-frequency text changes before reaching
/// this actor so image data is not repeatedly encoded for every keystroke.
public actor FeatureComposerDraftStore {
    public static let shared = FeatureComposerDraftStore()

    private struct Document: Codable {
        let version: Int
        var drafts: [String: PersistedDraft]
    }

    private struct PersistedDraft: Codable {
        var text: String
        var attachments: [PersistedAttachment]
        var selection: FeatureSelection?

        init(_ draft: FeatureComposerDraft) {
            text = draft.text
            attachments = draft.attachments.map(PersistedAttachment.init)
            selection = draft.selection
        }

        var featureValue: FeatureComposerDraft {
            FeatureComposerDraft(
                text: text,
                attachments: attachments.map(\.featureValue),
                selection: selection
            )
        }
    }

    private struct PersistedAttachment: Codable {
        var id: UUID
        var data: Data
        var thumbnailData: Data?
        var filename: String
        var mimeType: String

        init(_ attachment: FeatureDraftAttachment) {
            id = attachment.id
            data = attachment.data
            thumbnailData = attachment.thumbnailData
            filename = attachment.filename
            mimeType = attachment.mimeType
        }

        var featureValue: FeatureDraftAttachment {
            FeatureDraftAttachment(
                id: id,
                data: data,
                thumbnailData: thumbnailData,
                filename: filename,
                mimeType: mimeType
            )
        }
    }

    public let fileURL: URL
    private var loadedDrafts: [String: PersistedDraft]?

    public init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let root = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            self.fileURL = root
                .appendingPathComponent("T3CodeSwift", isDirectory: true)
                .appendingPathComponent("composer-drafts.json", isDirectory: false)
        }
    }

    public func draft(for key: String) throws -> FeatureComposerDraft? {
        try loadIfNeeded()[key]?.featureValue
    }

    public func setDraft(_ draft: FeatureComposerDraft, for key: String) throws {
        var drafts = try loadIfNeeded()
        if draft.isEmpty {
            drafts.removeValue(forKey: key)
        } else {
            drafts[key] = PersistedDraft(draft)
        }
        try persist(drafts)
        loadedDrafts = drafts
    }

    public func removeDraft(for key: String) throws {
        var drafts = try loadIfNeeded()
        guard drafts.removeValue(forKey: key) != nil else { return }
        try persist(drafts)
        loadedDrafts = drafts
    }

    public func removeDrafts(environmentID: String) throws {
        var drafts = try loadIfNeeded()
        let environmentPrefix = "environment:\(environmentID):"
        drafts = drafts.filter { !$0.key.hasPrefix(environmentPrefix) }
        try persist(drafts)
        loadedDrafts = drafts
    }

    public static func threadKey(_ thread: FeatureThread) -> String {
        let environment = thread.environmentID ?? "active"
        let threadID = thread.wireID ?? thread.id
        return "environment:\(environment):thread:\(threadID)"
    }

    public static func newTaskKey(project: FeatureProject) -> String {
        let projectID = project.wireID ?? project.id
        return "environment:\(project.environmentID):new-task:\(projectID)"
    }

    private func loadIfNeeded() throws -> [String: PersistedDraft] {
        if let loadedDrafts { return loadedDrafts }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            let drafts: [String: PersistedDraft] = [:]
            loadedDrafts = drafts
            return drafts
        }
        let data = try Data(contentsOf: fileURL)
        let document = try JSONDecoder.t3.decode(Document.self, from: data)
        guard document.version == 1 else {
            throw CocoaError(.fileReadCorruptFile)
        }
        loadedDrafts = document.drafts
        return document.drafts
    }

    private func persist(_ drafts: [String: PersistedDraft]) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let document = Document(version: 1, drafts: drafts)
        try JSONEncoder.t3.encode(document).write(to: fileURL, options: .atomic)
    }
}
