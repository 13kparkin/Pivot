import SwiftUI

public struct WorkspaceView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @Bindable var model: FeatureRootModel
    private let submitNewTask: (NewTaskRequest) async -> FeatureThread?
    private let submitMessage: (FeatureMessageSubmission) async -> Bool

    @State private var selectedThreadID: String?
    @State private var searchText = ""
    @State private var selectedProjectID: String?
    @State private var selectedScope: SidebarScope = .active
    @State private var settledLimit = 10
    @State private var showingNewTask = false
    @State private var showingAddProject = false
    @State private var showingSettings = false
    @State private var renamingThread: FeatureThread?
    @State private var renameTitle = ""
    @State private var sidebarClock = Date.now
    @FocusState private var isSearchFocused: Bool

    public init(
        model: FeatureRootModel,
        submitNewTask: ((NewTaskRequest) async -> FeatureThread?)? = nil,
        submitMessage: ((FeatureMessageSubmission) async -> Bool)? = nil
    ) {
        self.model = model
        self.submitNewTask = submitNewTask ?? { request in
            do {
                let thread = try await model.client.createThreadAndSend(
                    projectID: request.projectID,
                    prompt: request.trimmedPrompt,
                    selection: request.selection,
                    runtimeMode: request.runtimeMode,
                    interactionMode: request.interactionMode,
                    attachments: request.attachments.map(\.uploadValue)
                )
                await model.reload()
                return thread
            } catch {
                return nil
            }
        }
        self.submitMessage = submitMessage ?? { submission in
            if submission.attachments.isEmpty {
                return await model.sendMessage(
                    threadID: submission.threadID,
                    text: submission.text,
                    selection: submission.selection
                )
            }
            do {
                try await model.client.sendMessage(
                    threadID: submission.threadID,
                    text: submission.text,
                    selection: submission.selection,
                    attachments: submission.attachments.map(\.uploadValue)
                )
                _ = await model.detail(for: submission.threadID, force: true)
                return true
            } catch {
                return false
            }
        }
    }

    public var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(
                    min: T3Metrics.minimumSidebarWidth,
                    ideal: T3Metrics.sidebarWidth,
                    max: T3Metrics.maximumSidebarWidth
                )
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingNewTask) {
            NewThreadView(
                model: model,
                submit: submitNewTask
            ) { thread in
                selectedThreadID = thread.id
                showingNewTask = false
            }
        }
        .sheet(isPresented: $showingAddProject) {
            AddProjectView(model: model)
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView(model: model)
        }
        .alert(
            "Rename thread",
            isPresented: Binding(
                get: { renamingThread != nil },
                set: { if !$0 { renamingThread = nil } }
            )
        ) {
            TextField("Thread title", text: $renameTitle)
            Button("Cancel", role: .cancel) {
                renamingThread = nil
            }
            Button("Save") {
                guard let thread = renamingThread else { return }
                let title = renameTitle
                renamingThread = nil
                Task { await model.renameThread(thread.id, title: title) }
            }
            .disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .onChange(of: model.snapshot.threads) {
            if let selectedThreadID,
               !model.snapshot.threads.contains(where: { $0.id == selectedThreadID }) {
                self.selectedThreadID = nil
            }
        }
        .onChange(of: model.snapshot.projects.map(\.id)) {
            if let selectedProjectID,
               !model.snapshot.projects.contains(where: { $0.id == selectedProjectID }) {
                self.selectedProjectID = nil
            }
        }
        .task(id: sidebarBoundarySignature) {
            while !Task.isCancelled {
                sidebarClock = .now
                let delay = nextSidebarRefreshDelay(from: sidebarClock)
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    return
                }
            }
        }
    }

    private var sidebar: some View {
        let presentation = SidebarPresentation(
            snapshot: model.snapshot,
            query: searchText,
            projectID: selectedProjectID,
            scope: selectedScope,
            now: sidebarClock
        )

        return VStack(spacing: 0) {
            sidebarNavigationBar
            connectionHeader
            List(selection: $selectedThreadID) {
                scopePicker(presentation)
                projectFilter(presentation)

                if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    scopedThreadSection(presentation)
                } else {
                    searchResults(presentation)
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 0)
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .contentMargins(.top, 0, for: .scrollContent)
            .background(T3Colors.background)
        }
        .background(T3Colors.background)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            commandBar
        }
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: selectedProjectID) {
            settledLimit = 10
        }
        .onChange(of: selectedScope) {
            settledLimit = 10
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let id = selectedThreadID,
           let thread = model.snapshot.threads.first(where: { $0.id == id }) {
            ThreadDetailView(
                model: model,
                thread: thread,
                submitMessage: submitMessage
            )
            .id(id)
        } else {
            VStack(spacing: 18) {
                Image(systemName: "cursorarrow.rays")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(T3Colors.textTertiary)
                VStack(spacing: 5) {
                    Text("Ready when you are")
                        .font(.title3.weight(.semibold))
                    Text("Pick up a task or start something new.")
                        .font(.subheadline)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Button("New task") {
                    showingNewTask = true
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
                .disabled(model.snapshot.projects.isEmpty)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
        }
    }

    private var sidebarNavigationBar: some View {
        ZStack {
            Text("T3 Code")
                .font(.headline)
                .foregroundStyle(T3Colors.textPrimary)

            HStack {
                Button {
                    showingSettings = true
                } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 19, weight: .medium))
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityLabel("Settings")
                .accessibilityIdentifier("sidebar-settings-button")

                Spacer()

                Button {
                    showingAddProject = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .medium))
                        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(T3Colors.statusRunning)
                .accessibilityLabel("Add project")
                .accessibilityHint("Adds a repository to this environment")
                .accessibilityIdentifier("sidebar-add-project-button")
            }
            .padding(.horizontal, 6)
        }
        .frame(height: T3Metrics.minimumTapTarget)
        .background(T3Colors.background)
    }

    private var connectionHeader: some View {
        Menu {
            ForEach(model.snapshot.environments) { environment in
                Button {
                    Task { await model.activateEnvironment(environment.id) }
                } label: {
                    if environment.isActive {
                        Label(environment.name, systemImage: "checkmark")
                    } else {
                        Text(environment.name)
                    }
                }
            }
            Divider()
            Button {
                showingSettings = true
            } label: {
                Label("Manage devices", systemImage: "externaldrive.connected.to.line.below")
            }
        } label: {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    HStack(alignment: .top, spacing: 9) {
                        Circle()
                            .fill(connectionColor)
                            .frame(width: 7, height: 7)
                            .padding(.top, 7)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(model.snapshot.connection.environmentName ?? "T3 environment")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(T3Colors.textPrimary)
                                    .lineLimit(1)
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundStyle(T3Colors.textTertiary)
                            }
                            Text(connectionLabel)
                                .font(.caption)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 8)
                    .frame(minHeight: 60)
                } else {
                    HStack(spacing: 9) {
                        Circle()
                            .fill(connectionColor)
                            .frame(width: 7, height: 7)
                        Text(model.snapshot.connection.environmentName ?? "T3 environment")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(T3Colors.textPrimary)
                            .lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(T3Colors.textTertiary)
                        Spacer()
                        Text(connectionLabel)
                            .font(.caption)
                            .foregroundStyle(T3Colors.textSecondary)
                    }
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                }
            }
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(T3Colors.separator)
                    .frame(height: 0.5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Environment")
        .accessibilityValue(
            "\(model.snapshot.connection.environmentName ?? "T3 environment"), \(connectionLabel)"
        )
        .accessibilityHint("Switch environments or manage devices")
        .accessibilityIdentifier("sidebar-environment-menu")
    }

    private var commandBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)

                TextField("Search tasks", text: $searchText)
                    .font(.subheadline)
                    .foregroundStyle(T3Colors.textPrimary)
                    .focused($isSearchFocused)
                    .submitLabel(.search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Search tasks and projects")
                    .accessibilityIdentifier("sidebar-search-field")

                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(T3Colors.textTertiary)
                            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: T3Metrics.minimumTapTarget)
            .background(T3Colors.ledgerSurface, in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(T3Colors.border, lineWidth: 0.5)
            }

            Button {
                isSearchFocused = false
                showingNewTask = true
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 20, weight: .medium))
                    .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(T3Colors.statusRunning)
            .disabled(model.snapshot.projects.isEmpty)
            .opacity(model.snapshot.projects.isEmpty ? 0.35 : 1)
            .accessibilityLabel("New task")
            .accessibilityHint("Compose a message and start a thread")
            .accessibilityIdentifier("sidebar-new-task-button")
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .padding(.vertical, 4)
        .background(T3Colors.background)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 0.5)
        }
    }

    private func scopePicker(_ presentation: SidebarPresentation) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                Menu {
                    ForEach(SidebarScope.allCases) { scope in
                        Button {
                            selectedScope = scope
                        } label: {
                            if selectedScope == scope {
                                Label(
                                    "\(scope.title), \(presentation.count(for: scope))",
                                    systemImage: "checkmark"
                                )
                            } else {
                                Text("\(scope.title), \(presentation.count(for: scope))")
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text("Status filter")
                            .font(.subheadline)
                            .foregroundStyle(T3Colors.textSecondary)
                        Spacer()
                        Text(selectedScope.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(T3Colors.textPrimary)
                        Text("\(presentation.count(for: selectedScope))")
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(T3Colors.textTertiary)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Status filter")
                .accessibilityValue(
                    "\(selectedScope.title), \(presentation.count(for: selectedScope)) tasks"
                )
                .accessibilityHint("Filters the task list")
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 22) {
                            ForEach(SidebarScope.allCases) { scope in
                                Button {
                                    selectedScope = scope
                                } label: {
                                    VStack(spacing: 0) {
                                        Spacer(minLength: 0)
                                        HStack(spacing: 4) {
                                            Text(scope.title)
                                            if presentation.count(for: scope) > 0 {
                                                Text("\(presentation.count(for: scope))")
                                                    .foregroundStyle(T3Colors.textTertiary)
                                                    .monospacedDigit()
                                            }
                                        }
                                        .font(
                                            .caption.weight(
                                                selectedScope == scope ? .semibold : .medium
                                            )
                                        )
                                        .foregroundStyle(
                                            selectedScope == scope
                                                ? T3Colors.textPrimary
                                                : T3Colors.textSecondary
                                        )
                                        Spacer(minLength: 0)
                                        Rectangle()
                                            .fill(
                                                selectedScope == scope
                                                    ? T3Colors.textPrimary
                                                    : Color.clear
                                            )
                                            .frame(width: 20, height: 2)
                                    }
                                    .frame(height: T3Metrics.minimumTapTarget)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(scope.title)
                                .accessibilityValue("\(presentation.count(for: scope)) tasks")
                                .accessibilityHint("Filters the task list")
                                .accessibilityAddTraits(
                                    selectedScope == scope ? .isSelected : []
                                )
                                .id(scope)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    .onChange(of: selectedScope) {
                        proxy.scrollTo(selectedScope, anchor: .center)
                    }
                }
            }
        }
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    private func projectFilter(_ presentation: SidebarPresentation) -> some View {
        Menu {
            Button {
                selectedProjectID = nil
            } label: {
                if selectedProjectID == nil {
                    Label("All projects", systemImage: "checkmark")
                } else {
                    Text("All projects")
                }
            }
            ForEach(model.snapshot.projects) { project in
                Button {
                    selectedProjectID = project.id
                } label: {
                    if selectedProjectID == project.id {
                        Label(project.name, systemImage: "checkmark")
                    } else {
                        Text(project.name)
                    }
                }
            }
        } label: {
            ProjectFilterRow(
                project: model.snapshot.projects.first { $0.id == selectedProjectID },
                totalCount: presentation.scopedThreads.count
            )
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityLabel("Project filter")
        .accessibilityValue(
            "\(model.snapshot.projects.first { $0.id == selectedProjectID }?.name ?? "All projects"), \(presentation.scopedThreads.count) tasks"
        )
        .accessibilityHint("Filters tasks by repository")
        .accessibilityIdentifier("sidebar-project-filter")
    }

    @ViewBuilder
    private func scopedThreadSection(_ presentation: SidebarPresentation) -> some View {
        sidebarSectionHeader(
            selectedScope.sectionTitle,
            count: presentation.scopedThreads.count
        )

        if visibleScopedThreads(in: presentation).isEmpty {
            HStack {
                Text(emptyScopeMessage)
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 60, alignment: .leading)
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        } else {
            ForEach(visibleScopedThreads(in: presentation)) { thread in
                threadLink(
                    thread,
                    showsProject: selectedProjectID == nil,
                    isArchived: selectedScope == .archived
                )
            }

            if selectedScope == .settled,
               presentation.scopedThreads.count > settledLimit {
                Button {
                    settledLimit += 25
                } label: {
                    HStack {
                        Text("Show more")
                        Spacer()
                        Text("\(presentation.scopedThreads.count - settledLimit)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                    .padding(.horizontal, 16)
                    .frame(height: T3Metrics.minimumTapTarget)
                    .font(.subheadline)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        }
    }

    @ViewBuilder
    private func searchResults(_ presentation: SidebarPresentation) -> some View {
        sidebarSectionHeader("Results", count: presentation.searchThreads.count)

        if presentation.searchThreads.isEmpty {
            ContentUnavailableView.search(text: searchText)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        } else {
            ForEach(presentation.searchThreads) { thread in
                threadLink(
                    thread,
                    showsProject: true,
                    isArchived: thread.isArchived
                )
            }
        }
    }

    private func threadLink(
        _ thread: FeatureThread,
        showsProject: Bool,
        isArchived: Bool = false
    ) -> some View {
        NavigationLink(value: thread.id) {
            FeatureThreadRow(
                thread: thread,
                projectName: showsProject ? projectName(for: thread.projectID) : nil,
                now: sidebarClock,
                isSelected: selectedThreadID == thread.id
            )
        }
        .tag(thread.id)
        .buttonStyle(.plain)
        .navigationLinkIndicatorVisibility(.hidden)
        .listRowInsets(EdgeInsets())
        .listRowBackground(
            selectedThreadID == thread.id ? T3Colors.ledgerSelected : Color.clear
        )
        .listRowSeparator(.hidden)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await model.deleteThread(thread.id) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
            if isArchived {
                Button {
                    Task { await model.setArchived(thread.id, archived: false) }
                } label: {
                    Label("Restore", systemImage: "arrow.uturn.backward")
                }
                .tint(.blue)
            } else {
                Button {
                    Task { await model.setArchived(thread.id, archived: true) }
                } label: {
                    Label("Archive", systemImage: "archivebox")
                }
                .tint(.orange)
            }
        }
        .contextMenu {
            Button {
                renameTitle = thread.title
                renamingThread = thread
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            if isArchived {
                Button {
                    Task { await model.setArchived(thread.id, archived: false) }
                } label: {
                    Label("Restore", systemImage: "arrow.uturn.backward")
                }
            } else {
                Button {
                    Task { await model.setArchived(thread.id, archived: true) }
                } label: {
                    Label("Archive", systemImage: "archivebox")
                }

                if thread.isEffectivelySettled(at: .now) {
                    Button {
                        Task { await model.setSettled(thread.id, settled: false) }
                    } label: {
                        Label("Reopen", systemImage: "arrow.counterclockwise")
                    }
                } else {
                    Button {
                        Task { await model.setSettled(thread.id, settled: true) }
                    } label: {
                        Label("Mark done", systemImage: "checkmark")
                    }
                }

                Button {
                    let isSnoozed = thread.isEffectivelySnoozed(at: sidebarClock)
                    Task {
                        await model.setSnoozed(
                            thread.id,
                            until: isSnoozed ? nil : Date().addingTimeInterval(60 * 60)
                        )
                    }
                } label: {
                    let isSnoozed = thread.isEffectivelySnoozed(at: sidebarClock)
                    Label(
                        isSnoozed ? "Unsnooze" : "Snooze 1 hour",
                        systemImage: isSnoozed ? "bell" : "clock"
                    )
                }
                .disabled(
                    thread.state == .queued
                        || thread.state == .waitingForApproval
                        || thread.state == .waitingForInput
                )
            }
            Button(role: .destructive) {
                Task { await model.deleteThread(thread.id) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func visibleScopedThreads(in presentation: SidebarPresentation) -> [FeatureThread] {
        if selectedScope == .settled {
            return Array(presentation.scopedThreads.prefix(settledLimit))
        }
        return presentation.scopedThreads
    }

    private var emptyScopeMessage: String {
        let projectSuffix = selectedProjectID == nil ? "" : " in this project"
        return switch selectedScope {
        case .active: "No active tasks\(projectSuffix)"
        case .needsInput: "Nothing needs input\(projectSuffix)"
        case .failed: "No failed tasks\(projectSuffix)"
        case .snoozed: "No snoozed tasks\(projectSuffix)"
        case .settled: "No settled tasks\(projectSuffix)"
        case .archived: "No archived tasks\(projectSuffix)"
        }
    }

    private func sidebarSectionHeader(_ title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(T3Colors.textPrimary)
            Text("\(count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(T3Colors.textTertiary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 31, alignment: .bottom)
        .padding(.bottom, 7)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(count) tasks")
        .accessibilityAddTraits(.isHeader)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    private var sidebarBoundarySignature: String {
        model.snapshot.threads.map {
            [
                $0.id,
                $0.state.rawValue,
                $0.lastActivityAt?.timeIntervalSince1970.description ?? "",
                $0.snoozedUntil?.timeIntervalSince1970.description ?? "",
                $0.snoozedAt?.timeIntervalSince1970.description ?? "",
                $0.attentionAt?.timeIntervalSince1970.description ?? "",
            ].joined(separator: ":")
        }
        .joined(separator: "|")
    }

    private func nextSidebarRefreshDelay(from now: Date) -> TimeInterval {
        let nextSnoozeBoundary = model.snapshot.threads
            .compactMap(\.snoozedUntil)
            .filter { $0 > now }
            .min()
            .map { $0.timeIntervalSince(now) }
        return max(0.25, min(60, nextSnoozeBoundary ?? 60))
    }

    private var connectionColor: Color {
        switch model.snapshot.connection.state {
        case .connected: T3Colors.success
        case .connecting, .reconnecting: T3Colors.warning
        case .disconnected: T3Colors.danger
        }
    }

    private var connectionLabel: String {
        switch model.snapshot.connection.state {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .disconnected: "Offline"
        }
    }

    private func projectName(for id: String) -> String {
        model.snapshot.projects.first(where: { $0.id == id })?.name ?? "Unknown project"
    }
}

private extension FeatureDraftAttachment {
    var uploadValue: FeatureUploadAttachment {
        FeatureUploadAttachment(data: data, name: filename, mimeType: mimeType)
    }
}

private enum SidebarScope: String, CaseIterable, Identifiable {
    case active
    case needsInput
    case failed
    case snoozed
    case settled
    case archived

    var id: Self { self }

    var title: String {
        switch self {
        case .active: "Active"
        case .needsInput: "Needs input"
        case .failed: "Failed"
        case .snoozed: "Snoozed"
        case .settled: "Settled"
        case .archived: "Archive"
        }
    }

    var sectionTitle: String {
        self == .archived ? "Archived" : title
    }
}

private struct SidebarPresentation {
    let index: DailyUXSidebarIndex
    let archivedThreads: [FeatureThread]
    let scopedThreads: [FeatureThread]
    let searchThreads: [FeatureThread]

    init(
        snapshot: FeatureSnapshot,
        query: String,
        projectID: String?,
        scope: SidebarScope,
        now: Date
    ) {
        let index = DailyUXSidebarIndex(
            snapshot: snapshot,
            query: "",
            projectID: projectID,
            now: now
        )
        let archivedThreads = snapshot.threads
            .filter { thread in
                guard thread.isArchived else { return false }
                return projectID == nil || thread.projectID == projectID
            }
            .sorted { lhs, rhs in
                if lhs.updatedAt != rhs.updatedAt {
                    return lhs.updatedAt > rhs.updatedAt
                }
                return lhs.id < rhs.id
            }
        let scopedThreads = switch scope {
        case .active: index.active
        case .needsInput: index.needsInput
        case .failed: index.failed
        case .snoozed: index.snoozed
        case .settled: index.settled
        case .archived: archivedThreads
        }

        self.index = index
        self.archivedThreads = archivedThreads
        self.scopedThreads = scopedThreads
        searchThreads = DailyUXSidebarIndex.matchingThreads(
            scopedThreads,
            snapshot: snapshot,
            query: query
        )
    }

    func count(for scope: SidebarScope) -> Int {
        switch scope {
        case .active: index.active.count
        case .needsInput: index.needsInput.count
        case .failed: index.failed.count
        case .snoozed: index.snoozed.count
        case .settled: index.settled.count
        case .archived: archivedThreads.count
        }
    }
}

private struct ProjectFilterRow: View {
    let project: FeatureProject?
    let totalCount: Int

    var body: some View {
        HStack(spacing: 7) {
            Text(project?.name ?? "All projects")
                .font(.subheadline)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
            Spacer()
            Text("\(totalCount)")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(T3Colors.textTertiary)
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(T3Colors.textTertiary)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 0.5)
        }
        .accessibilityElement(children: .ignore)
    }
}

struct FeatureThreadRow: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let thread: FeatureThread
    let projectName: String?
    let now: Date
    let isSelected: Bool

    init(
        thread: FeatureThread,
        projectName: String?,
        now: Date = .now,
        isSelected: Bool = false
    ) {
        self.thread = thread
        self.projectName = projectName
        self.now = now
        self.isSelected = isSelected
    }

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                accessibleRow
            } else {
                regularRow
            }
        }
        .background(isSelected ? T3Colors.ledgerSelected : Color.clear)
        .overlay(alignment: .leading) {
            if isSelected {
                Rectangle()
                    .fill(T3Colors.statusRunning)
                    .frame(width: 2)
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 0.5)
                .padding(.leading, 48)
                .padding(.trailing, 16)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(thread.title)
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("Opens task")
        .accessibilityIdentifier("thread-\(thread.id)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var regularRow: some View {
        HStack(spacing: 0) {
            statusGlyph
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                metadata
                    .lineLimit(1)
            }

            Text(compactAge)
                .font(.caption.monospacedDigit())
                .foregroundStyle(T3Colors.textTertiary)
                .lineLimit(1)
                .frame(width: 42, alignment: .trailing)
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(minHeight: 60)
    }

    private var accessibleRow: some View {
        HStack(alignment: .top, spacing: 0) {
            statusGlyph
                .frame(width: 32, height: 28, alignment: .center)

            VStack(alignment: .leading, spacing: 5) {
                Text(thread.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)

                metadata
                    .lineLimit(2)

                HStack(spacing: 6) {
                    Text(statusText)
                        .foregroundStyle(statusColor)
                    Text("·")
                        .foregroundStyle(T3Colors.textTertiary)
                    Text("Updated \(compactAge)")
                        .foregroundStyle(T3Colors.textSecondary)
                }
                .font(.caption)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 72)
    }

    @ViewBuilder
    private var metadata: some View {
        HStack(spacing: 5) {
            if let projectName {
                Text(projectName)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            if let preview = visiblePreview {
                if projectName != nil {
                    Text("·")
                        .foregroundStyle(T3Colors.textTertiary)
                }
                Text(preview)
                    .foregroundStyle(thread.needsAttention ? statusColor : T3Colors.textSecondary)
            }
        }
        .font(.caption)
    }

    private var statusGlyph: some View {
        Image(systemName: statusIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(statusColor)
            .accessibilityHidden(true)
    }

    private var visiblePreview: String? {
        if let preview = thread.preview?.trimmingCharacters(in: .whitespacesAndNewlines),
           !preview.isEmpty {
            return preview.replacingOccurrences(of: "\n", with: " ")
        }
        return thread.needsAttention ? statusText : nil
    }

    private var statusIcon: String {
        if thread.isEffectivelySnoozed(at: now) {
            return "moon.zzz.fill"
        }
        if thread.isEffectivelySettled(at: now) {
            return "checkmark.circle.fill"
        }
        return switch thread.state {
        case .idle: "circle"
        case .completed: "checkmark.circle.fill"
        case .queued: "clock"
        case .working: "bolt.fill"
        case .waitingForApproval: "exclamationmark.triangle.fill"
        case .waitingForInput: "questionmark.circle.fill"
        case .failed: "xmark.circle.fill"
        }
    }

    private var statusColor: Color {
        if thread.isEffectivelySnoozed(at: now) {
            return T3Colors.textSecondary
        }
        if thread.isEffectivelySettled(at: now) {
            return T3Colors.success.opacity(0.7)
        }
        return switch thread.state {
        case .idle, .completed: T3Colors.textTertiary
        case .queued: T3Colors.textTertiary
        case .working: T3Colors.statusRunning
        case .waitingForApproval: T3Colors.warning
        case .waitingForInput: .indigo
        case .failed: T3Colors.danger
        }
    }

    private var statusText: String {
        if thread.isEffectivelySnoozed(at: now) {
            return "Snoozed"
        }
        if thread.isEffectivelySettled(at: now) {
            return "Settled"
        }
        return switch thread.state {
        case .waitingForApproval: "Approval needed"
        case .waitingForInput: "Answer needed"
        case .working: "Working"
        case .queued: "Queued"
        case .failed: "Failed"
        case .idle, .completed: thread.state.rawValue.capitalized
        }
    }

    private var compactAge: String {
        SidebarRelativeAge.compact(since: thread.updatedAt, now: now)
    }

    private var accessibilityValue: String {
        var parts = [statusText]
        if let projectName {
            parts.append("Project \(projectName)")
        }
        if let visiblePreview, visiblePreview != statusText {
            parts.append(visiblePreview)
        }
        parts.append(SidebarRelativeAge.accessibility(since: thread.updatedAt, now: now))
        return parts.joined(separator: ". ")
    }
}
