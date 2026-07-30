import SwiftUI

public struct WorkspaceView: View {
    @Bindable var model: FeatureRootModel
    private let submitNewTask: (NewTaskRequest) async -> FeatureThread?
    private let submitMessage: (FeatureMessageSubmission) async -> Bool

    @State private var selectedThreadID: String?
    @State private var searchText = ""
    @State private var selectedProjectID: String?
    @State private var settledLimit = 10
    @State private var showingNewTask = false
    @State private var showingAddProject = false
    @State private var showingSettings = false
    @State private var showingArchived = false
    @State private var renamingThread: FeatureThread?
    @State private var renameTitle = ""

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
        .sheet(isPresented: $showingArchived) {
            ArchivedThreadsView(model: model) { thread in
                selectedThreadID = thread.id
                showingArchived = false
            }
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
    }

    private var sidebar: some View {
        List(selection: $selectedThreadID) {
            connectionHeader
            newTaskAction

            if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                projectFilter
                activeSection
                settledSection
                archiveAction
            } else {
                searchResults
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(T3Colors.background)
        .searchable(text: $searchText, prompt: "Search tasks and projects")
        .navigationTitle("T3")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showingSettings = true
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .accessibilityLabel("Settings")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingAddProject = true
                } label: {
                    Image(systemName: "folder.badge.plus")
                }
                .accessibilityLabel("Add project")
            }
        }
        .t3NavigationChrome()
        .onChange(of: selectedProjectID) {
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
            HStack(spacing: 9) {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.snapshot.connection.environmentName ?? "T3 environment")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    Text(connectionLabel)
                        .font(.caption2)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
    }

    private var newTaskAction: some View {
        Button {
            showingNewTask = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "plus")
                    .font(.system(size: 14, weight: .bold))
                Text("New task")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.black.opacity(0.48))
            }
            .foregroundStyle(.black)
            .padding(.horizontal, 12)
            .frame(height: 42)
            .background(.white, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .disabled(model.snapshot.projects.isEmpty)
        .opacity(model.snapshot.projects.isEmpty ? 0.35 : 1)
        .listRowInsets(EdgeInsets(top: 7, leading: 12, bottom: 9, trailing: 12))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityHint("Compose a message and start a thread")
    }

    private var projectFilter: some View {
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
                totalCount: sidebarIndex.active.count + sidebarIndex.settled.count
            )
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private var activeSection: some View {
        Section("Active") {
            if sidebarIndex.active.isEmpty {
                Text(selectedProjectID == nil ? "No active tasks" : "No active tasks in this project")
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textSecondary)
            } else {
                ForEach(sidebarIndex.active) { thread in
                    threadLink(thread, showsProject: selectedProjectID == nil)
                }
            }
        }
    }

    @ViewBuilder
    private var settledSection: some View {
        if !sidebarIndex.settled.isEmpty {
            Section("Settled") {
                ForEach(sidebarIndex.settled.prefix(settledLimit)) { thread in
                    threadLink(thread, showsProject: selectedProjectID == nil)
                        .opacity(0.76)
                }
                if sidebarIndex.settled.count > settledLimit {
                    Button {
                        settledLimit += 25
                    } label: {
                        HStack {
                            Text("Show more")
                            Spacer()
                            Text("\(sidebarIndex.settled.count - settledLimit)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(T3Colors.textTertiary)
                        }
                        .font(.subheadline)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var archiveAction: some View {
        Button {
            showingArchived = true
        } label: {
            Label("Archived", systemImage: "archivebox")
                .font(.subheadline)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var searchResults: some View {
        Section("Results") {
            if sidebarIndex.searchResults.isEmpty {
                ContentUnavailableView.search(text: searchText)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(sidebarIndex.searchResults) { thread in
                    threadLink(thread, showsProject: true)
                }
            }
        }
    }

    private func threadLink(_ thread: FeatureThread, showsProject: Bool) -> some View {
        NavigationLink(value: thread.id) {
            FeatureThreadRow(
                thread: thread,
                projectName: showsProject ? projectName(for: thread.projectID) : nil
            )
        }
        .tag(thread.id)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await model.deleteThread(thread.id) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button {
                Task { await model.setArchived(thread.id, archived: true) }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .tint(.orange)
        }
        .contextMenu {
            Button {
                renameTitle = thread.title
                renamingThread = thread
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button {
                Task { await model.setArchived(thread.id, archived: true) }
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            if thread.isSettled {
                Button {
                    Task { await model.setSettled(thread.id, settled: false) }
                } label: {
                    Label("Reopen", systemImage: "arrow.counterclockwise")
                }
            } else if !thread.isEffectivelySettled(at: .now) {
                Button {
                    Task { await model.setSettled(thread.id, settled: true) }
                } label: {
                    Label("Mark done", systemImage: "checkmark")
                }
            }
            Button {
                Task {
                    await model.setSnoozed(
                        thread.id,
                        until: thread.snoozedUntil == nil
                            ? Date().addingTimeInterval(60 * 60)
                            : nil
                    )
                }
            } label: {
                Label(
                    thread.snoozedUntil == nil ? "Snooze 1 hour" : "Unsnooze",
                    systemImage: thread.snoozedUntil == nil ? "clock" : "bell"
                )
            }
            Button(role: .destructive) {
                Task { await model.deleteThread(thread.id) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var sidebarIndex: DailyUXSidebarIndex {
        DailyUXSidebarIndex(
            snapshot: model.snapshot,
            query: searchText,
            projectID: selectedProjectID
        )
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

private struct ProjectFilterRow: View {
    let project: FeatureProject?
    let totalCount: Int

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(project?.name ?? "All projects")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                Text(project?.path ?? "Filter tasks by repository")
                    .font(.caption2)
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
            }
            Spacer()
            if totalCount > 0 {
                Text("\(totalCount)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(T3Colors.textTertiary)
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(T3Colors.textTertiary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct FeatureThreadRow: View {
    let thread: FeatureThread
    let projectName: String?

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: statusIcon)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(statusColor)
                .frame(width: 10, height: 18)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(thread.title)
                        .font(.subheadline.weight(thread.needsAttention ? .semibold : .regular))
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(thread.updatedAt, format: .relative(presentation: .numeric))
                        .font(.system(size: 10))
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(1)
                }
                HStack(spacing: 5) {
                    if let projectName {
                        Text(projectName)
                    }
                    if let preview = thread.preview, !preview.isEmpty {
                        if projectName != nil { Text("·") }
                        Text(preview)
                    } else if thread.needsAttention {
                        if projectName != nil { Text("·") }
                        Text(statusText)
                    }
                }
                .font(.caption)
                .foregroundStyle(thread.needsAttention ? statusColor : T3Colors.textSecondary)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(statusText)
    }

    private var statusIcon: String {
        switch thread.state {
        case .idle, .completed: "circle.fill"
        case .queued, .working: "bolt.fill"
        case .waitingForApproval: "exclamationmark.circle.fill"
        case .waitingForInput: "questionmark.circle.fill"
        case .failed: "xmark.circle.fill"
        }
    }

    private var statusColor: Color {
        switch thread.state {
        case .idle, .completed: T3Colors.textTertiary
        case .queued: T3Colors.accent
        case .working: .cyan
        case .waitingForApproval: T3Colors.warning
        case .waitingForInput: .indigo
        case .failed: T3Colors.danger
        }
    }

    private var statusText: String {
        switch thread.state {
        case .waitingForApproval: "Approval needed"
        case .waitingForInput: "Answer needed"
        case .working: "Working"
        case .queued: "Queued"
        case .failed: "Failed"
        case .idle, .completed: thread.state.rawValue.capitalized
        }
    }
}
