"use client";

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from "@t3tools/contracts/settings";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";

import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NOTIFICATION_TOGGLES = [
  {
    key: "modelFailures",
    id: "notification-model-failures",
    title: "Model run failures",
    description:
      "Toast when a model run fails to start or fails mid-run (quota exhaustion, connection errors, provider errors).",
  },
  {
    key: "repeatedModelFailures",
    id: "notification-repeated-failures",
    title: "Repeated failures",
    description:
      "Keep notifying while the same failure persists, at most once every 5 minutes, instead of toasting only the first occurrence.",
  },
  {
    key: "planLimitWarnings",
    id: "notification-plan-limit-warnings",
    title: "Plan limit warnings",
    description:
      "Toast when a subscription window (Codex, OpenCode Go, Cursor, …) crosses into warning or exhausted, and again after it resets.",
  },
] as const satisfies ReadonlyArray<{
  readonly key: keyof NotificationSettings;
  readonly id: string;
  readonly title: string;
  readonly description: string;
}>;

export function NotificationsSettingsPanel() {
  const settings = usePrimarySettings((current) => current.notificationSettings);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsPageContainer>
      <SettingsSection id="notifications" title="Notifications">
        {NOTIFICATION_TOGGLES.map(({ key, id, title, description }) => (
          <SettingsRow
            key={key}
            {...searchableSetting(id)}
            description={description}
            resetAction={
              settings[key] !== DEFAULT_NOTIFICATION_SETTINGS[key] ? (
                <SettingResetButton
                  label={title.toLowerCase()}
                  onClick={() =>
                    updateSettings({
                      notificationSettings: {
                        ...settings,
                        [key]: DEFAULT_NOTIFICATION_SETTINGS[key],
                      },
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings[key]}
                onCheckedChange={(checked) =>
                  updateSettings({
                    notificationSettings: { ...settings, [key]: Boolean(checked) },
                  })
                }
                aria-label={title}
              />
            }
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
