import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useFontFamily } from "../../lib/useFontFamily";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { shouldCheckoutNewTaskBranch } from "./new-task-context-presentation";

function SelectionRow(props: {
  readonly icon?: "arrow.triangle.branch" | "desktopcomputer";
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selectionStyle?: "checkmark" | "checkbox";
  readonly selected: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const checkmarkColor = useThemeColor("--color-icon");
  const usesCheckbox = props.selectionStyle === "checkbox";
  const rowIcon = usesCheckbox ? (props.selected ? "checkmark.circle" : "circle") : props.icon;

  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityRole={usesCheckbox ? "checkbox" : "button"}
      accessibilityState={usesCheckbox ? { checked: props.selected } : { selected: props.selected }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {rowIcon ? (
        <SymbolView
          name={rowIcon}
          size={17}
          tintColor={usesCheckbox && props.selected ? checkmarkColor : iconColor}
          type="monochrome"
        />
      ) : null}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected && !usesCheckbox ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColor={checkmarkColor}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function PickerSurface(props: { readonly children: ReactNode }) {
  return <View className="overflow-hidden rounded-2xl bg-card">{props.children}</View>;
}

export function NewTaskEnvironmentPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: "Environment",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Environment" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        <PickerSurface>
          {flow.environments.map((environment, index) => (
            <SelectionRow
              key={String(environment.environmentId)}
              icon="desktopcomputer"
              isLast={index === flow.environments.length - 1}
              onPress={() => {
                void Haptics.selectionAsync();
                flow.selectEnvironment(environment.environmentId);
                navigation.goBack();
              }}
              selected={flow.selectedEnvironmentId === environment.environmentId}
              title={environment.environmentLabel}
            />
          ))}
        </PickerSurface>
      </ScrollView>
    </View>
  );
}

export function NewTaskBranchPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const placeholderColor = useThemeColor("--color-placeholder");
  const foregroundColor = useThemeColor("--color-foreground");
  const fontFamily = useFontFamily("regular");
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const [switchingBranchName, setSwitchingBranchName] = useState<string | null>(null);
  const screenTitle = flow.workspaceMode === "worktree" ? "Base branch" : "Branch";
  const usesNativeMailSearchToolbar = Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const selectedBranchName =
    flow.selectedBranchName ??
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;

  useEffect(() => {
    if (!flow.branchesLoading && flow.availableBranches.length === 0) {
      void flow.loadBranches();
    }
  }, [flow.availableBranches.length, flow.branchesLoading, flow.loadBranches]);

  useEffect(
    () => () => {
      flow.setBranchQuery("");
    },
    [flow.setBranchQuery],
  );

  const selectBranch = async (branch: VcsRef) => {
    if (switchingBranchName !== null) {
      return;
    }
    void Haptics.selectionAsync();

    let selectedBranch = branch;
    const needsCheckout = shouldCheckoutNewTaskBranch({
      branchIsCurrent: branch.current,
      branchWorktreePath: branch.worktreePath,
      workspaceMode: flow.workspaceMode,
    });
    if (needsCheckout && flow.selectedProject) {
      setSwitchingBranchName(branch.name);
      const result = await switchRef({
        environmentId: flow.selectedProject.environmentId,
        input: {
          cwd: flow.selectedWorktreePath ?? flow.selectedProject.workspaceRoot,
          refName: branch.name,
        },
      });
      setSwitchingBranchName(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not switch branch",
            error instanceof Error ? error.message : "The branch could not be checked out.",
          );
        }
        return;
      }
      selectedBranch = {
        ...branch,
        current: true,
        isRemote: false,
        name: result.value.refName ?? branch.name,
      };
    }

    flow.selectBranch(selectedBranch);
    flow.setBranchQuery("");
    navigation.goBack();
  };

  const branchList = (
    <FlatList
      automaticallyAdjustsScrollIndicatorInsets
      automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: flow.filteredBranches.length === 0 ? 1 : undefined,
        paddingBottom: Platform.OS === "ios" ? 16 : Math.max(insets.bottom, 16) + 16,
        paddingHorizontal: 16,
        paddingTop: 12,
      }}
      data={flow.filteredBranches}
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      keyboardShouldPersistTaps="handled"
      keyExtractor={(branch) =>
        `${branch.remoteName ?? "local"}:${branch.name}:${branch.worktreePath ?? ""}`
      }
      ListHeaderComponent={
        flow.workspaceMode === "worktree" ? (
          <View className="mb-3 overflow-hidden rounded-2xl">
            <SelectionRow
              isLast
              onPress={() => {
                void Haptics.selectionAsync();
                flow.setStartFromOrigin(!flow.startFromOrigin);
              }}
              selected={flow.startFromOrigin}
              selectionStyle="checkbox"
              subtitle={
                selectedBranchName
                  ? `Start from origin/${selectedBranchName}`
                  : "Start from the latest remote branch"
              }
              title="Latest origin"
            />
          </View>
        ) : null
      }
      renderItem={({ item, index }) => {
        const badge = branchBadgeLabel({ branch: item, project: flow.selectedProject });
        return (
          <View
            className={cn(
              index === 0 && "overflow-hidden rounded-t-2xl",
              index === flow.filteredBranches.length - 1 && "overflow-hidden rounded-b-2xl",
            )}
          >
            <SelectionRow
              icon="arrow.triangle.branch"
              disabled={switchingBranchName !== null}
              isLast={index === flow.filteredBranches.length - 1}
              onPress={() => void selectBranch(item)}
              selected={selectedBranchName === item.name}
              subtitle={badge ? badge.toUpperCase() : undefined}
              title={item.name}
            />
          </View>
        );
      }}
      ListEmptyComponent={
        <View className="flex-1 items-center justify-center gap-3 px-8 py-16">
          {flow.branchesLoading ? <ActivityIndicator /> : null}
          <Text className="text-center text-sm text-foreground-muted">
            {flow.branchesLoading
              ? "Loading branches…"
              : flow.branchQuery
                ? "No matching branches"
                : "No branches available"}
          </Text>
        </View>
      }
      showsVerticalScrollIndicator={false}
    />
  );

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title={screenTitle} onBack={() => navigation.goBack()} />
        <View className="px-4 pb-2 pt-3">
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            className="h-11 rounded-xl bg-card px-4 text-base text-foreground"
            onChangeText={flow.setBranchQuery}
            placeholder="Find a branch"
            placeholderTextColor={placeholderColor}
            style={{ color: foregroundColor, fontFamily }}
            value={flow.branchQuery}
          />
        </View>
        {branchList}
      </View>
    );
  }

  return (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: true,
          title: screenTitle,
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: flow.setBranchQuery,
                  placeholder: "Find a branch",
                  searchTextChangeId: "new-task-branch-search-text",
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesNativeMailSearchToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                placeholder: "Find a branch",
                onChangeText: (event) => {
                  flow.setBranchQuery(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  flow.setBranchQuery("");
                },
              },
        }}
      />
      {usesNativeMailSearchToolbar ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.SearchBarSlot />
        </NativeHeaderToolbar>
      )}
      {branchList}
    </>
  );
}
