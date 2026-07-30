import Testing
@testable import T3Code

@Suite("Thread tool state")
struct FeatureToolStateTests {
    @Test
    func fileFilteringKeepsDirectoriesFirstAndHonorsHiddenFiles() {
        let entries = [
            FeatureFileEntry(path: "z.swift", name: "z.swift", kind: .file),
            FeatureFileEntry(path: ".env", name: ".env", kind: .file, isHidden: true),
            FeatureFileEntry(path: "Sources", name: "Sources", kind: .directory),
            FeatureFileEntry(path: "a.swift", name: "a.swift", kind: .file),
        ]

        #expect(entries.featureFiltered(by: "", includesHidden: false).map(\.name) == [
            "Sources", "a.swift", "z.swift",
        ])
        #expect(entries.featureFiltered(by: "env", includesHidden: true).map(\.name) == [".env"])
    }

    @Test
    func reviewTotalsAggregateAcrossFiles() {
        let review = FeatureReview(files: [
            FeatureReviewFile(path: "a.swift", change: .modified, additions: 4, deletions: 1),
            FeatureReviewFile(path: "b.swift", change: .added, additions: 8, deletions: 0),
        ])

        #expect(review.additions == 12)
        #expect(review.deletions == 1)
    }

    @Test
    func sourceControlActionsReflectRepositoryState() {
        let clean = FeatureSourceControlStatus(branch: "main")
        #expect(clean.availableActions == [.createPullRequest])

        let changed = FeatureSourceControlStatus(
            branch: "feature/native",
            aheadCount: 2,
            behindCount: 1,
            files: [.init(path: "App.swift", state: .modified, isStaged: false)]
        )
        #expect(changed.availableActions.contains(.commit))
        #expect(changed.availableActions.contains(.push))
        #expect(changed.availableActions.contains(.pull))
        #expect(changed.availableActions.contains(.commitPushAndCreatePullRequest))

        var busy = changed
        busy.isBusy = true
        #expect(busy.availableActions.isEmpty)
    }

    @Test
    func terminalPlainTextDropsControlSequences() {
        let prompt = "\u{1B}]0;workspace\u{7}\u{1B}[38;5;221mx\u{8}repo\u{1B}[39m ❯ "
        #expect(NativeWorkspaceMapper.terminalText(prompt) == "repo ❯ ")
    }
}
