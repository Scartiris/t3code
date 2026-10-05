import type { StorageCleanupSettings, WorktreeCleanupRules } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useClearScopedSettings,
  useScopedSettings,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function RetentionControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <NumberField
          value={draft}
          min={1}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const days = Math.min(3650, Math.max(1, Math.round(next)));
              setDraft(days);
              onChange(days);
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement
              aria-label={t("settings.storageSettings.decreaseDayCount", { label })}
            />
            <NumberFieldInput
              aria-label={t("settings.storageSettings.daysCount", { label })}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {t("settings.storageSettings.days")}
            </span>
            <NumberFieldIncrement
              aria-label={t("settings.storageSettings.increaseDayCount", { label })}
            />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">{t("settings.storageSettings.off")}</span>
      )}
      <Switch
        aria-label={label}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}

export function StorageSettingsPanel() {
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? t("settings.storageSettings.mixedAcrossMachines")
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } })
      : update(patch);

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice target="all">
        {t("settings.storageSettings.updateMachinesForProjectWorktreeCleanup")}
      </SettingsScopeNotice>
    );
  }

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        {t("settings.storageSettings.updateEnvironmentsForStorageCleanup")}
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="storage-worktrees" title={t("settings.storageSettings.worktrees")}>
        {isProjectScope && (
          <SettingsRow
            title={t("settings.storageSettings.automaticWorktreeCleanup")}
            description={
              mode === "off"
                ? t("settings.storageSettings.automaticWorktreeCleanupOff")
                : mode === "custom"
                  ? t("settings.storageSettings.automaticWorktreeCleanupCustom")
                  : t("settings.storageSettings.automaticWorktreeCleanupInherit")
            }
            serverScoped
            settingKeys={["worktreeCleanup"]}
            mixed={mixedModes}
            control={
              <Select
                value={mixedModes ? null : mode}
                onValueChange={(next) => {
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t("settings.storageSettings.automaticWorktreeCleanup")}
                >
                  <SelectValue>
                    {mixedModes
                      ? t("settings.storageSettings.mixed")
                      : mode === "inherit"
                        ? t("settings.storageSettings.inherit")
                        : mode === "off"
                          ? t("settings.storageSettings.off")
                          : t("settings.storageSettings.custom")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">{t("settings.storageSettings.inherit")}</SelectItem>
                  <SelectItem value="off">{t("settings.storageSettings.off")}</SelectItem>
                  <SelectItem value="custom">{t("settings.storageSettings.custom")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title={t("settings.storageSettings.deleteWorktreesWithDeletedThreads")}
              status={ruleStatus("worktreeOnDelete")}
              description={t(
                "settings.storageSettings.deleteWorktreesWithDeletedThreadsDescription",
              )}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storageSettings.deleteWorktreesWithDeletedThreads")}
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storageSettings.deleteInactiveWorktrees")}
              status={ruleStatus("worktreeAfterDays")}
              description={t("settings.storageSettings.deleteInactiveWorktreesDescription")}
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label={t("settings.storageSettings.deleteInactiveWorktrees")}
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storageSettings.deleteMergedWorktrees")}
              status={ruleStatus("worktreeOnMerge")}
              description={t("settings.storageSettings.deleteMergedWorktreesDescription")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storageSettings.deleteMergedWorktrees")}
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title={t("settings.storageSettings.deleteUnchangedWorktrees")}
              status={ruleStatus("worktreeUnchanged")}
              description={t("settings.storageSettings.deleteUnchangedWorktreesDescription")}
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label={t("settings.storageSettings.deleteUnchangedWorktrees")}
                  checked={settings.worktreeUnchanged}
                  onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                />
              }
            />
          </>
        )}
      </SettingsSection>

      {!isProjectScope && (
        <SettingsSection
          id="storage-artifacts"
          title={t("settings.storageSettings.artifactsAndLogs")}
        >
          <SettingsRow
            title={t("settings.storageSettings.deleteOldBrowserArtifacts")}
            status={ruleStatus("browserArtifactsAfterDays")}
            description={t("settings.storageSettings.deleteOldBrowserArtifactsDescription")}
            serverScoped
            control={
              <RetentionControl
                label={t("settings.storageSettings.deleteOldBrowserArtifacts")}
                value={settings.browserArtifactsAfterDays}
                onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
              />
            }
          />
          <SettingsRow
            title={t("settings.storageSettings.deleteOldRotatedLogs")}
            status={ruleStatus("logsAfterDays")}
            description={t("settings.storageSettings.deleteOldRotatedLogsDescription")}
            serverScoped
            control={
              <RetentionControl
                label={t("settings.storageSettings.deleteOldRotatedLogs")}
                value={settings.logsAfterDays}
                onChange={(logsAfterDays) => update({ logsAfterDays })}
              />
            }
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
