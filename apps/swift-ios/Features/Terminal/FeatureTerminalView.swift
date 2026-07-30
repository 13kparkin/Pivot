import SwiftUI

public struct FeatureTerminalView: View {
    let client: any FeatureClient
    let threadID: String

    @State private var terminal: FeatureTerminalSnapshot?
    @State private var input = ""
    @State private var isLoading = true
    @State private var errorMessage: String?
    @FocusState private var inputFocused: Bool

    public init(client: any FeatureClient, threadID: String) {
        self.client = client
        self.threadID = threadID
    }

    public var body: some View {
        VStack(spacing: 0) {
            terminalHeader
            Divider()
            terminalBuffer
            terminalControls
        }
        .background(Color.black)
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadAndOpen() }
        .task {
            for await update in client.terminalEvents(threadID: threadID) {
                terminal = update
            }
        }
    }

    private var terminalHeader: some View {
        HStack(spacing: 9) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(terminal?.title ?? "Terminal")
                    .font(.subheadline.weight(.semibold))
                Text(terminal?.workingDirectory ?? statusLabel)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if terminal?.state == .running {
                Button("Stop", role: .destructive) {
                    Task { await stop() }
                }
                .font(.footnote.weight(.semibold))
            } else {
                Button("Start") {
                    Task { await open() }
                }
                .font(.footnote.weight(.semibold))
                .disabled(isLoading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
    }

    @ViewBuilder
    private var terminalBuffer: some View {
        if isLoading, terminal == nil {
            ProgressView("Opening terminal…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage, terminal == nil {
            ContentUnavailableView(
                "Terminal unavailable",
                systemImage: "terminal",
                description: Text(errorMessage)
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    Text(terminal?.buffer.isEmpty == false ? terminal?.buffer ?? "" : " ")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Color(white: 0.86))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, minHeight: 300, alignment: .topLeading)
                        .padding(12)
                        .id("terminal-end")
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: terminal?.buffer) {
                    proxy.scrollTo("terminal-end", anchor: .bottom)
                }
            }
        }
    }

    private var terminalControls: some View {
        VStack(spacing: 7) {
            HStack(spacing: 7) {
                terminalKey("ctrl-c", label: "^C", data: "\u{3}")
                terminalKey("escape", label: "esc", data: "\u{1B}")
                terminalKey("tab", label: "tab", data: "\t")
                Spacer()
            }
            HStack(spacing: 8) {
                TextField("Command", text: $input)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($inputFocused)
                    .submitLabel(.send)
                    .onSubmit(sendCommand)
                    .padding(.horizontal, 11)
                    .frame(minHeight: 40)
                    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
                Button(action: sendCommand) {
                    Image(systemName: "return")
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.borderedProminent)
                .tint(.white)
                .foregroundStyle(.black)
                .disabled(!isRunning || input.isEmpty)
                .accessibilityLabel("Send command")
            }
        }
        .padding(10)
        .background(Color(white: 0.025))
        .overlay(alignment: .top) { Divider() }
    }

    private func terminalKey(_ id: String, label: String, data: String) -> some View {
        Button(label) {
            Task { await write(data) }
        }
        .font(.caption.monospaced().weight(.medium))
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(!isRunning)
        .accessibilityIdentifier("terminal-\(id)")
    }

    private var isRunning: Bool { terminal?.state == .running }

    private var statusColor: Color {
        switch terminal?.state {
        case .running: .green
        case .starting: .orange
        case .failed: .red
        case .exited, .stopped, nil: .gray
        }
    }

    private var statusLabel: String {
        terminal?.state.rawValue.capitalized ?? "Not connected"
    }

    private func loadAndOpen() async {
        isLoading = true
        defer { isLoading = false }
        do {
            terminal = try await client.terminalSnapshot(threadID: threadID)
            if terminal?.state == .stopped || terminal?.state == .exited {
                try await client.openTerminal(threadID: threadID, columns: 80, rows: 24)
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func open() async {
        do {
            try await client.openTerminal(threadID: threadID, columns: 80, rows: 24)
            terminal = try await client.terminalSnapshot(threadID: threadID)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func stop() async {
        do {
            try await client.closeTerminal(threadID: threadID)
            terminal = try? await client.terminalSnapshot(threadID: threadID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func sendCommand() {
        guard isRunning, !input.isEmpty else { return }
        let command = input
        input = ""
        Task {
            await write(command + "\n")
            inputFocused = true
        }
    }

    private func write(_ data: String) async {
        do {
            try await client.writeTerminal(threadID: threadID, data: data)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
