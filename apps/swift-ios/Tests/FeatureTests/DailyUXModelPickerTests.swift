import Foundation
import Testing
@testable import T3Code

@Suite("Model picker")
struct DailyUXModelPickerTests {
    @Test
    func providerBrandsResolveFromDriversAndFallbackIDs() {
        #expect(
            ProviderBrand.resolve(driver: "codex", providerID: "work-openai") == .openAI
        )
        #expect(
            ProviderBrand.resolve(driver: "claudeAgent", providerID: "work-claude") == .claude
        )
        #expect(ProviderBrand.resolve(driver: "cursor", providerID: "cursor") == .cursor)
        #expect(ProviderBrand.resolve(driver: "grok", providerID: "grok") == .grok)
        #expect(ProviderBrand.resolve(driver: "opencode", providerID: "opencode") == .openCode)
        #expect(ProviderBrand.resolve(driver: "", providerID: "claude") == .claude)
        #expect(ProviderBrand.resolve(driver: "custom", providerID: "custom") == nil)
    }

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
    func compactReasoningSummaryIgnoresOtherModelOptions() {
        let model = FeatureModel(
            id: "gpt-5",
            name: "A model name long enough to truncate",
            options: [
                .init(
                    id: "reasoningEffort",
                    label: "Reasoning",
                    kind: .select,
                    choices: [.init(id: "xhigh", label: "Extra high")]
                ),
                .init(id: "fast", label: "Fast mode", kind: .boolean),
            ]
        )

        let summary = DailyUXModelOptions.reasoningSummary(
            for: model,
            selections: [
                .init(id: "reasoningEffort", value: .string("xhigh")),
                .init(id: "fast", value: .boolean(true)),
            ]
        )

        #expect(summary == "Extra high")
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

    @Test
    func missingAndStaleSelectionsMaterializeTheConcretePreferredModel() {
        let providers = [
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [
                    .init(id: "claude-sonnet-4", name: "Sonnet 4", isDefault: true),
                    .init(id: "claude-opus-5", name: "Opus 5"),
                ]
            ),
        ]

        #expect(
            ProviderModelSelectionResolver.materialized(nil, in: providers)?.modelID
                == "claude-opus-5"
        )
        #expect(
            ProviderModelSelectionResolver.materialized(
                .init(providerID: "claude", modelID: "removed"),
                in: providers
            )?.modelID == "claude-opus-5"
        )
    }

    @Test
    func duplicateCatalogEntriesCollapseAndImplicitModelsDisappear() {
        let normalized = ProviderModelCatalogNormalizer.normalized([
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [
                    .init(id: "environment-auto", name: "Automatic (recommended)"),
                    .init(id: "opus", name: "Opus"),
                ]
            ),
            FeatureProvider(
                id: "claude",
                name: "Claude duplicate",
                models: [
                    .init(id: "opus", name: "Opus duplicate"),
                    .init(id: "sonnet", name: "Sonnet"),
                ]
            ),
        ])

        #expect(normalized.map(\.id) == ["claude"])
        #expect(normalized[0].name == "Claude")
        #expect(normalized[0].models.map(\.id) == ["opus", "sonnet"])
        #expect(normalized[0].models.map(\.name) == ["Opus", "Sonnet"])
    }

    @Test
    func favoritesAndRecentsDoNotRepeatInProviderSections() {
        let providers = [
            FeatureProvider(
                id: "claude",
                name: "Claude",
                models: [
                    .init(id: "claude-opus-5", name: "Opus 5"),
                    .init(id: "claude-sonnet-5", name: "Sonnet 5"),
                    .init(id: "claude-fable-5", name: "Fable 5"),
                    .init(id: "claude-haiku-3", name: "Haiku 3"),
                ]
            ),
        ]
        let opus = DailyUXModelOption.key(
            providerID: "claude",
            modelID: "claude-opus-5"
        )
        let sonnet = DailyUXModelOption.key(
            providerID: "claude",
            modelID: "claude-sonnet-5"
        )
        let catalog = DailyUXModelCatalog(
            providers: providers,
            query: "",
            favoriteIDs: [opus],
            recentIDs: [sonnet]
        )

        let remaining = ProviderModelDisplaySections(catalog: catalog)

        #expect(
            remaining.currentProviderGroups.flatMap(\.models).map(\.model.id)
                == ["claude-fable-5"]
        )
        #expect(remaining.legacy.map(\.model.id) == ["claude-haiku-3"])
    }

    @Test
    func currentFamiliesAreClassifiedFromStableIDsAndNames() {
        let codex = FeatureProvider(id: "work-openai", name: "Codex", driver: "codex")
        let claude = FeatureProvider(
            id: "work-claude",
            name: "Anthropic",
            driver: "claudeAgent"
        )

        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "gpt-5.6-codex-luna", name: "Luna"),
                provider: codex
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "gpt_5_6_terra", name: "GPT 5.6 Terra"),
                provider: codex
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "gpt-5-6-sol", name: "Sol"),
                provider: codex
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "claude-fable-5-202607", name: "Fable 5"),
                provider: claude
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "claude-opus-5", name: "OPUS 5"),
                provider: claude
            )
        )
        #expect(
            ProviderModelFamilyClassifier.isCurrent(
                .init(id: "claude-sonnet-5", name: "Sonnet v5"),
                provider: claude
            )
        )
        #expect(
            !ProviderModelFamilyClassifier.isCurrent(
                .init(id: "claude-opus-4-1", name: "Opus 4.1"),
                provider: claude
            )
        )
        #expect(
            !ProviderModelFamilyClassifier.isCurrent(
                .init(id: "gpt-5.5-codex-sol", name: "GPT 5.5 Sol"),
                provider: codex
            )
        )
    }
}
