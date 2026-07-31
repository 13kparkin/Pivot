import Foundation

public struct FeatureConnection: Sendable, Equatable, Codable {
    public enum State: String, Sendable, Codable {
        case disconnected
        case connecting
        case connected
        case reconnecting
    }

    public var state: State
    public var environmentName: String?
    public var endpoint: String?
    public var detail: String?

    public init(
        state: State = .disconnected,
        environmentName: String? = nil,
        endpoint: String? = nil,
        detail: String? = nil
    ) {
        self.state = state
        self.environmentName = environmentName
        self.endpoint = endpoint
        self.detail = detail
    }
}

public struct FeatureEnvironment: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var endpoint: String
    public var isActive: Bool

    public init(id: String, name: String, endpoint: String, isActive: Bool = false) {
        self.id = id
        self.name = name
        self.endpoint = endpoint
        self.isActive = isActive
    }
}

public struct FeatureProject: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var environmentID: String
    public var name: String
    public var path: String
    public var threadCount: Int
    public var defaultSelection: FeatureSelection?

    public init(
        id: String,
        environmentID: String,
        name: String,
        path: String,
        threadCount: Int = 0,
        defaultSelection: FeatureSelection? = nil
    ) {
        self.id = id
        self.environmentID = environmentID
        self.name = name
        self.path = path
        self.threadCount = threadCount
        self.defaultSelection = defaultSelection
    }
}

public enum FeatureThreadState: String, Sendable, Codable {
    case idle
    case queued
    case working
    case waitingForApproval
    case waitingForInput
    case failed
    case completed
}

public enum FeatureRuntimeMode: String, CaseIterable, Sendable, Codable {
    case approvalRequired
    case autoAcceptEdits
    case automatic
    case fullAccess
}

public enum FeatureInteractionMode: String, CaseIterable, Sendable, Codable {
    case standard
    case plan
}

public struct FeatureThread: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var projectID: String
    public var environmentID: String?
    public var environmentName: String?
    public var title: String
    public var preview: String?
    public var branch: String?
    public var worktreePath: String?
    public var createdAt: Date
    public var updatedAt: Date
    public var state: FeatureThreadState
    public var providerID: String?
    public var providerName: String?
    public var modelID: String?
    public var modelOptions: [FeatureModelOptionSelection]
    public var isArchived: Bool
    public var isSettled: Bool
    public var keepsActive: Bool
    public var settledAt: Date?
    public var lastActivityAt: Date?
    public var snoozedUntil: Date?
    public var snoozedAt: Date?
    public var attentionAt: Date?
    public var workingStartedAt: Date?
    public var latestTurnCompletedAt: Date?
    public var runtimeMode: FeatureRuntimeMode
    public var interactionMode: FeatureInteractionMode

    public init(
        id: String,
        projectID: String,
        environmentID: String? = nil,
        environmentName: String? = nil,
        title: String,
        preview: String? = nil,
        branch: String? = nil,
        worktreePath: String? = nil,
        createdAt: Date = .now,
        updatedAt: Date = .now,
        state: FeatureThreadState = .idle,
        providerID: String? = nil,
        providerName: String? = nil,
        modelID: String? = nil,
        modelOptions: [FeatureModelOptionSelection] = [],
        isArchived: Bool = false,
        isSettled: Bool = false,
        keepsActive: Bool = false,
        settledAt: Date? = nil,
        lastActivityAt: Date? = nil,
        snoozedUntil: Date? = nil,
        snoozedAt: Date? = nil,
        attentionAt: Date? = nil,
        workingStartedAt: Date? = nil,
        latestTurnCompletedAt: Date? = nil,
        runtimeMode: FeatureRuntimeMode = .fullAccess,
        interactionMode: FeatureInteractionMode = .standard
    ) {
        self.id = id
        self.projectID = projectID
        self.environmentID = environmentID
        self.environmentName = environmentName
        self.title = title
        self.preview = preview
        self.branch = branch
        self.worktreePath = worktreePath
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.state = state
        self.providerID = providerID
        self.providerName = providerName
        self.modelID = modelID
        self.modelOptions = modelOptions
        self.isArchived = isArchived
        self.isSettled = isSettled
        self.keepsActive = keepsActive
        self.settledAt = settledAt
        self.lastActivityAt = lastActivityAt
        self.snoozedUntil = snoozedUntil
        self.snoozedAt = snoozedAt
        self.attentionAt = attentionAt
        self.workingStartedAt = workingStartedAt
        self.latestTurnCompletedAt = latestTurnCompletedAt
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
    }
}

public enum FeatureMessageRole: String, Sendable, Codable {
    case user
    case assistant
    case system
    case tool
}

public enum FeatureMessageState: String, Sendable, Codable {
    case queued
    case streaming
    case complete
    case failed
}

public struct FeatureMessageAttachment: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var mimeType: String
    public var sizeBytes: Int
    public var url: URL?

    public init(
        id: String,
        name: String,
        mimeType: String,
        sizeBytes: Int,
        url: URL? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.url = url
    }
}

public struct FeatureUploadAttachment: Sendable, Equatable {
    public var data: Data
    public var name: String
    public var mimeType: String

    public init(data: Data, name: String, mimeType: String) {
        self.data = data
        self.name = name
        self.mimeType = mimeType
    }
}

public struct FeatureMessage: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var role: FeatureMessageRole
    public var text: String
    public var createdAt: Date
    public var state: FeatureMessageState
    public var toolName: String?
    public var attachments: [FeatureMessageAttachment]

    public init(
        id: String,
        role: FeatureMessageRole,
        text: String,
        createdAt: Date = .now,
        state: FeatureMessageState = .complete,
        toolName: String? = nil,
        attachments: [FeatureMessageAttachment] = []
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.state = state
        self.toolName = toolName
        self.attachments = attachments
    }
}

public enum FeatureApprovalKind: String, Sendable, Codable {
    case command
    case fileRead
    case fileChange
    case patch
    case other
}

public struct FeatureApproval: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var threadID: String
    public var kind: FeatureApprovalKind
    public var title: String
    public var detail: String

    public init(id: String, threadID: String, kind: FeatureApprovalKind, title: String, detail: String) {
        self.id = id
        self.threadID = threadID
        self.kind = kind
        self.title = title
        self.detail = detail
    }
}

public struct FeatureInputOption: Sendable, Equatable, Hashable, Codable {
    public var label: String
    public var detail: String

    public init(label: String, detail: String) {
        self.label = label
        self.detail = detail
    }
}

public struct FeatureInputQuestion: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var header: String
    public var question: String
    public var options: [FeatureInputOption]
    public var allowsMultiple: Bool

    public init(
        id: String,
        header: String,
        question: String,
        options: [FeatureInputOption] = [],
        allowsMultiple: Bool = false
    ) {
        self.id = id
        self.header = header
        self.question = question
        self.options = options
        self.allowsMultiple = allowsMultiple
    }
}

public struct FeatureUserInput: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var threadID: String
    public var questions: [FeatureInputQuestion]

    public init(id: String, threadID: String, questions: [FeatureInputQuestion]) {
        self.id = id
        self.threadID = threadID
        self.questions = questions
    }
}

public struct FeatureThreadDetail: Sendable, Equatable, Codable {
    public var thread: FeatureThread
    public var messages: [FeatureMessage]
    public var approvals: [FeatureApproval]
    public var userInputs: [FeatureUserInput]

    public init(
        thread: FeatureThread,
        messages: [FeatureMessage] = [],
        approvals: [FeatureApproval] = [],
        userInputs: [FeatureUserInput] = []
    ) {
        self.thread = thread
        self.messages = messages
        self.approvals = approvals
        self.userInputs = userInputs
    }
}

public struct FeatureModel: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var detail: String?
    public var supportsImages: Bool
    public var supportsReasoning: Bool
    public var isDefault: Bool
    public var options: [FeatureModelOptionDescriptor]

    public init(
        id: String,
        name: String,
        detail: String? = nil,
        supportsImages: Bool = false,
        supportsReasoning: Bool = false,
        isDefault: Bool = false,
        options: [FeatureModelOptionDescriptor] = []
    ) {
        self.id = id
        self.name = name
        self.detail = detail
        self.supportsImages = supportsImages
        self.supportsReasoning = supportsReasoning
        self.isDefault = isDefault
        self.options = options
    }
}

public enum FeatureModelOptionKind: String, Sendable, Equatable, Hashable, Codable {
    case select
    case boolean
}

public struct FeatureModelOptionChoice: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var label: String
    public var detail: String?
    public var isDefault: Bool

    public init(
        id: String,
        label: String,
        detail: String? = nil,
        isDefault: Bool = false
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.isDefault = isDefault
    }
}

public struct FeatureModelOptionDescriptor: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var label: String
    public var detail: String?
    public var kind: FeatureModelOptionKind
    public var choices: [FeatureModelOptionChoice]
    public var defaultValue: FeatureModelOptionValue?

    public init(
        id: String,
        label: String,
        detail: String? = nil,
        kind: FeatureModelOptionKind,
        choices: [FeatureModelOptionChoice] = [],
        defaultValue: FeatureModelOptionValue? = nil
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.kind = kind
        self.choices = choices
        self.defaultValue = defaultValue
    }
}

public enum FeatureModelOptionValue: Sendable, Equatable, Hashable, Codable {
    case string(String)
    case boolean(Bool)

    private enum CodingKeys: String, CodingKey {
        case type
        case value
    }

    private enum ValueType: String, Codable {
        case string
        case boolean
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(ValueType.self, forKey: .type) {
        case .string:
            self = try .string(container.decode(String.self, forKey: .value))
        case .boolean:
            self = try .boolean(container.decode(Bool.self, forKey: .value))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .string(value):
            try container.encode(ValueType.string, forKey: .type)
            try container.encode(value, forKey: .value)
        case let .boolean(value):
            try container.encode(ValueType.boolean, forKey: .type)
            try container.encode(value, forKey: .value)
        }
    }
}

public struct FeatureModelOptionSelection: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var value: FeatureModelOptionValue

    public init(id: String, value: FeatureModelOptionValue) {
        self.id = id
        self.value = value
    }
}

public struct FeatureProvider: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var isAvailable: Bool
    public var driver: String
    public var requiresNewThreadForModelChange: Bool
    public var models: [FeatureModel]

    public init(
        id: String,
        name: String,
        isAvailable: Bool = true,
        driver: String = "",
        requiresNewThreadForModelChange: Bool = false,
        models: [FeatureModel] = []
    ) {
        self.id = id
        self.name = name
        self.isAvailable = isAvailable
        self.driver = driver
        self.requiresNewThreadForModelChange = requiresNewThreadForModelChange
        self.models = models
    }
}

public struct FeatureSelection: Sendable, Equatable, Hashable, Codable {
    public var providerID: String
    public var modelID: String
    public var options: [FeatureModelOptionSelection]

    public init(
        providerID: String,
        modelID: String,
        options: [FeatureModelOptionSelection] = []
    ) {
        self.providerID = providerID
        self.modelID = modelID
        self.options = options
    }
}

public enum FeatureAppearance: String, CaseIterable, Sendable, Codable {
    case system
    case dark
}

public struct FeatureSettings: Sendable, Equatable, Codable {
    public var appearance: FeatureAppearance
    public var hapticsEnabled: Bool
    public var notificationsEnabled: Bool
    public var defaultSelection: FeatureSelection?

    public init(
        appearance: FeatureAppearance = .dark,
        hapticsEnabled: Bool = true,
        notificationsEnabled: Bool = true,
        defaultSelection: FeatureSelection? = nil
    ) {
        self.appearance = appearance
        self.hapticsEnabled = hapticsEnabled
        self.notificationsEnabled = notificationsEnabled
        self.defaultSelection = defaultSelection
    }
}

public struct FeatureSnapshot: Sendable, Equatable, Codable {
    public var connection: FeatureConnection
    public var environments: [FeatureEnvironment]
    public var projects: [FeatureProject]
    public var threads: [FeatureThread]
    public var providers: [FeatureProvider]
    public var settings: FeatureSettings

    public init(
        connection: FeatureConnection = .init(),
        environments: [FeatureEnvironment] = [],
        projects: [FeatureProject] = [],
        threads: [FeatureThread] = [],
        providers: [FeatureProvider] = [],
        settings: FeatureSettings = .init()
    ) {
        self.connection = connection
        self.environments = environments
        self.projects = projects
        self.threads = threads
        self.providers = providers
        self.settings = settings
    }
}

public enum FeatureApprovalDecision: String, Sendable, Codable {
    case allowOnce
    case allowForSession
    case deny
}

public enum FeatureEvent: Sendable {
    case snapshot(FeatureSnapshot)
    case connection(FeatureConnection)
    case thread(FeatureThread)
    case threadRemoved(id: String)
    case detail(FeatureThreadDetail)
    case failure(String)
}
