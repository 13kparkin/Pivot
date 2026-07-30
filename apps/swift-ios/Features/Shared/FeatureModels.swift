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

    public init(id: String, environmentID: String, name: String, path: String, threadCount: Int = 0) {
        self.id = id
        self.environmentID = environmentID
        self.name = name
        self.path = path
        self.threadCount = threadCount
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
    public var title: String
    public var preview: String?
    public var updatedAt: Date
    public var state: FeatureThreadState
    public var providerID: String?
    public var modelID: String?
    public var isArchived: Bool
    public var isSettled: Bool
    public var snoozedUntil: Date?
    public var runtimeMode: FeatureRuntimeMode
    public var interactionMode: FeatureInteractionMode

    public init(
        id: String,
        projectID: String,
        title: String,
        preview: String? = nil,
        updatedAt: Date = .now,
        state: FeatureThreadState = .idle,
        providerID: String? = nil,
        modelID: String? = nil,
        isArchived: Bool = false,
        isSettled: Bool = false,
        snoozedUntil: Date? = nil,
        runtimeMode: FeatureRuntimeMode = .fullAccess,
        interactionMode: FeatureInteractionMode = .standard
    ) {
        self.id = id
        self.projectID = projectID
        self.title = title
        self.preview = preview
        self.updatedAt = updatedAt
        self.state = state
        self.providerID = providerID
        self.modelID = modelID
        self.isArchived = isArchived
        self.isSettled = isSettled
        self.snoozedUntil = snoozedUntil
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

public struct FeatureMessage: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var role: FeatureMessageRole
    public var text: String
    public var createdAt: Date
    public var state: FeatureMessageState
    public var toolName: String?

    public init(
        id: String,
        role: FeatureMessageRole,
        text: String,
        createdAt: Date = .now,
        state: FeatureMessageState = .complete,
        toolName: String? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.state = state
        self.toolName = toolName
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

    public init(
        id: String,
        name: String,
        detail: String? = nil,
        supportsImages: Bool = false,
        supportsReasoning: Bool = false
    ) {
        self.id = id
        self.name = name
        self.detail = detail
        self.supportsImages = supportsImages
        self.supportsReasoning = supportsReasoning
    }
}

public struct FeatureProvider: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var isAvailable: Bool
    public var models: [FeatureModel]

    public init(id: String, name: String, isAvailable: Bool = true, models: [FeatureModel] = []) {
        self.id = id
        self.name = name
        self.isAvailable = isAvailable
        self.models = models
    }
}

public struct FeatureSelection: Sendable, Equatable, Hashable, Codable {
    public var providerID: String
    public var modelID: String

    public init(providerID: String, modelID: String) {
        self.providerID = providerID
        self.modelID = modelID
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
