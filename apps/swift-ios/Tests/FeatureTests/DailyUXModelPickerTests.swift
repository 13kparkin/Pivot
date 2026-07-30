import Foundation
import Testing
@testable import T3Code

@Suite("Model picker")
struct DailyUXModelPickerTests {
    @Test
    func catalogPreservesFavoritesRecentsAndProviderGroups() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    FeatureModel(id: "gpt-5", name: "GPT-5", supportsImages: true),
                    FeatureModel(id: "gpt-5-mini", name: "GPT-5 Mini"),
                ]
            ),
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [FeatureModel(id: "sonnet", name: "Sonnet", supportsReasoning: true)]
            ),
        ]
        let favorite = DailyUXModelOption.key(providerID: "claude", modelID: "sonnet")
        let recent = DailyUXModelOption.key(providerID: "codex", modelID: "gpt-5")

        let catalog = DailyUXModelCatalog(
            providers: providers,
            query: "",
            favoriteIDs: [favorite],
            recentIDs: [recent]
        )

        #expect(catalog.favorites.map(\.id) == [favorite])
        #expect(catalog.recents.map(\.id) == [recent])
        #expect(catalog.providerGroups.map(\.provider.id) == ["codex", "claude"])
    }

    @Test
    func searchIncludesCapabilitiesAndProviderNames() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    FeatureModel(id: "vision", name: "Visual", supportsImages: true),
                    FeatureModel(id: "plain", name: "Plain"),
                ]
            ),
        ]

        let catalog = DailyUXModelCatalog(
            providers: providers,
            query: "images",
            favoriteIDs: [],
            recentIDs: []
        )

        #expect(catalog.all.map(\.model.id) == ["vision"])
    }

    @Test
    func optionDefaultsUseTypedDescriptorDefaults() {
        let model = FeatureModel(
            id: "gpt-5",
            name: "GPT-5",
            options: [
                FeatureModelOptionDescriptor(
                    id: "effort",
                    label: "Reasoning effort",
                    kind: .select,
                    choices: [
                        .init(id: "low", label: "Low"),
                        .init(id: "high", label: "High", isDefault: true),
                    ]
                ),
                FeatureModelOptionDescriptor(
                    id: "fast",
                    label: "Fast mode",
                    kind: .boolean,
                    defaultValue: .boolean(true)
                ),
            ]
        )

        let defaults = DailyUXModelOptions.defaults(for: model)

        #expect(defaults == [
            FeatureModelOptionSelection(id: "effort", value: .string("high")),
            FeatureModelOptionSelection(id: "fast", value: .boolean(true)),
        ])
    }

    @Test
    func updatingAnOptionReplacesOnlyItsPreviousValue() {
        let initial = [
            FeatureModelOptionSelection(id: "effort", value: .string("low")),
            FeatureModelOptionSelection(id: "fast", value: .boolean(false)),
        ]

        let updated = DailyUXModelOptions.updating(
            initial,
            id: "effort",
            value: .string("high")
        )

        #expect(updated.first { $0.id == "effort" }?.value == .string("high"))
        #expect(updated.first { $0.id == "fast" }?.value == .boolean(false))
        #expect(updated.count == 2)
    }

    @Test
    func optionSummaryUsesChoiceLabelsAndEnabledBooleans() {
        let model = FeatureModel(
            id: "gpt-5",
            name: "GPT-5",
            options: [
                .init(
                    id: "effort",
                    label: "Reasoning",
                    kind: .select,
                    choices: [.init(id: "high", label: "High")]
                ),
                .init(id: "fast", label: "Fast", kind: .boolean),
            ]
        )

        let summary = DailyUXModelOptions.summary(
            for: model,
            selections: [
                .init(id: "effort", value: .string("high")),
                .init(id: "fast", value: .boolean(true)),
            ]
        )

        #expect(summary == "High · Fast")
    }

    @Test
    func preferredSelectionFindsDefaultAcrossProvidersAndIncludesDefaults() {
        let providers = [
            FeatureProvider(
                id: "first",
                name: "First",
                models: [.init(id: "basic", name: "Basic")]
            ),
            FeatureProvider(
                id: "second",
                name: "Second",
                models: [
                    .init(
                        id: "preferred",
                        name: "Preferred",
                        isDefault: true,
                        options: [
                            .init(
                                id: "fast",
                                label: "Fast",
                                kind: .boolean,
                                defaultValue: .boolean(true)
                            ),
                        ]
                    ),
                ]
            ),
        ]

        let selection = DailyUXModelOptions.preferredSelection(in: providers)

        #expect(selection?.providerID == "second")
        #expect(selection?.modelID == "preferred")
        #expect(selection?.options == [
            FeatureModelOptionSelection(id: "fast", value: .boolean(true)),
        ])
    }

    @Test
    func projectDefaultWinsBeforeAppAndCatalogDefaults() {
        let providers = [
            FeatureProvider(
                id: "codex",
                name: "Codex",
                models: [
                    .init(id: "project", name: "Project"),
                    .init(id: "app", name: "App"),
                    .init(id: "catalog", name: "Catalog", isDefault: true),
                ]
            ),
        ]

        let selection = DailyUXModelOptions.initialSelection(
            projectDefault: .init(providerID: "codex", modelID: "project"),
            appDefault: .init(providerID: "codex", modelID: "app"),
            providers: providers
        )

        #expect(selection?.modelID == "project")
    }
}
