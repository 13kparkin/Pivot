import SwiftUI
import UIKit

/// Native chat Markdown with block-aware layout and Foundation inline parsing.
struct MarkdownMessageView: View {
    private struct RenderRequest: Hashable {
        let revision: MarkdownContentRevision
        let isStreaming: Bool
    }

    private let source: String
    private let revision: MarkdownContentRevision
    private let isStreaming: Bool
    @State private var renderedDocument: MarkdownRenderedDocument?
    @State private var isSelectingText = false

    init(_ source: String, isStreaming: Bool = false) {
        self.source = source
        self.isStreaming = isStreaming
        let revision = MarkdownContentRevision(source)
        self.revision = revision
        _renderedDocument = State(
            initialValue: MarkdownRenderCache.shared.cachedDocument(for: revision)
        )
    }

    var body: some View {
        Group {
            if let renderedDocument, renderedDocument.revision == revision {
                MarkdownBlocksView(blocks: renderedDocument.blocks)
            } else {
                // Parsing waits briefly so token-by-token streaming cancels stale revisions
                // instead of scheduling work for content the user will never see.
                Text(verbatim: source)
                    .font(T3Typography.threadBody)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .modifier(MarkdownTextSelectionModifier(isEnabled: isSelectingText))
        .contextMenu {
            Button {
                isSelectingText.toggle()
            } label: {
                Label(
                    isSelectingText ? "Done selecting" : "Select text",
                    systemImage: isSelectingText ? "checkmark" : "text.cursor"
                )
            }
            Button {
                UIPasteboard.general.string = source
            } label: {
                Label("Copy message", systemImage: "doc.on.doc")
            }
        }
        .accessibilityAction(named: "Copy message") {
            UIPasteboard.general.string = source
        }
        .task(id: RenderRequest(revision: revision, isStreaming: isStreaming)) {
            if let cached = MarkdownRenderCache.shared.cachedDocument(for: revision) {
                renderedDocument = cached
                return
            }

            do {
                try await Task.sleep(for: .milliseconds(isStreaming ? 200 : 40))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }

            guard let rendered = await MarkdownRenderCache.shared.document(for: revision),
                  !Task.isCancelled,
                  rendered.revision == revision else {
                return
            }
            renderedDocument = rendered
        }
    }
}

private struct MarkdownTextSelectionModifier: ViewModifier {
    let isEnabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content.textSelection(.enabled)
        } else {
            content
        }
    }
}

private struct MarkdownBlocksView: View {
    let blocks: [MarkdownRenderedBlock]
    var spacing: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(blocks.indices, id: \.self) { index in
                MarkdownBlockView(block: blocks[index])
            }
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownRenderedBlock

    @ViewBuilder
    var body: some View {
        switch block {
        case let .paragraph(inline):
            MarkdownInlineText(inline)
                .lineSpacing(4)

        case let .heading(level, inline):
            MarkdownInlineText(inline)
                .padding(.top, level <= 2 ? 3 : 1)

        case let .unorderedList(items):
            MarkdownListView(items: items, start: nil)

        case let .orderedList(start, items):
            MarkdownListView(items: items, start: start)

        case let .blockquote(blocks):
            MarkdownBlocksView(blocks: blocks, spacing: 9)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(T3Colors.textTertiary)
                        .frame(width: 2)
                }

        case let .codeBlock(language, code):
            MarkdownCodeBlockView(language: language, code: code)

        case .thematicBreak:
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)
                .padding(.vertical, 2)
                .accessibilityHidden(true)
        }
    }
}

private struct MarkdownListView: View {
    let items: [MarkdownRenderedListItem]
    let start: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items.indices, id: \.self) { offset in
                let item = items[offset]
                HStack(alignment: .top, spacing: 8) {
                    marker(for: item, offset: offset)
                        .frame(width: 24, height: 24, alignment: .trailing)
                    MarkdownBlocksView(blocks: item.blocks, spacing: 7)
                }
                .accessibilityElement(children: .contain)
            }
        }
    }

    @ViewBuilder
    private func marker(for item: MarkdownRenderedListItem, offset: Int) -> some View {
        if let task = item.task {
            Image(systemName: task == .complete ? "checkmark.square.fill" : "square")
                .font(T3Typography.control)
                .foregroundStyle(
                    task == .complete ? T3Colors.success : T3Colors.textSecondary
                )
                .accessibilityLabel(task == .complete ? "Completed" : "Not completed")
        } else if let start {
            Text("\(start + offset).")
                .font(T3Typography.supporting.monospaced())
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityLabel("Item \(start + offset)")
        } else {
            Text("•")
                .font(T3Typography.threadBody.weight(.semibold))
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityHidden(true)
        }
    }
}

private struct MarkdownCodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let language, !language.isEmpty {
                    Text(language.uppercased())
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                } else {
                    Text("CODE")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                }
                Spacer(minLength: 8)
                Button {
                    UIPasteboard.general.string = code
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(minHeight: 32)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Copies this code block")
            }
            .padding(.horizontal, 13)
            .frame(minHeight: 40)

            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)

            ScrollView(.horizontal) {
                Text(verbatim: code)
                    .font(T3Typography.code)
                    .foregroundStyle(T3Colors.textPrimary.opacity(0.94))
                    .lineSpacing(3)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(13)
            }
            .scrollIndicators(.hidden)
        }
        .background(T3Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(T3Colors.border, lineWidth: 1)
        }
    }
}

private struct MarkdownInlineText: View {
    private let attributedText: AttributedString
    private let font: Font

    init(_ rendered: MarkdownRenderedInline) {
        attributedText = rendered.attributedText
        font = rendered.style.font
    }

    var body: some View {
        Text(attributedText)
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
    }
}

enum MarkdownInlineFormatter {
    static func format(_ source: String, baseFont: Font = .body) -> AttributedString {
        var attributed = (
            try? AttributedString(
                markdown: source,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            )
        ) ?? AttributedString(source)

        let styles = attributed.runs.map { run in
            (run.range, run.inlinePresentationIntent, run.link)
        }
        for (range, intent, link) in styles {
            if intent?.contains(.code) == true {
                attributed[range].font = baseFont.monospaced()
                attributed[range].foregroundColor = T3Colors.textPrimary.opacity(0.9)
                attributed[range].backgroundColor = T3Colors.surfaceRaised
            }
            if link != nil {
                attributed[range].foregroundColor = T3Colors.accent
            }
        }
        return attributed
    }
}
