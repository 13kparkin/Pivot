import Foundation

public struct FeatureCapabilityUnavailable: LocalizedError, Sendable, Equatable {
    public let capability: String

    public init(_ capability: String) {
        self.capability = capability
    }

    public var errorDescription: String? {
        "\(capability) is not supported by this environment."
    }
}

public enum FeatureFileKind: String, Sendable, Codable {
    case file
    case directory
    case symbolicLink
}

public struct FeatureFileEntry: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String { path }
    public let path: String
    public var name: String
    public var kind: FeatureFileKind
    public var sizeBytes: Int?
    public var isHidden: Bool

    public init(
        path: String,
        name: String,
        kind: FeatureFileKind,
        sizeBytes: Int? = nil,
        isHidden: Bool = false
    ) {
        self.path = path
        self.name = name
        self.kind = kind
        self.sizeBytes = sizeBytes
        self.isHidden = isHidden
    }
}

public extension Array where Element == FeatureFileEntry {
    func featureFiltered(by query: String, includesHidden: Bool) -> [FeatureFileEntry] {
        let visible = includesHidden ? self : filter { !$0.isHidden }
        let filtered: [FeatureFileEntry]
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            filtered = visible
        } else {
            filtered = visible.filter { $0.name.localizedCaseInsensitiveContains(query) }
        }
        return filtered.sorted {
            if $0.kind == .directory, $1.kind != .directory { return true }
            if $0.kind != .directory, $1.kind == .directory { return false }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
}

public struct FeatureFileContent: Sendable, Equatable, Codable {
    public var path: String
    public var text: String
    public var language: String?
    public var isTruncated: Bool
    public var totalBytes: Int?

    public init(
        path: String,
        text: String,
        language: String? = nil,
        isTruncated: Bool = false,
        totalBytes: Int? = nil
    ) {
        self.path = path
        self.text = text
        self.language = language
        self.isTruncated = isTruncated
        self.totalBytes = totalBytes
    }
}

public enum FeatureDiffLineKind: String, Sendable, Codable {
    case context
    case addition
    case deletion
    case hunk
}

public struct FeatureDiffLine: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var kind: FeatureDiffLineKind
    public var oldLine: Int?
    public var newLine: Int?
    public var text: String

    public init(
        id: String,
        kind: FeatureDiffLineKind,
        oldLine: Int? = nil,
        newLine: Int? = nil,
        text: String
    ) {
        self.id = id
        self.kind = kind
        self.oldLine = oldLine
        self.newLine = newLine
        self.text = text
    }
}

public enum FeatureReviewChangeKind: String, Sendable, Codable {
    case added
    case modified
    case deleted
    case renamed
    case binary
}

public struct FeatureReviewFile: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String { path }
    public var path: String
    public var previousPath: String?
    public var change: FeatureReviewChangeKind
    public var additions: Int
    public var deletions: Int
    public var lines: [FeatureDiffLine]

    public init(
        path: String,
        previousPath: String? = nil,
        change: FeatureReviewChangeKind,
        additions: Int,
        deletions: Int,
        lines: [FeatureDiffLine] = []
    ) {
        self.path = path
        self.previousPath = previousPath
        self.change = change
        self.additions = additions
        self.deletions = deletions
        self.lines = lines
    }
}

public struct FeatureReview: Sendable, Equatable, Codable {
    public var title: String
    public var baseReference: String?
    public var files: [FeatureReviewFile]
    public var isTruncated: Bool

    public init(
        title: String = "Working tree",
        baseReference: String? = nil,
        files: [FeatureReviewFile] = [],
        isTruncated: Bool = false
    ) {
        self.title = title
        self.baseReference = baseReference
        self.files = files
        self.isTruncated = isTruncated
    }

    public var additions: Int { files.reduce(0) { $0 + $1.additions } }
    public var deletions: Int { files.reduce(0) { $0 + $1.deletions } }
}

public enum FeatureSourceControlFileState: String, Sendable, Codable {
    case added
    case modified
    case deleted
    case renamed
    case untracked
    case conflicted
}

public struct FeatureSourceControlFile: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String { path }
    public var path: String
    public var state: FeatureSourceControlFileState
    public var isStaged: Bool

    public init(path: String, state: FeatureSourceControlFileState, isStaged: Bool) {
        self.path = path
        self.state = state
        self.isStaged = isStaged
    }
}

public struct FeaturePullRequest: Sendable, Equatable, Hashable, Codable {
    public var number: Int
    public var title: String
    public var state: String
    public var url: URL?

    public init(number: Int, title: String, state: String, url: URL? = nil) {
        self.number = number
        self.title = title
        self.state = state
        self.url = url
    }
}

public enum FeatureSourceControlAction: String, CaseIterable, Sendable, Codable {
    case commit
    case push
    case pull
    case createPullRequest
    case commitAndPush
    case commitPushAndCreatePullRequest
}

public struct FeatureSourceControlStatus: Sendable, Equatable, Codable {
    public var isRepository: Bool
    public var branch: String?
    public var upstream: String?
    public var aheadCount: Int
    public var behindCount: Int
    public var files: [FeatureSourceControlFile]
    public var pullRequest: FeaturePullRequest?
    public var isBusy: Bool

    public init(
        isRepository: Bool = true,
        branch: String? = nil,
        upstream: String? = nil,
        aheadCount: Int = 0,
        behindCount: Int = 0,
        files: [FeatureSourceControlFile] = [],
        pullRequest: FeaturePullRequest? = nil,
        isBusy: Bool = false
    ) {
        self.isRepository = isRepository
        self.branch = branch
        self.upstream = upstream
        self.aheadCount = aheadCount
        self.behindCount = behindCount
        self.files = files
        self.pullRequest = pullRequest
        self.isBusy = isBusy
    }

    public var availableActions: [FeatureSourceControlAction] {
        guard isRepository, !isBusy else { return [] }
        var actions: [FeatureSourceControlAction] = []
        if !files.isEmpty {
            actions.append(.commit)
            actions.append(.commitAndPush)
            if pullRequest == nil {
                actions.append(.commitPushAndCreatePullRequest)
            }
        }
        if aheadCount > 0 { actions.append(.push) }
        if behindCount > 0 { actions.append(.pull) }
        if pullRequest == nil { actions.append(.createPullRequest) }
        return actions
    }
}

public enum FeatureTerminalState: String, Sendable, Codable {
    case stopped
    case starting
    case running
    case exited
    case failed
}

public struct FeatureTerminalSnapshot: Sendable, Equatable, Codable {
    public var threadID: String
    public var state: FeatureTerminalState
    public var title: String
    public var workingDirectory: String?
    public var buffer: String
    public var exitCode: Int?
    public var error: String?

    public init(
        threadID: String,
        state: FeatureTerminalState = .stopped,
        title: String = "Terminal",
        workingDirectory: String? = nil,
        buffer: String = "",
        exitCode: Int? = nil,
        error: String? = nil
    ) {
        self.threadID = threadID
        self.state = state
        self.title = title
        self.workingDirectory = workingDirectory
        self.buffer = buffer
        self.exitCode = exitCode
        self.error = error
    }
}
