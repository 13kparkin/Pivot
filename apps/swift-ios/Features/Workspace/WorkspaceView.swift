import SwiftUI

public struct WorkspaceView: View {
    @Bindable var model: FeatureRootModel
    @State private var selectedThreadID: String?
    @State private var searchText = ""
    @State private var showingNewThread = false
    @State private var showingAddProject = false
    @State private var showingSettings = false
    @State private var showingArchived = false
    @State private var renamingThread: FeatureThread?
    @State private var renameTitle = ""

    public init(model: FeatureRootModel) {
        self.model = model
    }

    public var body: some View {
        NavigationSplitView {
            List(selection: $selectedThreadID) {
                connectionSection
                projectSection
                threadSection
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .searchable(text: $searchText, prompt: "Search threads")
            .navigationTitle("T3 Code")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        showingAddProject = true
                    } label: {
                        Image(systemName: "folder.badge.plus")
                    }
                    .accessibilityLabel("Add project")
                    Button {
                        showingNewThread = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .accessibilityLabel("New thread")
                    .disabled(model.snapshot.projects.isEmpty)
                }
            }
        } detail: {
            if let id = selectedThreadID,
               let thread = model.snapshot.threads.first(where: { $0.id == id }) {
                ThreadDetailView(model: model, thread: thread)
                    .id(id)
            } else {
                ContentUnavailableView(
                    "Choose a thread",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Select a thread or start a new task.")
                )
                .background(Color.black)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $showingNewThread) {
            NewThreadView(model: model) { thread in
                selectedThreadID = thread.id
                showingNewThread = false
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

    @ViewBuilder
    private var connectionSection: some View {
        Section {
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
            } label: {
                HStack(spacing: 9) {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 7, height: 7)
                    Text(model.snapshot.connection.environmentName ?? "Connected")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer()
                    if model.snapshot.environments.count > 1 {
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var projectSection: some View {
        Section("Projects") {
            if model.snapshot.projects.isEmpty {
                Text("No projects")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.snapshot.projects) { project in
                    HStack(spacing: 10) {
                        Image(systemName: "folder")
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(project.name)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                            Text(project.path)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        Text("\(activeThreads.filter { $0.projectID == project.id }.count)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder
    private var threadSection: some View {
        Section {
            if filteredThreads.isEmpty {
                Text(searchText.isEmpty ? "No active threads" : "No results")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(filteredThreads) { thread in
                NavigationLink(value: thread.id) {
                    FeatureThreadRow(
                        thread: thread,
                        projectName: projectName(for: thread.projectID)
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
                    Button {
                        Task { await model.setSettled(thread.id, settled: !thread.isSettled) }
                    } label: {
                        Label(
                            thread.isSettled ? "Reopen" : "Mark done",
                            systemImage: thread.isSettled ? "arrow.counterclockwise" : "checkmark"
                        )
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

            Button {
                showingArchived = true
            } label: {
                Label("Archived", systemImage: "archivebox")
                    .font(.subheadline)
            }
        } header: {
            Text("Threads")
        }
    }

    private var activeThreads: [FeatureThread] {
        model.snapshot.threads
            .filter { !$0.isArchived }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private var filteredThreads: [FeatureThread] {
        guard !searchText.isEmpty else { return activeThreads }
        return activeThreads.filter {
            $0.title.localizedCaseInsensitiveContains(searchText)
                || ($0.preview?.localizedCaseInsensitiveContains(searchText) ?? false)
                || projectName(for: $0.projectID).localizedCaseInsensitiveContains(searchText)
        }
    }

    private func projectName(for id: String) -> String {
        model.snapshot.projects.first(where: { $0.id == id })?.name ?? "Unknown project"
    }
}

struct FeatureThreadRow: View {
    let thread: FeatureThread
    let projectName: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Text(projectName)
                    if let preview = thread.preview, !preview.isEmpty {
                        Text("·")
                        Text(preview)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(statusText)
    }

    private var statusColor: Color {
        switch thread.state {
        case .idle, .completed: .gray
        case .queued: .blue
        case .working: .cyan
        case .waitingForApproval: .orange
        case .waitingForInput: .indigo
        case .failed: .red
        }
    }

    private var statusText: String {
        switch thread.state {
        case .waitingForApproval: "Waiting for approval"
        case .waitingForInput: "Waiting for input"
        default: thread.state.rawValue
        }
    }
}
