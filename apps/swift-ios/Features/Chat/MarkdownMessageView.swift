import SwiftUI
import UIKit

/// Native chat Markdown with block-aware layout and Foundation inline parsing.
struct MarkdownMessageView: View {
    private let source: String
    private let document: MarkdownDocument

    init(_ source: String) {
        self.source = source
        document = MarkdownDocument(parsing: source)
    }

    var body: some View {
        MarkdownBlocksView(blocks: document.blocks)
            .textSelection(.enabled)
            .contextMenu {
                Button {
                    UIPasteboard.general.string = source
                } label: {
                    Label("Copy message", systemImage: "doc.on.doc")
                }
            }
            .accessibilityAction(named: "Copy message") {
                UIPasteboard.general.string = source
            }
    }
}

private struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlock]
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
    let block: MarkdownBlock

    @ViewBuilder
    var body: some View {
        switch block {
        case let .paragraph(text):
            MarkdownInlineText(text, font: T3Typography.threadBody)
                .lineSpacing(4)

        case let .heading(level, text):
            MarkdownInlineText(text, font: headingFont(level))
                .padding(.top, level <= 2 ? 3 : 1)

        case let .unorderedList(items):
            MarkdownListView(items: items, start: nil)

        case let .orderedList(start, items):
            MarkdownListView(items: items, start: start)

        case let .blockquote(document):
            MarkdownBlocksView(blocks: document.blocks, spacing: 9)
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

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: T3Typography.threadHeading1
        case 2: T3Typography.threadHeading2
        case 3: T3Typography.threadHeading3
        default: T3Typography.threadHeading4
        }
    }
}

private struct MarkdownListView: View {
    let items: [MarkdownListItem]
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
    private func marker(for item: MarkdownListItem, offset: Int) -> some View {
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
                    .textSelection(.enabled)
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

    init(_ source: String, font: Font) {
        self.font = font
        attributedText = MarkdownInlineFormatter.format(source, baseFont: font)
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
