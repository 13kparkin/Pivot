import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { OmpCapabilityEditableKind, OmpCapabilityItem } from "@t3tools/contracts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  buildCapabilitiesSnapshotInput,
  buildCapabilityItemRows,
  buildDeleteResourceInput,
  buildReadResourceInput,
  buildResetSettingInput,
  buildSettingRows,
  buildWriteResourceInput,
  buildWriteSettingInput,
  canEditEntry,
  isValidItemName,
  NEW_RULE_TEMPLATE,
  NEW_SKILL_TEMPLATE,
  withTemplateName,
} from "./ProjectCapabilitiesRouteScreen.logic";

type ProjectCapabilitiesRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

interface SettingsEditorState {
  readonly kind: "setting";
  readonly key: string;
  readonly draft: string;
}

interface ResourceEditorState {
  readonly kind: "resource";
  readonly itemKind: OmpCapabilityEditableKind;
  readonly name: string;
  readonly content: string;
  readonly isEdit: boolean;
  /** Loading the existing file contents before the editor opens. */
  readonly loading: boolean;
}

type EditorState = SettingsEditorState | ResourceEditorState | null;

const ITEM_LABEL: Readonly<Record<OmpCapabilityEditableKind, string>> = {
  skills: "skill",
  rules: "rule",
};

function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The capabilities request failed.";
}

/**
 * Project-scoped omp capabilities (settings, skills, rules). Opened by the
 * sidebar project-row gear with the active environment's member projectId;
 * every mutation carries that projectId so writes land in the project's
 * `.omp` (the server resolves the trusted cwd). Global items render as
 * read-only context; project-scope items are editable.
 */
export function ProjectCapabilitiesRouteScreen(props: ProjectCapabilitiesRouteProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const iconMutedColor = useThemeColor("--color-icon-muted");
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const projectId = ProjectId.make(props.route.params.projectId);
  const [editor, setEditor] = useState<EditorState>(null);
  const [saving, setSaving] = useState(false);

  const snapshotQuery = useEnvironmentQuery(
    serverEnvironment.capabilitiesSnapshot({
      environmentId,
      input: buildCapabilitiesSnapshotInput(projectId),
    }),
  );
  const snapshot = snapshotQuery.data?.snapshot ?? null;
  const settingRows = useMemo(
    () => (snapshot === null ? [] : buildSettingRows(snapshot.settings.entries)),
    [snapshot],
  );
  const skillRows = useMemo(
    () => (snapshot === null ? [] : buildCapabilityItemRows(snapshot.skills)),
    [snapshot],
  );
  const ruleRows = useMemo(
    () => (snapshot === null ? [] : buildCapabilityItemRows(snapshot.rules)),
    [snapshot],
  );

  const writeSetting = useAtomCommand(serverEnvironment.capabilitiesWriteSetting, {
    reportFailure: false,
  });
  const resetSetting = useAtomCommand(serverEnvironment.capabilitiesResetSetting, {
    reportFailure: false,
  });
  const readResource = useAtomCommand(serverEnvironment.capabilitiesReadResource, {
    reportFailure: false,
  });
  const writeResource = useAtomCommand(serverEnvironment.capabilitiesWriteResource, {
    reportFailure: false,
  });
  const deleteResource = useAtomCommand(serverEnvironment.capabilitiesDeleteResource, {
    reportFailure: false,
  });

  const reportFailure = useCallback((title: string, cause: Cause.Cause<unknown>) => {
    Alert.alert(title, failureMessage(cause));
  }, []);

  const saveSetting = useCallback(async () => {
    if (editor === null || editor.kind !== "setting") return;
    setSaving(true);
    try {
      const result = await writeSetting({
        environmentId,
        input: buildWriteSettingInput({
          key: editor.key,
          value: editor.draft,
          scope: "project",
          projectId,
        }),
      });
      if (result._tag === "Failure") {
        reportFailure("Could not save setting", result.cause);
        return;
      }
      setEditor(null);
      snapshotQuery.refresh();
    } finally {
      setSaving(false);
    }
  }, [editor, environmentId, projectId, reportFailure, snapshotQuery, writeSetting]);

  const resetCurrentSetting = useCallback(async () => {
    if (editor === null || editor.kind !== "setting") return;
    setSaving(true);
    try {
      const result = await resetSetting({
        environmentId,
        input: buildResetSettingInput({ key: editor.key, scope: "project", projectId }),
      });
      if (result._tag === "Failure") {
        reportFailure("Could not reset setting", result.cause);
        return;
      }
      setEditor(null);
      snapshotQuery.refresh();
    } finally {
      setSaving(false);
    }
  }, [editor, environmentId, projectId, reportFailure, resetSetting, snapshotQuery]);

  const confirmResetSetting = useCallback(() => {
    if (editor === null || editor.kind !== "setting") return;
    Alert.alert("Reset to default?", `“${editor.key}” returns to its default value.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset",
        style: "destructive",
        onPress: () => {
          void resetCurrentSetting();
        },
      },
    ]);
  }, [editor, resetCurrentSetting]);

  const openItemEditor = useCallback(
    async (item: OmpCapabilityItem, itemKind: OmpCapabilityEditableKind) => {
      setEditor({
        kind: "resource",
        itemKind,
        name: item.name,
        content: "",
        isEdit: true,
        loading: true,
      });
      const result = await readResource({
        environmentId,
        input: buildReadResourceInput({
          kind: itemKind,
          name: item.name,
          scope: "project",
          projectId,
        }),
      });
      setEditor((current) => {
        if (current === null || current.kind !== "resource" || current.name !== item.name) {
          return current;
        }
        if (result._tag === "Failure") {
          reportFailure(`Could not load ${ITEM_LABEL[itemKind]}`, result.cause);
          return null;
        }
        return { ...current, content: result.value.resource.content, loading: false };
      });
    },
    [environmentId, projectId, readResource, reportFailure],
  );

  const openNewItemEditor = useCallback((itemKind: OmpCapabilityEditableKind) => {
    setEditor({
      kind: "resource",
      itemKind,
      name: "",
      content: itemKind === "skills" ? NEW_SKILL_TEMPLATE : NEW_RULE_TEMPLATE,
      isEdit: false,
      loading: false,
    });
  }, []);

  const saveItem = useCallback(async () => {
    if (editor === null || editor.kind !== "resource") return;
    const name = editor.name.trim();
    if (!isValidItemName(name) || editor.content.trim().length === 0) return;
    setSaving(true);
    try {
      const result = await writeResource({
        environmentId,
        input: buildWriteResourceInput({
          kind: editor.itemKind,
          name,
          content:
            editor.itemKind === "skills" ? withTemplateName(editor.content, name) : editor.content,
          scope: "project",
          projectId,
          overwrite: editor.isEdit,
        }),
      });
      if (result._tag === "Failure") {
        reportFailure(`Could not save ${ITEM_LABEL[editor.itemKind]}`, result.cause);
        return;
      }
      setEditor(null);
      snapshotQuery.refresh();
    } finally {
      setSaving(false);
    }
  }, [editor, environmentId, projectId, reportFailure, snapshotQuery, writeResource]);

  const deleteCurrentItem = useCallback(async () => {
    if (editor === null || editor.kind !== "resource" || !editor.isEdit) return;
    setSaving(true);
    try {
      const result = await deleteResource({
        environmentId,
        input: buildDeleteResourceInput({
          kind: editor.itemKind,
          name: editor.name,
          scope: "project",
          projectId,
        }),
      });
      if (result._tag === "Failure") {
        reportFailure(`Could not delete ${ITEM_LABEL[editor.itemKind]}`, result.cause);
        return;
      }
      setEditor(null);
      snapshotQuery.refresh();
    } finally {
      setSaving(false);
    }
  }, [editor, environmentId, projectId, deleteResource, reportFailure, snapshotQuery]);

  const confirmDeleteItem = useCallback(() => {
    if (editor === null || editor.kind !== "resource" || !editor.isEdit) return;
    Alert.alert(
      `Delete ${ITEM_LABEL[editor.itemKind]}?`,
      `“${editor.name}” will be removed from this project's .omp.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void deleteCurrentItem();
          },
        },
      ],
    );
  }, [deleteCurrentItem, editor]);

  const editorView =
    editor === null ? null : editor.kind === "setting" ? (
      <View className="flex-1 gap-3 px-5 pt-4">
        <Text className="text-sm text-foreground-muted">Setting</Text>
        <Text className="text-lg font-t3-medium text-foreground">{editor.key}</Text>
        <TextInput
          accessibilityLabel={`Value for ${editor.key}`}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={(text) => setEditor({ ...editor, draft: text })}
          placeholder="Value"
          className="rounded-2xl border border-input-border bg-input px-3.5 py-2.5 text-base font-sans text-foreground"
          value={editor.draft}
        />
        <Pressable
          accessibilityRole="button"
          disabled={saving}
          onPress={() => void saveSetting()}
          className="items-center rounded-xl bg-primary py-3"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text className="text-base font-t3-bold text-primary-foreground">Save</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={saving}
          onPress={confirmResetSetting}
          className="items-center rounded-xl border border-border py-3"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text className="text-base font-t3-medium text-foreground-muted">Reset to default</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={saving}
          onPress={() => setEditor(null)}
          className="items-center rounded-xl py-3"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text className="text-base font-t3-medium text-foreground-muted">Cancel</Text>
        </Pressable>
      </View>
    ) : (
      <View className="flex-1 gap-3 px-5 pt-4">
        <Text className="text-sm text-foreground-muted">
          {ITEM_LABEL[editor.itemKind]} {editor.isEdit ? "name" : "name (slug)"}
        </Text>
        <TextInput
          accessibilityLabel={`${ITEM_LABEL[editor.itemKind]} name`}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!editor.isEdit}
          onChangeText={(text) => setEditor({ ...editor, name: text })}
          placeholder="my-rule"
          className="rounded-2xl border border-input-border bg-input px-3.5 py-2.5 text-base font-sans text-foreground"
          value={editor.name}
        />
        <Text className="text-sm text-foreground-muted">Content</Text>
        {editor.loading ? (
          <View className="items-center py-6">
            <ActivityIndicator color={iconMutedColor} />
          </View>
        ) : (
          <TextInput
            accessibilityLabel={`${ITEM_LABEL[editor.itemKind]} content`}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={(text) => setEditor({ ...editor, content: text })}
            placeholder="# What does this do?"
            className="min-h-[180px] rounded-2xl border border-input-border bg-input px-3.5 py-2.5 text-base font-sans text-foreground"
            textAlignVertical="top"
            value={editor.content}
          />
        )}
        <Pressable
          accessibilityRole="button"
          disabled={
            saving ||
            editor.loading ||
            !isValidItemName(editor.name.trim()) ||
            editor.content.trim().length === 0
          }
          onPress={() => void saveItem()}
          className="items-center rounded-xl bg-primary py-3"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text className="text-base font-t3-bold text-primary-foreground">Save</Text>
        </Pressable>
        {editor.isEdit ? (
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={confirmDeleteItem}
            className="items-center rounded-xl py-3"
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <Text className="text-base font-t3-medium text-red-600 dark:text-red-400">
              Delete {ITEM_LABEL[editor.itemKind]}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={saving}
          onPress={() => setEditor(null)}
          className="items-center rounded-xl py-3"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text className="text-base font-t3-medium text-foreground-muted">Cancel</Text>
        </Pressable>
      </View>
    );

  const itemRow = (
    row: {
      readonly name: string;
      readonly description?: string;
      readonly scopeLabel: string;
      readonly scope: "global" | "project";
    },
    onOpen: () => void,
    newRow: boolean,
  ) => {
    const editable = newRow || row.scope === "project";
    return (
      <Pressable
        key={row.name}
        accessibilityRole="button"
        accessibilityLabel={newRow ? `New ${row.scopeLabel}` : `${row.name} (${row.scopeLabel})`}
        disabled={!editable}
        onPress={onOpen}
        className="flex-row items-center gap-3 p-4"
        style={({ pressed }) => (editable && pressed ? { opacity: 0.6 } : null)}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-lg text-foreground">
            {newRow ? `New ${row.scopeLabel}` : row.name}
          </Text>
          {row.description ? (
            <Text className="text-sm leading-normal text-foreground-muted" numberOfLines={2}>
              {row.description}
            </Text>
          ) : null}
        </View>
        {!newRow ? (
          <Text className="text-sm text-foreground-tertiary">{row.scopeLabel}</Text>
        ) : null}
        {editable && !newRow ? (
          <SymbolView name="chevron.right" size={14} tintColor={iconMutedColor} type="monochrome" />
        ) : null}
      </Pressable>
    );
  };

  const listView = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      {snapshot === null ? (
        <View className="items-center py-16">
          {snapshotQuery.isPending ? (
            <ActivityIndicator color={iconMutedColor} />
          ) : snapshotQuery.error !== null ? (
            <Text className="text-center text-sm text-foreground-muted">
              Could not load project capabilities: {snapshotQuery.error}
            </Text>
          ) : null}
        </View>
      ) : (
        <>
          <SettingsSection title="Settings">
            {settingRows.map((row, index) => {
              const editable = row.scope === "project" && canEditEntry(row);
              return (
                <Pressable
                  key={row.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.key} (${row.scope === "project" ? "Project" : row.scope === "global" ? "Global" : "Profile"})`}
                  disabled={!editable}
                  onPress={() =>
                    setEditor({ kind: "setting", key: row.key, draft: row.displayValue })
                  }
                  className={
                    index === 0
                      ? "flex-row items-center gap-3 p-4"
                      : "flex-row items-center gap-3 border-t border-border-subtle p-4"
                  }
                  style={({ pressed }) => (editable && pressed ? { opacity: 0.6 } : null)}
                >
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text className="text-lg text-foreground">{row.key}</Text>
                    <Text
                      className="text-sm leading-normal text-foreground-muted"
                      numberOfLines={1}
                    >
                      {row.scope === "project"
                        ? "Project"
                        : row.scope === "global"
                          ? "Global"
                          : "Profile"}{" "}
                      · {row.description}
                    </Text>
                  </View>
                  <Text
                    className="max-w-[40%] text-sm text-foreground-tertiary"
                    numberOfLines={1}
                    style={{ fontFamily: "monospace" }}
                  >
                    {row.displayValue}
                  </Text>
                  {editable ? (
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColor={iconMutedColor}
                      type="monochrome"
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </SettingsSection>
          <SettingsSection title="Skills">
            {itemRow(
              { name: "new-skill", scopeLabel: "skill", scope: "project" },
              () => openNewItemEditor("skills"),
              true,
            )}
            {skillRows.map((row) =>
              itemRow(
                row,
                () => {
                  void openItemEditor(row, "skills");
                },
                false,
              ),
            )}
          </SettingsSection>
          <SettingsSection title="Rules">
            {itemRow(
              { name: "new-rule", scopeLabel: "rule", scope: "project" },
              () => openNewItemEditor("rules"),
              true,
            )}
            {ruleRows.map((row) =>
              itemRow(
                row,
                () => {
                  void openItemEditor(row, "rules");
                },
                false,
              ),
            )}
          </SettingsSection>
        </>
      )}
    </ScrollView>
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Project Capabilities" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      {editor === null ? listView : editorView}
    </View>
  );
}
