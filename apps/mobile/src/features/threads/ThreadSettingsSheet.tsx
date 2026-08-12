import type {
  ModelSelection,
  ProviderInteractionMode,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import ExpoBottomSheet from "@expo/ui/community/bottom-sheet";
import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { applyProviderOptionSelection, providerOptionValueLabels } from "../../lib/providerOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { useNewTaskSettingsTransition } from "./new-task-settings-transition";
import { RUNTIME_MODE_CHOICES, selectableChoices } from "./thread-settings-menu";
import { pendingModelAfterPress } from "./thread-settings-sheet-state";
import type { ThreadSettingsSheetCloseReason } from "./use-thread-settings-sheet-presentation";

/**
 * The everyday harnesses stay expanded; every other provider (OpenRouter
 * catalogs and friends) folds behind its header so a 300-model catalog can't
 * bury the list.
 */
const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * Compact "Fable 5 · Max · Auto" style summary for the composer trigger pill,
 * covering model, provider options, runtime mode, and plan mode in one label.
 */
export function threadSettingsSummaryLabel(input: {
  readonly modelLabel: string;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): string {
  const runtime = RUNTIME_MODE_CHOICES.find((choice) => choice.mode === input.runtimeMode);
  return [
    input.modelLabel,
    ...providerOptionValueLabels(input.optionDescriptors),
    ...(runtime ? [runtime.shortLabel] : []),
    ...(input.interactionMode === "plan" ? ["Plan"] : []),
  ].join(" · ");
}

function ModelRow(props: {
  readonly option: ModelOption;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const primaryFg = useThemeColor("--color-primary-foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      // Selected rows get the same primary treatment as the submenu rows.
      // Subtle backgrounds (bg-subtle-strong) get overridden by the OS
      // selection chrome on iOS 26, so use the explicit high-contrast style
      // everywhere instead.
      className={cn(
        "mx-2.5 flex-row items-center gap-2 rounded-xl px-3 py-3.5 active:opacity-70",
        props.selected ? "bg-primary" : "bg-transparent",
      )}
    >
      <Text
        className={cn(
          "shrink text-sm font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {props.option.label}
      </Text>
      {props.option.isDefault ? (
        <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
          <Text className="text-3xs font-t3-bold text-foreground-muted">Default</Text>
        </View>
      ) : null}
      {props.option.isLegacy ? (
        <View className="rounded-md bg-subtle px-1.5 py-0.5">
          <Text className="text-3xs font-t3-bold text-foreground-muted">Legacy</Text>
        </View>
      ) : null}
      <View className="flex-1" />
      {props.selected ? (
        <SymbolView name="checkmark" size={14} tintColor={primaryFg} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

/**
 * Provider section header with the harness logo. Secondary providers render
 * as a tappable fold (count + chevron while collapsed); primary providers
 * and the group holding the current selection are static headers.
 */
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole={props.collapsible ? "button" : "header"}
      accessibilityState={props.collapsible ? { expanded: !props.collapsed } : undefined}
      accessibilityLabel={
        props.collapsible ? `${props.label}, ${props.modelCount} models` : props.label
      }
      disabled={!props.collapsible}
      onPress={props.onToggle}
      className={cn(
        "mx-2.5 flex-row items-center gap-2 rounded-xl px-3",
        props.collapsible ? "py-3.5 active:opacity-70" : "pb-2 pt-4",
      )}
    >
      <ProviderIcon provider={props.driver} size={15} />
      <Text className="text-2xs font-t3-bold uppercase tracking-widest text-foreground-muted">
        {props.label}
      </Text>
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={11}
            tintColor={iconSubtle}
            type="monochrome"
          />
        </>
      ) : null}
    </Pressable>
  );
}

/** Compact row that opens a single-choice submenu panel. */
function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-2 px-5 py-3 active:opacity-70",
        props.disabled && "opacity-40",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView name="chevron.right" size={12} tintColor={iconSubtle} type="monochrome" />
    </Pressable>
  );
}

/** Single option inside a submenu panel. */
function ChoiceRow(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const primaryFg = useThemeColor("--color-primary-foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={cn(
        "mx-2.5 flex-row items-center rounded-xl px-3 py-3.5 active:opacity-70",
        props.selected ? "bg-primary" : "bg-transparent",
      )}
    >
      <Text
        className={cn(
          "shrink text-sm font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
      <View className="flex-1" />
      {props.selected ? (
        <SymbolView name="checkmark" size={14} tintColor={primaryFg} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly disabled?: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  const activeTrack = String(useThemeColor("--color-switch-active"));
  const track = String(useThemeColor("--color-secondary-border"));
  return (
    <View
      className={cn(
        "flex-row items-center justify-between px-5 py-2.5",
        props.disabled && "opacity-40",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <Switch
        disabled={props.disabled}
        ios_backgroundColor={track}
        onValueChange={props.onValueChange}
        trackColor={{ false: track, true: activeTrack }}
        value={props.value}
      />
    </View>
  );
}

type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" };

type ThreadSettingsSessionProps = {
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
};

type DescriptorTemplateEntry = {
  readonly label: string;
  readonly type: "select" | "boolean";
};

type ThreadSettingsSessionValue = ThreadSettingsSessionProps & {
  readonly descriptorTemplate: ReadonlyArray<DescriptorTemplateEntry>;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly expandedProviders: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => void;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption) => void;
  readonly toggleLegacy: () => void;
  readonly toggleProvider: (providerKey: string) => void;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

/** Owns the staged model and option state for one picker presentation. */
function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);

  const isApplied = useCallback(
    (option: ModelOption) =>
      option.selection.instanceId === props.selectedModel?.instanceId &&
      option.selection.model === props.selectedModel.model,
    [props.selectedModel],
  );
  // The list highlights the staged pick; Save turns it into the applied one.
  const isDisplayed = useCallback(
    (option: ModelOption) => (pendingModel ? option.key === pendingModel.key : isApplied(option)),
    [isApplied, pendingModel],
  );

  // While a model is staged, the settings rows describe and edit the staged
  // model's options (kept on its pending selection); Save applies model and
  // options together. Otherwise they edit the applied selection directly.
  const displayedDescriptors = useMemo(
    () =>
      pendingModel
        ? pendingModel.capabilities
          ? getProviderOptionDescriptors({
              caps: pendingModel.capabilities,
              selections: pendingModel.selection.options,
            })
          : []
        : props.optionDescriptors,
    [pendingModel, props.optionDescriptors],
  );

  const hasLegacyModels = useMemo(
    () => props.providerGroups.some((group) => group.models.some((model) => model.isLegacy)),
    [props.providerGroups],
  );
  // Legacy stays hidden unless the pill is toggled this open; a highlighted
  // legacy model is exempted from the filter instead of forcing the whole
  // legacy list visible.
  // Stable settings rows: the union of descriptors across the primary
  // harnesses' current models (plus whatever the displayed model advertises)
  // always renders, with unsupported rows disabled instead of vanishing when
  // the selection changes. Keyed by label, not id — Claude and Codex use
  // different ids for the same "Reasoning" concept.
  const descriptorTemplate = useMemo(() => {
    const seen = new Map<string, DescriptorTemplateEntry>();
    for (const group of props.providerGroups) {
      const driver = group.models[0]?.providerDriver;
      if (driver === undefined || !PRIMARY_PROVIDER_DRIVERS.has(driver)) {
        continue;
      }
      for (const model of group.models) {
        if (model.isLegacy) {
          continue;
        }
        for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
          if (!seen.has(descriptor.label)) {
            seen.set(descriptor.label, { label: descriptor.label, type: descriptor.type });
          }
        }
      }
    }
    for (const descriptor of displayedDescriptors) {
      if (!seen.has(descriptor.label)) {
        seen.set(descriptor.label, { label: descriptor.label, type: descriptor.type });
      }
    }
    return [...seen.values()];
  }, [displayedDescriptors, props.providerGroups]);

  const commitPendingModel = useCallback(() => {
    if (pendingModel) {
      void Haptics.selectionAsync();
      props.onSelectModel(pendingModel);
    }
  }, [pendingModel, props.onSelectModel]);

  const applyOptionChange = useCallback(
    (id: string, value: string | boolean) => {
      const next = applyProviderOptionSelection(displayedDescriptors, { id, value });
      if (!next) {
        return;
      }
      if (pendingModel) {
        setPendingModel({
          ...pendingModel,
          selection: { ...pendingModel.selection, options: next },
        });
      } else {
        props.onUpdateOptionSelections(next);
      }
    },
    [displayedDescriptors, pendingModel, props.onUpdateOptionSelections],
  );

  const toggleProvider = useCallback((providerKey: string) => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  }, []);

  const pressModel = useCallback(
    (option: ModelOption) => {
      void Haptics.selectionAsync();
      setPendingModel((current) =>
        pendingModelAfterPress({
          current,
          pressed: option,
          pressedIsApplied: isApplied(option),
        }),
      );
    },
    [isApplied],
  );

  const toggleLegacy = useCallback(() => {
    void Haptics.selectionAsync();
    setShowLegacyToggle((current) => !current);
  }, []);

  const value = useMemo<ThreadSettingsSessionValue>(
    () => ({
      providerGroups: props.providerGroups,
      selectedModel: props.selectedModel,
      onSelectModel: props.onSelectModel,
      optionDescriptors: props.optionDescriptors,
      onUpdateOptionSelections: props.onUpdateOptionSelections,
      runtimeMode: props.runtimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
      descriptorTemplate,
      displayedDescriptors,
      expandedProviders,
      hasLegacyModels,
      pendingModel,
      showLegacy: showLegacyToggle,
      applyOptionChange,
      commitPendingModel,
      isApplied,
      isDisplayed,
      pressModel,
      toggleLegacy,
      toggleProvider,
    }),
    [
      applyOptionChange,
      commitPendingModel,
      descriptorTemplate,
      displayedDescriptors,
      expandedProviders,
      hasLegacyModels,
      isApplied,
      isDisplayed,
      pendingModel,
      pressModel,
      props.onSelectModel,
      props.onUpdateOptionSelections,
      props.onUpdateRuntimeMode,
      props.optionDescriptors,
      props.providerGroups,
      props.runtimeMode,
      props.selectedModel,
      showLegacyToggle,
      toggleLegacy,
      toggleProvider,
    ],
  );

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}

/** Model catalog plus pinned option rows, without imposing a presentation owner. */
function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {session.hasLegacyModels ? (
        <View className="flex-row justify-end px-4 py-2">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: session.showLegacy }}
            hitSlop={8}
            onPress={session.toggleLegacy}
            className="rounded-full border border-border bg-subtle px-3 py-1.5 active:opacity-70"
          >
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {session.showLegacy ? "Hide legacy models" : "Show legacy models"}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {/* Only the model list scrolls. Provider catalogs can run to hundreds
          of models, while the controls below stay pinned and reachable. */}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 8 }}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <ThreadSettingsModelGroups />
      </ScrollView>

      <View
        className="z-10 border-t border-border bg-sheet"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        {session.descriptorTemplate.map((entry) => {
          const live = session.displayedDescriptors.find(
            (descriptor) => descriptor.label === entry.label,
          );
          if ((live?.type ?? entry.type) === "select") {
            return (
              <DisclosureRow
                key={entry.label}
                label={entry.label}
                value={live ? getProviderOptionCurrentLabel(live) : undefined}
                disabled={!live}
                onPress={() => {
                  if (live) {
                    props.onOpenSubmenu({ kind: "descriptor", id: live.id });
                  }
                }}
              />
            );
          }
          return (
            <SwitchRow
              key={entry.label}
              label={entry.label}
              value={live?.type === "boolean" ? (live.currentValue ?? false) : false}
              disabled={!live}
              onValueChange={(value) => {
                if (live) {
                  session.applyOptionChange(live.id, value);
                }
              }}
            />
          );
        })}
        <DisclosureRow
          label="Runtime"
          value={RUNTIME_MODE_CHOICES.find((choice) => choice.mode === session.runtimeMode)?.label}
          onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
        />
      </View>
    </View>
  );
}

function ThreadSettingsModelGroups() {
  const session = useThreadSettingsSession();

  return session.providerGroups.map((group) => {
    const driver = group.models[0]?.providerDriver;
    const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
    const visibleModels = session.showLegacy
      ? group.models
      : group.models.filter((model) => !model.isLegacy || session.isDisplayed(model));
    if (visibleModels.length === 0) {
      return null;
    }
    const containsSelection = group.models.some(session.isDisplayed);
    const collapsible = !isPrimary && !containsSelection;
    const collapsed = collapsible && !session.expandedProviders.has(group.providerKey);
    return (
      <View key={group.providerKey}>
        <ProviderHeader
          driver={driver}
          label={group.providerLabel}
          collapsible={collapsible}
          collapsed={collapsed}
          modelCount={visibleModels.length}
          onToggle={() => session.toggleProvider(group.providerKey)}
        />
        {collapsed
          ? null
          : visibleModels.map((option) => (
              <ModelRow
                key={option.key}
                option={option}
                selected={session.isDisplayed(option)}
                onPress={() => session.pressModel(option)}
              />
            ))}
      </View>
    );
  });
}

/** Compact choice page pushed by the picker navigator. */
function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const submenuContent =
    props.submenu.kind === "runtime"
      ? {
          title: "Runtime",
          rows: RUNTIME_MODE_CHOICES.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : activeDescriptor?.type === "select"
        ? {
            title: activeDescriptor.label,
            rows: selectableChoices(activeDescriptor).map((choice) => ({
              id: choice.id,
              label: choice.label,
              selected: choice.id === getProviderOptionCurrentValue(activeDescriptor),
              onPress: () => {
                void Haptics.selectionAsync();
                session.applyOptionChange(activeDescriptor.id, choice.id);
                props.onSelected();
              },
            })),
          }
        : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: insets.bottom + 12, paddingTop: 8 }}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        {submenuContent.rows.map((row) => (
          <ChoiceRow key={row.id} label={row.label} selected={row.selected} onPress={row.onPress} />
        ))}
      </ScrollView>
    </View>
  );
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: (reason: ThreadSettingsSheetCloseReason) => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerBackVisible: false,
          title: "Thread settings",
        }}
      />
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Cancel thread settings"
          label="Cancel"
          onPress={() => presentation.onClose("dismiss")}
        />
      </NativeHeaderToolbar>
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          accessibilityLabel={session.pendingModel ? "Save thread settings" : "Done"}
          label={session.pendingModel ? "Save" : "Done"}
          onPress={() => {
            session.commitPendingModel();
            presentation.onClose("save");
          }}
        />
      </NativeHeaderToolbar>
      <ThreadSettingsMainContent
        onOpenSubmenu={(submenu) => {
          const title =
            submenu.kind === "runtime"
              ? "Runtime"
              : (session.displayedDescriptors.find(
                  (descriptor) => descriptor.type === "select" && descriptor.id === submenu.id,
                )?.label ?? "Option");
          navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
        }}
      />
    </View>
  );
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title: route.params.title }} />
      <ThreadSettingsChoiceContent submenu={route.params} onSelected={() => navigation.goBack()} />
    </View>
  );
}

function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const sheetBackground = String(useThemeColor("--color-sheet"));
  const foreground = String(useThemeColor("--color-foreground"));
  const presentation = useMemo(
    () => ({
      onClose: props.onClose,
    }),
    [props.onClose],
  );

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={{
          animation: "slide_from_right",
          contentStyle: { backgroundColor: sheetBackground },
          gestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: { backgroundColor: sheetBackground },
          headerTintColor: foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "700" },
        }}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

/**
 * Native modal sheet used by existing threads. Option pages push inside the
 * sheet's own navigator instead of presenting another modal layer.
 */
export function ThreadSettingsSheet(
  props: ThreadSettingsSessionProps & {
    readonly visible: boolean;
    readonly onClose: (reason: ThreadSettingsSheetCloseReason) => void;
    readonly onDismissed: () => void;
  },
) {
  const sheetBackground = useThemeColor("--color-sheet");
  const wasPresentedRef = useRef(false);

  useEffect(() => {
    if (props.visible) {
      wasPresentedRef.current = true;
    }
  }, [props.visible]);

  const handleSheetClosed = useCallback(() => {
    if (!wasPresentedRef.current) {
      return;
    }

    wasPresentedRef.current = false;
    if (props.visible) {
      props.onClose("dismiss");
    }
    props.onDismissed();
  }, [props.onClose, props.onDismissed, props.visible]);

  if (!props.visible && !wasPresentedRef.current) {
    return null;
  }

  return (
    <ExpoBottomSheet
      backgroundStyle={{ backgroundColor: sheetBackground }}
      enableDynamicSizing={false}
      enablePanDownToClose
      index={props.visible ? 0 : -1}
      onClose={handleSheetClosed}
      snapPoints={["86%"]}
    >
      <ThreadSettingsSessionProvider {...props}>
        <ThreadSettingsPickerNavigator onClose={props.onClose} />
      </ThreadSettingsSessionProvider>
    </ExpoBottomSheet>
  );
}

/**
 * Native stack hosted by the New Task navigator's form-sheet route. Keeping
 * the sheet presentation in RNS gives UIKit ownership of nested dismissal,
 * while Reasoning and Runtime remain regular pushes inside this navigator.
 */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const transition = useNewTaskSettingsTransition();
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: flow.selectedModelOption?.capabilities,
        selections: flow.selectedModel?.options,
      }),
    [flow.selectedModel?.options, flow.selectedModelOption?.capabilities],
  );
  useEffect(() => {
    const removeTransitionStart = navigation.addListener("transitionStart", (event) => {
      if (event.data.closing) {
        transition.notifyDismissalStart();
      }
    });
    const removeGestureCancel = navigation.addListener("gestureCancel", () => {
      transition.notifyDismissalCancel();
    });
    return () => {
      removeTransitionStart();
      removeGestureCancel();
    };
  }, [navigation, transition]);

  return (
    <ThreadSettingsSessionProvider
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      onSelectModel={(option) => flow.setSelectedModelKey(option.key, option.selection.options)}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      runtimeMode={flow.runtimeMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
    >
      <ThreadSettingsPickerNavigator onClose={() => navigation.goBack()} />
    </ThreadSettingsSessionProvider>
  );
}
