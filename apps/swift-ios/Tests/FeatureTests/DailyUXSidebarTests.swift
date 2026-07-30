import Foundation
import Testing
@testable import T3Code

@Suite("Sidebar v2")
struct DailyUXSidebarTests {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    @Test
    func activeOrderUsesCreationTimeAndDoesNotJumpWithActivity() {
        let olderCreationRecentActivity = thread(
            id: "old",
            created: -500,
            updated: -5,
            state: .working
        )
        let newerCreationOlderActivity = thread(
            id: "new",
            created: -100,
            updated: -80,
            state: .working
        )

        let index = makeIndex([olderCreationRecentActivity, newerCreationOlderActivity])

        #expect(index.active.map(\.id) == ["new", "old"])
    }

    @Test
    func settledUsesExplicitStateOrThreeDayRestingAge() {
        let explicitlySettled = thread(
            id: "explicit",
            created: -10,
            updated: -10,
            state: .idle,
            isSettled: true
        )
        let resting = thread(
            id: "resting",
            created: -400_000,
            updated: -300_000,
            state: .idle
        )
        let oldButWorking = thread(
            id: "working",
            created: -400_000,
            updated: -300_000,
            state: .working
        )
        let settledButWorking = thread(
            id: "settled-working",
            created: -400_000,
            updated: -300_000,
            state: .working,
            isSettled: true
        )
        let oldButWaiting = thread(
            id: "waiting",
            created: -400_000,
            updated: -300_000,
            state: .waitingForApproval
        )

        let index = makeIndex([
            explicitlySettled,
            resting,
            oldButWorking,
            settledButWorking,
            oldButWaiting,
        ])

        #expect(Set(index.settled.map(\.id)) == ["explicit", "resting"])
        #expect(Set(index.active.map(\.id)) == ["working", "settled-working", "waiting"])
    }

    @Test
    func snoozedAndArchivedThreadsStayOutOfBothBlocks() {
        var snoozed = thread(id: "snoozed", created: -20, updated: -10)
        snoozed.snoozedUntil = now.addingTimeInterval(3_600)
        var archived = thread(id: "archived", created: -30, updated: -20)
        archived.isArchived = true
        let visible = thread(id: "visible", created: -10, updated: -5)

        let index = makeIndex([snoozed, archived, visible])

        #expect(index.active.map(\.id) == ["visible"])
        #expect(index.settled.isEmpty)
    }

    @Test
    func projectFilterAndSearchUseRepositoryContext() {
        let projects = [
            FeatureProject(id: "p1", environmentID: "e", name: "Mobile", path: "/work/mobile"),
            FeatureProject(id: "p2", environmentID: "e", name: "Server", path: "/work/server"),
        ]
        let mobile = thread(id: "mobile", projectID: "p1", title: "Polish picker", created: -10, updated: -5)
        let server = thread(id: "server", projectID: "p2", title: "Compression", created: -20, updated: -5)
        let snapshot = FeatureSnapshot(projects: projects, threads: [mobile, server])

        let filtered = DailyUXSidebarIndex(snapshot: snapshot, query: "", projectID: "p1", now: now)
        let searched = DailyUXSidebarIndex(snapshot: snapshot, query: "server", now: now)

        #expect(filtered.active.map(\.id) == ["mobile"])
        #expect(searched.searchResults.map(\.id) == ["server"])
    }

    private func makeIndex(_ threads: [FeatureThread]) -> DailyUXSidebarIndex {
        DailyUXSidebarIndex(
            snapshot: FeatureSnapshot(threads: threads),
            query: "",
            now: now
        )
    }

    private func thread(
        id: String,
        projectID: String = "project",
        title: String = "Task",
        created: TimeInterval,
        updated: TimeInterval,
        state: FeatureThreadState = .idle,
        isSettled: Bool = false
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: projectID,
            title: title,
            createdAt: now.addingTimeInterval(created),
            updatedAt: now.addingTimeInterval(updated),
            state: state,
            isSettled: isSettled
        )
    }
}
