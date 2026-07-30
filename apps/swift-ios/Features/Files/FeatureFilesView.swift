import SwiftUI

public struct FeatureFilesView: View {
    let client: any FeatureClient
    let threadID: String

    public init(client: any FeatureClient, threadID: String) {
        self.client = client
        self.threadID = threadID
    }

    public var body: some View {
        FeatureFileDirectoryView(client: client, threadID: threadID, path: nil, title: "Files")
            .background(Color.black)
    }
}

private struct FeatureFileDirectoryView: View {
    let client: any FeatureClient
    let threadID: String
    let path: String?
    let title: String

    @State private var entries: [FeatureFileEntry] = []
    @State private var searchText = ""
    @State private var includesHidden = false
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading, entries.isEmpty {
                ProgressView("Loading files…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage, entries.isEmpty {
                ContentUnavailableView(
                    "Files unavailable",
                    systemImage: "folder.badge.questionmark",
                    description: Text(errorMessage)
                )
            } else if filteredEntries.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "Empty folder" : "No matches",
                    systemImage: "folder",
                    description: Text(searchText.isEmpty ? "This folder has no visible files." : "Try another search.")
                )
            } else {
                List(filteredEntries) { entry in
                    NavigationLink {
                        destination(for: entry)
                    } label: {
                        FeatureFileRow(entry: entry)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .refreshable { await load() }
            }
        }
        .background(Color.black)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Filter files")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("Show hidden files", isOn: $includesHidden)
                    Button {
                        Task { await load() }
                    } label: {
                        Label("Reload", systemImage: "arrow.clockwise")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("File browser options")
            }
        }
        .task(id: path) { await load() }
    }

    @ViewBuilder
    private func destination(for entry: FeatureFileEntry) -> some View {
        if entry.kind == .directory {
            FeatureFileDirectoryView(
                client: client,
                threadID: threadID,
                path: entry.path,
                title: entry.name
            )
        } else {
            FeatureFilePreviewView(client: client, threadID: threadID, entry: entry)
        }
    }

    private var filteredEntries: [FeatureFileEntry] {
        entries.featureFiltered(by: searchText, includesHidden: includesHidden)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            entries = try await client.listFiles(threadID: threadID, path: path)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct FeatureFileRow: View {
    let entry: FeatureFileEntry

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(entry.kind == .directory ? .blue : .secondary)
                .frame(width: 20)
            Text(entry.name)
                .font(.subheadline)
                .lineLimit(1)
            Spacer()
            if let size = entry.sizeBytes, entry.kind != .directory {
                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch entry.kind {
        case .directory: "folder.fill"
        case .symbolicLink: "link"
        case .file:
            entry.name.hasSuffix(".swift") ? "swift" : "doc.text"
        }
    }
}

private struct FeatureFilePreviewView: View {
    let client: any FeatureClient
    let threadID: String
    let entry: FeatureFileEntry

    @State private var content: FeatureFileContent?
    @State private var errorMessage: String?
    @State private var isLoading = true

    var body: some View {
        Group {
            if isLoading, content == nil {
                ProgressView("Loading file…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let content {
                VStack(spacing: 0) {
                    if content.isTruncated {
                        Label("Partial preview", systemImage: "exclamationmark.triangle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.orange.opacity(0.09))
                    }
                    FeatureSourceTextView(text: content.text)
                }
            } else {
                ContentUnavailableView(
                    "File unavailable",
                    systemImage: "doc.badge.ellipsis",
                    description: Text(errorMessage ?? "The file could not be read.")
                )
            }
        }
        .background(Color.black)
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let content {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: content.text) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share file contents")
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            content = try await client.readFile(threadID: threadID, path: entry.path)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct FeatureSourceTextView: View {
    let text: String

    private var lines: [Substring] {
        text.split(separator: "\n", omittingEmptySubsequences: false)
    }

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .top, spacing: 10) {
                        Text("\(index + 1)")
                            .foregroundStyle(.tertiary)
                            .frame(width: 38, alignment: .trailing)
                            .accessibilityHidden(true)
                        Text(String(line).isEmpty ? " " : String(line))
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                    }
                    .font(.system(size: 12, design: .monospaced))
                    .frame(minHeight: 19)
                }
            }
            .padding(.vertical, 10)
            .padding(.trailing, 14)
        }
        .background(Color.black)
        .accessibilityLabel("Source file")
    }
}
