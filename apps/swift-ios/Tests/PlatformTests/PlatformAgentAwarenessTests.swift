import Foundation
import Testing
@testable import T3Code

@Suite("Agent awareness projection")
struct PlatformAgentAwarenessTests {
    @Test
    func legacySettingsEnableLiveActivitiesWithoutResettingOtherPreferences() throws {
        let legacy = Data(
            #"{"appearance":"system","hapticsEnabled":false,"notificationsEnabled":false}"#.utf8
        )
        let decoded = try JSONDecoder.t3.decode(FeatureSettings.self, from: legacy)

        #expect(decoded.appearance == .system)
        #expect(!decoded.hapticsEnabled)
        #expect(!decoded.notificationsEnabled)
        #expect(decoded.liveActivitiesEnabled)

        var disabled = decoded
        disabled.liveActivitiesEnabled = false
        let roundTrip = try JSONDecoder.t3.decode(
            FeatureSettings.self,
            from: JSONEncoder.t3.encode(disabled)
        )
        #expect(!roundTrip.liveActivitiesEnabled)
    }

    @Test
    func ranksAttentionThenFailuresThenWorkAndDropsOldTerminalRows() throws {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let project = FeatureProject(
            id: "project",
            wireID: "project-wire",
            environmentID: "environment",
            name: "t3code",
            path: "/repo"
        )
        let snapshot = FeatureSnapshot(
            projects: [project],
            threads: [
                Self.thread(
                    id: "working",
                    state: .working,
                    updatedAt: now.addingTimeInterval(-10)
                ),
                Self.thread(
                    id: "approval",
                    state: .waitingForApproval,
                    updatedAt: now.addingTimeInterval(-5)
                ),
                Self.thread(
                    id: "failure",
                    state: .failed,
                    updatedAt: now.addingTimeInterval(-20)
                ),
                Self.thread(
                    id: "old-complete",
                    state: .completed,
                    updatedAt: now.addingTimeInterval(-3_600)
                ),
            ],
            providersByEnvironment: [
                "environment": [
                    FeatureProvider(
                        id: "claude",
                        name: "Claude",
                        models: [FeatureModel(id: "claude-opus-5", name: "Opus 5")]
                    ),
                ],
            ]
        )

        let aggregate = PlatformAgentAwarenessProjection.aggregate(
            snapshot: snapshot,
            now: now
        )

        #expect(aggregate.activeCount == 2)
        #expect(aggregate.subtitle == "1 task needs attention")
        #expect(aggregate.activities.map(\.threadId) == ["approval", "failure", "working"])
        #expect(aggregate.activities.first?.modelTitle == "Opus 5")
        #expect(
            aggregate.activities.first?.nativeDeepLinkURL?.scheme
                == PlatformRoute.nativeScheme
        )
    }

    @Test
    func widgetSnapshotUsesTheSameBoundedRowsAsTheLiveActivity() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let project = FeatureProject(
            id: "project",
            environmentID: "environment",
            name: "t3code",
            path: "/repo"
        )
        let threads = (0..<8).map { index in
            Self.thread(
                id: "thread-\(index)",
                state: .working,
                updatedAt: now.addingTimeInterval(TimeInterval(-index))
            )
        }
        let snapshot = FeatureSnapshot(projects: [project], threads: threads)

        let aggregate = PlatformAgentAwarenessProjection.aggregate(
            snapshot: snapshot,
            now: now
        )
        let widget = PlatformAgentAwarenessProjection.widgetSnapshot(
            snapshot: snapshot,
            now: now
        )

        #expect(aggregate.activities.count == PlatformAgentAwarenessProjection.maximumRows)
        #expect(widget.tasks == aggregate.activities)
        #expect(widget.updatedAt == aggregate.updatedAt)
    }

    private static func thread(
        id: String,
        state: FeatureThreadState,
        updatedAt: Date
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            wireID: id,
            projectID: "project",
            environmentID: "environment",
            title: "Task \(id)",
            updatedAt: updatedAt,
            state: state,
            providerID: "claude",
            modelID: "claude-opus-5"
        )
    }
}
