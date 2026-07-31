import SwiftUI

public struct WorkspaceView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @Bindable var model: FeatureRootModel
    private let submitNewTask: (NewTaskRequest) async -> FeatureThread?
    private let submitMessage: (FeatureMessageSubmission) async -> Bool

    @State private var selectedThreadID: String?
    @State private var selectedProjectID: String?
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var isSnoozedExpanded = false
    @State private var isSettledExpanded = true
    @State private var isArchiveExpanded = false
    @State private var settledLimit = 12
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
            NewThreadView(model: model, submit: submitNewTask) { thread in
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
            Button("Cancel", role: .cancel) { renamingThread = nil }
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
                do {
                    try await Task.sleep(for: .seconds(nextSidebarRefreshDelay))
                } catch {
                    return
                }
            }
        }
    }

    private var sidebar: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                homeBar
                if isSearching {
                    searchBar
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                threadList
            }

            composeButton
                .padding(.trailing, 16)
                .padding(.bottom, 14)
        }
        .background(T3Colors.background)
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: selectedProjectID) {
            settledLimit = 12
        }
    }

    private var threadList: some View {
        let presentation = HomePresentation(
            snapshot: model.snapshot,
            query: searchText,
            projectID: selectedProjectID,
            now: sidebarClock
        )

        return List(selection: $selectedThreadID) {
            projectFilter(presentation)

            if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                activeRows(presentation)
                shelfRows(
                    title: "Snoozed",
                    threads: presentation.snoozed,
                    isExpanded: $isSnoozedExpanded,
                    accent: T3Colors.accent,
                    isArchived: false
                )
                shelfRows(
                    title: "Settled",
                    threads: Array(presentation.settled.prefix(settledLimit)),
                    totalCount: presentation.settled.count,
                    isExpanded: $isSettledExpanded,
                    accent: nil,
                    isArchived: false
                )
                if presentation.settled.count > settledLimit, isSettledExpanded {
                    showMoreSettled(presentation.settled.count - settledLimit)
                }
                if !presentation.archived.isEmpty {
                    shelfRows(
                        title: "Archived",
                        threads: presentation.archived,
                        isExpanded: $isArchiveExpanded,
                        accent: nil,
                        isArchived: true
                    )
                }
            } else {
                searchRows(presentation)
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .contentMargins(.top, 4, for: .scrollContent)
        .contentMargins(.bottom, 74, for: .scrollContent)
        .background(T3Colors.background)
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
            VStack(spacing: 14) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(T3Colors.textTertiary)
                Text("Start a task")
                    .font(.title3.weight(.semibold))
                Text("Choose a thread or compose something new.")
                    .font(.subheadline)
                    .foregroundStyle(T3Colors.textSecondary)
                Button("New task") { showingNewTask = true }
                    .buttonStyle(.borderedProminent)
                    .tint(.white)
                    .foregroundStyle(.black)
                    .disabled(activeProjects.isEmpty)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
        }
    }

    private var homeBar: some View {
        HStack(spacing: 2) {
            connectionBrand
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    isSearching.toggle()
                }
                if isSearching {
                    Task { @MainActor in
                        await Task.yield()
                        isSearchFocused = true
                    }
                } else {
                    searchText = ""
                    isSearchFocused = false
                }
            } label: {
                Image(systemName: isSearching ? "xmark" : "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 40, height: T3Metrics.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(T3Colors.textSecondary)
            .accessibilityLabel(isSearching ? "Close search" : "Search tasks")
            .accessibilityIdentifier("sidebar-search-button")

            Button { showingSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 40, height: T3Metrics.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(T3Colors.textSecondary)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("sidebar-settings-button")
        }
        .padding(.leading, 15)
        .padding(.trailing, 8)
        .frame(height: 49)
        .background(T3Colors.background)
    }

    @ViewBuilder
    private var connectionBrand: some View {
        if !unreachableEnvironments.isEmpty {
            HStack(spacing: 7) {
                Image(systemName: "network.slash")
                    .font(.system(size: 13, weight: .semibold))
                Text(unreachableBrandLabel)
                    .lineLimit(2)
                    .font(.system(size: 13, weight: .semibold))
                Button("Reconnect") {
                    Task { await model.reload() }
                }
                .font(.caption.weight(.bold))
                .buttonStyle(.plain)
                .padding(.horizontal, 9)
                .frame(height: 26)
                .overlay {
                    Capsule().stroke(T3Colors.danger.opacity(0.42), lineWidth: 1)
                }
            }
            .foregroundStyle(T3Colors.danger)
            .accessibilityElement(children: .contain)
        } else if let reconnecting = reconnectingEnvironments.first {
            Button { showingSettings = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 13, weight: .semibold))
                    Text(reconnecting.name)
                        .lineLimit(1)
                    Text("reconnecting")
                        .fontWeight(.medium)
                        .opacity(0.76)
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(T3Colors.warning)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(reconnecting.name) reconnecting")
        } else if model.snapshot.connection.state == .connecting
            || model.snapshot.connection.state == .reconnecting {
            Button { showingSettings = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 13, weight: .semibold))
                    Text(connectionEnvironmentName)
                        .lineLimit(1)
                    Text("reconnecting")
                        .fontWeight(.medium)
                        .opacity(0.76)
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(T3Colors.warning)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(connectionEnvironmentName) reconnecting")
        } else if model.snapshot.connection.state == .disconnected {
            HStack(spacing: 7) {
                Image(systemName: "network.slash")
                    .font(.system(size: 13, weight: .semibold))
                Text("\(connectionEnvironmentName) unreachable")
                    .lineLimit(2)
                    .font(.system(size: 13, weight: .semibold))
                Button("Reconnect") {
                    Task { await model.reload() }
                }
                .font(.caption.weight(.bold))
                .buttonStyle(.plain)
                .padding(.horizontal, 9)
                .frame(height: 26)
                .overlay {
                    Capsule().stroke(T3Colors.danger.opacity(0.42), lineWidth: 1)
                }
            }
            .foregroundStyle(T3Colors.danger)
            .accessibilityElement(children: .contain)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("T3")
                    .fontWeight(.bold)
                    .foregroundStyle(T3Colors.textPrimary)
                Text("Code")
                    .fontWeight(.medium)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .font(.system(size: 16))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("T3 Code")
        }
    }

    private var searchBar: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(T3Colors.textTertiary)
            TextField("Search tasks and projects", text: $searchText)
                .font(.subheadline)
                .foregroundStyle(T3Colors.textPrimary)
                .focused($isSearchFocused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("sidebar-search-field")
            if !searchText.isEmpty {
                Button { searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: T3Metrics.minimumTapTarget)
        .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(T3Colors.border, lineWidth: 1)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }

    private var composeButton: some View {
        Button {
            isSearchFocused = false
            showingNewTask = true
        } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.black)
                .frame(width: 52, height: 52)
                .background(Color(white: 0.95), in: Circle())
                .shadow(color: .black.opacity(0.7), radius: 16, y: 8)
        }
        .buttonStyle(.plain)
        .disabled(activeProjects.isEmpty)
        .opacity(activeProjects.isEmpty ? 0.35 : 1)
        .accessibilityLabel("New task")
        .accessibilityHint("Compose a message and start a thread")
        .accessibilityIdentifier("sidebar-new-task-button")
    }

    private func projectFilter(_ presentation: HomePresentation) -> some View {
        HStack(spacing: 0) {
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
                        let title = projectMenuTitle(project)
                        if selectedProjectID == project.id {
                            Label(title, systemImage: "checkmark")
                        } else {
                            Text(title)
                        }
                    }
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "folder")
                        .font(.system(size: 13, weight: .medium))
                    Text(selectedProject?.name ?? "All projects")
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.white.opacity(0.55))
                .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Project filter")
            .accessibilityValue(selectedProject?.name ?? "All projects")
            .accessibilityIdentifier("sidebar-project-filter")

            Button { showingAddProject = true } label: {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: T3Metrics.minimumTapTarget, height: 34)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add project")
            .accessibilityIdentifier("sidebar-add-project-button")
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func activeRows(_ presentation: HomePresentation) -> some View {
        if presentation.active.isEmpty {
            Text("No active tasks")
                .font(.footnote)
                .foregroundStyle(T3Colors.textTertiary)
                .frame(maxWidth: .infinity, minHeight: 68, alignment: .center)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        } else {
            ForEach(presentation.active) { thread in
                threadLink(thread, style: .rich, isArchived: false)
            }
        }
    }

    @ViewBuilder
    private func shelfRows(
        title: String,
        threads: [FeatureThread],
        totalCount: Int? = nil,
        isExpanded: Binding<Bool>,
        accent: Color?,
        isArchived: Bool
    ) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.16)) {
                isExpanded.wrappedValue.toggle()
            }
        } label: {
            HomeShelfHeader(
                title: title,
                count: totalCount ?? threads.count,
                isExpanded: isExpanded.wrappedValue,
                accent: accent
            )
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityLabel("\(title), \(totalCount ?? threads.count) tasks")
        .accessibilityValue(isExpanded.wrappedValue ? "Expanded" : "Collapsed")

        if isExpanded.wrappedValue {
            if threads.isEmpty {
                Text("None")
                    .font(.caption)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.leading, 34)
                    .frame(minHeight: 34)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(threads) { thread in
                    threadLink(thread, style: .slim, isArchived: isArchived)
                }
            }
        }
    }

    private func showMoreSettled(_ remaining: Int) -> some View {
        Button {
            settledLimit += 25
        } label: {
            HStack {
                Text("Show more")
                Spacer()
                Text("\(remaining)")
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(T3Colors.textSecondary)
            .padding(.horizontal, 34)
            .frame(height: T3Metrics.minimumTapTarget)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private func searchRows(_ presentation: HomePresentation) -> some View {
        if presentation.searchResults.isEmpty {
            ContentUnavailableView.search(text: searchText)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        } else {
            ForEach(presentation.searchResults) { thread in
                threadLink(thread, style: .rich, isArchived: thread.isArchived)
            }
        }
    }

    private func threadLink(
        _ thread: FeatureThread,
        style: FeatureThreadRow.Style,
        isArchived: Bool
    ) -> some View {
        NavigationLink(value: thread.id) {
            FeatureThreadRow(
                thread: thread,
                projectName: projectName(for: thread),
                snapshot: model.snapshot,
                now: sidebarClock,
                isSelected: selectedThreadID == thread.id,
                connectionState: connectionState(for: thread),
                style: dynamicTypeSize.isAccessibilitySize ? .rich : style
            )
        }
        .tag(thread.id)
        .buttonStyle(.plain)
        .navigationLinkIndicatorVisibility(.hidden)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
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

                Button {
                    Task {
                        await model.setSettled(
                            thread.id,
                            settled: !thread.isEffectivelySettled(at: sidebarClock)
                        )
                    }
                } label: {
                    Label(
                        thread.isEffectivelySettled(at: sidebarClock) ? "Reopen" : "Mark done",
                        systemImage: thread.isEffectivelySettled(at: sidebarClock)
                            ? "arrow.counterclockwise"
                            : "checkmark"
                    )
                }

                Button {
                    let snoozed = thread.isEffectivelySnoozed(at: sidebarClock)
                    Task {
                        await model.setSnoozed(
                            thread.id,
                            until: snoozed ? nil : Date().addingTimeInterval(60 * 60)
                        )
                    }
                } label: {
                    let snoozed = thread.isEffectivelySnoozed(at: sidebarClock)
                    Label(
                        snoozed ? "Unsnooze" : "Snooze 1 hour",
                        systemImage: snoozed ? "bell" : "clock"
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

    private var selectedProject: FeatureProject? {
        model.snapshot.projects.first { $0.id == selectedProjectID }
    }

    private var activeProjects: [FeatureProject] {
        guard let activeID = model.snapshot.environments.first(where: \.isActive)?.id else {
            return model.snapshot.projects
        }
        return model.snapshot.projects.filter { $0.environmentID == activeID }
    }

    private var connectionEnvironmentName: String {
        model.snapshot.connection.environmentName
            ?? model.snapshot.environments.first(where: \.isActive)?.name
            ?? model.snapshot.environments.first?.name
            ?? "Server"
    }

    private var unreachableEnvironments: [FeatureEnvironment] {
        model.snapshot.environments.filter { $0.connectionState == .disconnected }
    }

    private var reconnectingEnvironments: [FeatureEnvironment] {
        model.snapshot.environments.filter {
            $0.connectionState == .connecting || $0.connectionState == .reconnecting
        }
    }

    private var unreachableBrandLabel: String {
        if unreachableEnvironments.count == 1 {
            return "\(unreachableEnvironments[0].name) unreachable"
        }
        return "\(unreachableEnvironments.count) devices unreachable"
    }

    private var sidebarBoundarySignature: String {
        model.snapshot.threads.map {
            [
                $0.id,
                $0.state.rawValue,
                $0.updatedAt.timeIntervalSince1970.description,
                $0.workingStartedAt?.timeIntervalSince1970.description ?? "",
                $0.snoozedUntil?.timeIntervalSince1970.description ?? "",
            ].joined(separator: ":")
        }
        .joined(separator: "|")
    }

    private var nextSidebarRefreshDelay: TimeInterval {
        if model.snapshot.threads.contains(where: { $0.homeStatus == .working }) {
            return 1
        }
        let nextSnooze = model.snapshot.threads
            .compactMap(\.snoozedUntil)
            .filter { $0 > sidebarClock }
            .min()
            .map { $0.timeIntervalSince(sidebarClock) }
        return max(0.25, min(60, nextSnooze ?? 60))
    }

    private func connectionState(for thread: FeatureThread) -> FeatureConnection.State? {
        let projectEnvironmentID = model.snapshot.projects
            .first(where: { $0.id == thread.projectID })?
            .environmentID
        let environmentID = thread.environmentID ?? projectEnvironmentID
        if let environment = model.snapshot.environments.first(where: { $0.id == environmentID }) {
            if environment.isActive {
                return model.snapshot.connection.state
            }
            if let state = environment.connectionState {
                return state
            }
            return nil
        }
        let activeID = model.snapshot.environments.first(where: \.isActive)?.id
        if environmentID == nil || activeID == nil || environmentID == activeID {
            return model.snapshot.connection.state
        }
        return nil
    }

    private func projectName(for thread: FeatureThread) -> String {
        model.snapshot.projects.first {
            $0.id == thread.projectID
                && (thread.environmentID == nil || $0.environmentID == thread.environmentID)
        }?.name ?? "Project"
    }

    private func projectMenuTitle(_ project: FeatureProject) -> String {
        guard model.snapshot.environments.count > 1,
              let environment = model.snapshot.environments.first(where: {
                  $0.id == project.environmentID
              }) else {
            return project.name
        }
        return "\(project.name) · \(environment.name)"
    }
}

private extension FeatureDraftAttachment {
    var uploadValue: FeatureUploadAttachment {
        FeatureUploadAttachment(data: data, name: filename, mimeType: mimeType)
    }
}

private struct HomePresentation {
    let active: [FeatureThread]
    let snoozed: [FeatureThread]
    let settled: [FeatureThread]
    let archived: [FeatureThread]
    let searchResults: [FeatureThread]

    init(snapshot: FeatureSnapshot, query: String, projectID: String?, now: Date) {
        let index = DailyUXSidebarIndex(
            snapshot: snapshot,
            query: "",
            projectID: projectID,
            now: now
        )
        let archived = snapshot.threads
            .filter { thread in
                thread.isArchived && (projectID == nil || thread.projectID == projectID)
            }
            .sorted {
                if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
                return $0.id < $1.id
            }

        active = index.active
        snoozed = index.snoozed
        settled = index.settled
        self.archived = archived
        searchResults = DailyUXSidebarIndex.matchingThreads(
            index.active + index.snoozed + index.settled + archived,
            snapshot: snapshot,
            query: query
        )
    }
}

private struct HomeShelfHeader: View {
    let title: String
    let count: Int
    let isExpanded: Bool
    let accent: Color?

    var body: some View {
        HStack(spacing: 8) {
            Text(count > 0 ? "\(title) (\(count))" : title)
                .lineLimit(1)
            Rectangle()
                .fill((accent ?? T3Colors.textTertiary).opacity(accent == nil ? 0.16 : 0.24))
                .frame(height: 1)
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 8, weight: .bold))
        }
        .font(.caption2.weight(.bold))
        .foregroundStyle(accent ?? T3Colors.textTertiary)
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .frame(height: 36)
        .contentShape(Rectangle())
    }
}

struct FeatureThreadRow: View {
    enum Style {
        case rich
        case slim
    }

    let thread: FeatureThread
    let projectName: String
    let snapshot: FeatureSnapshot
    let now: Date
    let isSelected: Bool
    let connectionState: FeatureConnection.State?
    let style: Style

    init(
        thread: FeatureThread,
        projectName: String,
        snapshot: FeatureSnapshot,
        now: Date = .now,
        isSelected: Bool = false,
        connectionState: FeatureConnection.State? = nil,
        style: Style = .rich
    ) {
        self.thread = thread
        self.projectName = projectName
        self.snapshot = snapshot
        self.now = now
        self.isSelected = isSelected
        self.connectionState = connectionState
        self.style = style
    }

    var body: some View {
        Group {
            switch style {
            case .rich: richRow
            case .slim: slimRow
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(thread.title)
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("Opens task")
        .accessibilityIdentifier("thread-\(thread.id)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var richRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                ProjectBadge(name: projectName)
                Text(projectName)
                    .lineLimit(1)
                    .foregroundStyle(Color.white.opacity(0.58))
                Spacer(minLength: 8)
                status
            }
            .font(.system(size: 11.5, weight: .medium))
            .frame(height: 20)

            Text(thread.title)
                .font(.system(size: 15, weight: .semibold))
                .tracking(-0.14)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
                .padding(.top, 4)

            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 10, weight: .medium))
                Text(branchLabel)
                    .lineLimit(1)
                if providerLooksTerminal {
                    Text(">_")
                        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color(red: 0.37, green: 0.92, blue: 0.83))
                }
                Spacer(minLength: 8)
                if let environmentLabel {
                    HStack(spacing: 4) {
                        Image(systemName: environmentIcon)
                            .font(.system(size: 9))
                        Text(environmentLabel)
                            .lineLimit(1)
                    }
                    .foregroundStyle(environmentColor)
                }
                Image(systemName: "sparkles")
                    .font(.system(size: 9))
                    .opacity(0.48)
            }
            .font(.system(size: 11))
            .foregroundStyle(Color.white.opacity(0.4))
            .frame(height: 18)
            .padding(.top, 3)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 78)
        .background(
            isSelected ? Color.white.opacity(0.09) : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
        .padding(.horizontal, 8)
    }

    private var slimRow: some View {
        HStack(spacing: 9) {
            ProjectBadge(name: projectName)
                .saturation(0)
                .opacity(0.48)
            Text(thread.title)
                .font(.system(size: 13))
                .foregroundStyle(Color.white.opacity(0.52))
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(SidebarRelativeAge.compact(since: thread.updatedAt, now: now))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(T3Colors.textTertiary)
        }
        .padding(.horizontal, 10)
        .frame(height: 36)
        .padding(.horizontal, 8)
        .background(
            isSelected ? Color.white.opacity(0.07) : Color.clear,
            in: RoundedRectangle(cornerRadius: 7)
        )
    }

    @ViewBuilder
    private var status: some View {
        let label = thread.homeStatusLabel
            ?? SidebarRelativeAge.compact(since: thread.updatedAt, now: now)
        HStack(spacing: 5) {
            if let icon = statusIcon {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
            }
            Text(label)
            if let duration = thread.homeWorkingDuration(at: now) {
                Text(duration)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .monospacedDigit()
            }
        }
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(statusColor)
    }

    private var statusIcon: String? {
        switch thread.homeStatus {
        case .working: "circle.dotted"
        case .done: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .approval, .input, .ready: nil
        }
    }

    private var statusColor: Color {
        switch thread.homeStatus {
        case .working: Color(red: 0.22, green: 0.74, blue: 0.97)
        case .approval: Color(red: 0.99, green: 0.77, blue: 0.27)
        case .input: Color(red: 0.65, green: 0.71, blue: 0.99)
        case .failed: T3Colors.danger
        case .done: Color(red: 0.43, green: 0.91, blue: 0.72)
        case .ready: Color.white.opacity(0.4)
        }
    }

    private var environmentLabel: String? {
        thread.homeEnvironmentLabel(in: snapshot)
    }

    private var environmentIcon: String {
        switch connectionState {
        case .connecting, .reconnecting:
            "wifi"
        case .disconnected:
            "wifi.slash"
        case .connected, nil:
            "server.rack"
        }
    }

    private var environmentColor: Color {
        switch connectionState {
        case .connecting, .reconnecting:
            T3Colors.warning.opacity(0.78)
        case .disconnected:
            T3Colors.danger.opacity(0.78)
        case .connected, nil:
            Color.white.opacity(0.36)
        }
    }

    private var isConnectionStale: Bool {
        connectionState == .connecting
            || connectionState == .reconnecting
            || connectionState == .disconnected
    }

    private var branchLabel: String {
        if let branch = thread.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
           !branch.isEmpty {
            return branch
        }
        if let worktreePath = thread.worktreePath,
           !worktreePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: worktreePath).lastPathComponent
        }
        return "workspace"
    }

    private var providerLooksTerminal: Bool {
        let provider = thread.homeProviderLabel(in: snapshot)?.lowercased() ?? ""
        return provider.contains("codex") || provider.contains("cursor") || provider.contains("open")
    }

    private var accessibilityValue: String {
        var values = [thread.homeStatusLabel ?? "Ready", "Project \(projectName)"]
        if let duration = thread.homeWorkingDuration(at: now) {
            values.append("for \(duration)")
        }
        values.append("Branch \(branchLabel)")
        if let environmentLabel {
            values.append("on \(environmentLabel)")
        }
        if isConnectionStale {
            values.append("last known state")
        }
        return values.joined(separator: ". ")
    }
}

private struct ProjectBadge: View {
    let name: String

    var body: some View {
        Text(label)
            .font(.system(size: 8, weight: .heavy))
            .foregroundStyle(foreground)
            .frame(width: 16, height: 16)
            .background(background, in: RoundedRectangle(cornerRadius: 4))
            .accessibilityHidden(true)
    }

    private var label: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "?" }
        if trimmed.lowercased().hasPrefix("t3") { return "T3" }
        return String(trimmed.prefix(1)).uppercased()
    }

    private var paletteIndex: Int {
        if label == "T3" { return 0 }
        return name.unicodeScalars.reduce(0) { ($0 + Int($1.value)) % 4 }
    }

    private var background: Color {
        switch paletteIndex {
        case 0: Color(red: 0.03, green: 0.24, blue: 0.21)
        case 1: Color(red: 0.19, green: 0.13, blue: 0.37)
        case 2: Color(red: 0.29, green: 0.18, blue: 0.02)
        default: Color(red: 0.10, green: 0.18, blue: 0.34)
        }
    }

    private var foreground: Color {
        switch paletteIndex {
        case 0: Color(red: 0.78, green: 0.98, blue: 0.95)
        case 1: Color(red: 0.93, green: 0.91, blue: 1)
        case 2: Color(red: 1, green: 0.95, blue: 0.78)
        default: Color(red: 0.82, green: 0.9, blue: 1)
        }
    }
}
