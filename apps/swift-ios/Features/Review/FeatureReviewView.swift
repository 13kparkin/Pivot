import SwiftUI

public struct FeatureReviewView: View {
    let client: any FeatureClient
    let threadID: String

    @State private var review: FeatureReview?
    @State private var isLoading = true
    @State private var errorMessage: String?

    public init(client: any FeatureClient, threadID: String) {
        self.client = client
        self.threadID = threadID
    }

    public var body: some View {
        Group {
            if isLoading, review == nil {
                ProgressView("Loading changes…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let review {
                reviewList(review)
            } else {
                ContentUnavailableView(
                    "Review unavailable",
                    systemImage: "doc.text.magnifyingglass",
                    description: Text(errorMessage ?? "Changes could not be loaded.")
                )
            }
        }
        .background(Color.black)
        .navigationTitle("Review")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Reload changes")
            }
        }
        .task { await load() }
    }

    private func reviewList(_ review: FeatureReview) -> some View {
        List {
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(review.title)
                            .font(T3Typography.navigationTitle)
                        if let base = review.baseReference {
                            Text(base)
                                .font(T3Typography.tool)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                    Spacer()
                    FeatureDiffStatsLabel(additions: review.additions, deletions: review.deletions)
                }
                .padding(.vertical, 3)

                if review.isTruncated {
                    Label("Large diff, showing a partial result", systemImage: "exclamationmark.triangle")
                        .font(T3Typography.supporting)
                        .foregroundStyle(.orange)
                }
            }

            Section("\(review.files.count) changed \(review.files.count == 1 ? "file" : "files")") {
                if review.files.isEmpty {
                    ContentUnavailableView(
                        "No changes",
                        systemImage: "checkmark.circle",
                        description: Text("The working tree is clean.")
                    )
                    .listRowBackground(Color.clear)
                }
                ForEach(review.files) { file in
                    NavigationLink {
                        FeatureDiffView(file: file)
                    } label: {
                        FeatureReviewFileRow(file: file)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            review = try await client.loadReview(threadID: threadID)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct FeatureReviewFileRow: View {
    let file: FeatureReviewFile

    var body: some View {
        HStack(spacing: 10) {
            Text(changeLabel)
                .font(.caption2.monospaced().weight(.bold))
                .foregroundStyle(changeColor)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(fileName)
                    .font(T3Typography.homeTitle)
                    .lineLimit(1)
                if !directory.isEmpty {
                    Text(directory)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            FeatureDiffStatsLabel(additions: file.additions, deletions: file.deletions)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var fileName: String {
        file.path.split(separator: "/").last.map(String.init) ?? file.path
    }

    private var directory: String {
        let components = file.path.split(separator: "/")
        return components.dropLast().joined(separator: "/")
    }

    private var changeLabel: String {
        switch file.change {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .binary: "B"
        }
    }

    private var changeColor: Color {
        switch file.change {
        case .added: .green
        case .deleted: .red
        case .renamed: .blue
        case .modified, .binary: .orange
        }
    }
}

struct FeatureDiffStatsLabel: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 5) {
            if additions > 0 {
                Text("+\(additions)").foregroundStyle(.green)
            }
            if deletions > 0 {
                Text("−\(deletions)").foregroundStyle(.red)
            }
        }
        .font(T3Typography.tool.monospacedDigit().weight(.medium))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(additions) additions, \(deletions) deletions")
    }
}

private struct FeatureDiffView: View {
    let file: FeatureReviewFile

    var body: some View {
        Group {
            if file.lines.isEmpty {
                ContentUnavailableView(
                    file.change == .binary ? "Binary file" : "Diff unavailable",
                    systemImage: file.change == .binary ? "doc.richtext" : "doc.text.magnifyingglass",
                    description: Text("No line-level preview is available.")
                )
            } else {
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(file.lines) { line in
                            FeatureDiffLineRow(line: line)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
        }
        .background(Color.black)
        .navigationTitle(file.path.split(separator: "/").last.map(String.init) ?? file.path)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct FeatureDiffLineRow: View {
    let line: FeatureDiffLine

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if line.kind == .hunk {
                Text(line.text)
                    .foregroundStyle(.blue)
                    .padding(.horizontal, 10)
            } else {
                lineNumber(line.oldLine)
                lineNumber(line.newLine)
                Text(prefix)
                    .foregroundStyle(prefixColor)
                    .frame(width: 18)
                Text(line.text.isEmpty ? " " : line.text)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .padding(.trailing, 12)
            }
        }
        .font(T3Typography.code)
        .frame(minHeight: line.kind == .hunk ? 30 : 22, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
    }

    private func lineNumber(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "")
            .foregroundStyle(.tertiary)
            .frame(width: 48, alignment: .trailing)
            .padding(.trailing, 7)
            .accessibilityHidden(true)
    }

    private var prefix: String {
        switch line.kind {
        case .addition: "+"
        case .deletion: "−"
        case .context, .hunk: " "
        }
    }

    private var prefixColor: Color {
        switch line.kind {
        case .addition: .green
        case .deletion: .red
        case .context, .hunk: .secondary
        }
    }

    private var background: Color {
        switch line.kind {
        case .addition: Color.green.opacity(0.11)
        case .deletion: Color.red.opacity(0.11)
        case .hunk: Color.blue.opacity(0.08)
        case .context: Color.clear
        }
    }
}
