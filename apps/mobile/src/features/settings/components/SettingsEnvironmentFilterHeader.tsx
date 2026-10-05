import { useNavigation } from "@react-navigation/native";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { Platform, Pressable } from "react-native";

import { ControlPillMenu } from "../../../components/ControlPill";
import { SymbolView } from "../../../components/AppSymbol";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../../components/EnvironmentMachineSymbol";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { withNativeGlassHeaderItem } from "../../layout/native-glass-header-items";
import { useAdaptiveWorkspaceLayout } from "../../layout/AdaptiveWorkspaceLayout";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";

export function SettingsEnvironmentFilterHeader(props: {
  readonly closeSettings?: boolean;
  readonly trailingItems?: readonly NativeStackHeaderItem[];
}) {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const closeSettings = props.closeSettings === true && !layout.usesSplitView;
  const {
    availableTargets,
    selectedTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  if (Platform.OS !== "ios") return null;

  const filterIcon =
    selectedIds === null && selectedProjectKey === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const filterVersion = JSON.stringify({
    closeSettings,
    selection: selectedIds === null ? null : [...selectedIds].sort(),
    targets: availableTargets.map((entry) => [
      entry.environmentId,
      entry.label,
      entry.displayUrl,
      resolveEnvironmentMachineKind(entry.serverConfig),
    ]),
    project: selectedProjectKey,
    projects: selectableProjectGroups.map((group) => [group.key, group.label]),
    trailingItems: props.trailingItems,
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={filterVersion}
      options={{
        unstable_headerRightItems: () => [
          withNativeGlassHeaderItem({
            accessibilityLabel: t("components.settingsEnvironmentFilterHeader.filterA11y"),
            icon: { name: filterIcon, type: "sfSymbol" },
            label: "",
            type: "menu",
            menu: {
              title: t("components.settingsEnvironmentFilterHeader.scopeTitle"),
              items: [
                {
                  type: "submenu",
                  label:
                    selectedIds === null
                      ? t("components.settingsEnvironmentFilterHeader.allEnvironments")
                      : t("components.settingsEnvironmentFilterHeader.selectedEnvironments", {
                          count: selectedTargets.length,
                        }),
                  items: [
                    {
                      type: "action",
                      label: t(
                        "components.settingsEnvironmentFilterHeader.allConnectedEnvironments",
                      ),
                      state: selectedIds === null ? "on" : undefined,
                      onPress: selectAll,
                    },
                    ...availableTargets.map((entry) => ({
                      type: "action" as const,
                      label: entry.label,
                      icon: {
                        type: "sfSymbol" as const,
                        name: ENVIRONMENT_MACHINE_SYMBOLS[
                          resolveEnvironmentMachineKind(entry.serverConfig)
                        ],
                      },
                      description: entry.displayUrl ?? undefined,
                      state:
                        selectedIds === null || selectedIds.has(entry.environmentId)
                          ? ("on" as const)
                          : undefined,
                      onPress: () => toggleEnvironment(entry.environmentId),
                    })),
                  ],
                },
                {
                  type: "submenu",
                  label:
                    selectableProjectGroups.find((group) => group.key === selectedProjectKey)
                      ?.label ??
                    (selectedProjectKey === null
                      ? t("sidebar.allProjects")
                      : t("components.settingsEnvironmentFilterHeader.unavailableProject")),
                  items: [
                    {
                      type: "action",
                      label: t("sidebar.allProjects"),
                      state: selectedProjectKey === null ? "on" : undefined,
                      onPress: () => selectProject(null),
                    },
                    ...selectableProjectGroups.map((group) => ({
                      type: "action" as const,
                      label: group.label,
                      state: selectedProjectKey === group.key ? ("on" as const) : undefined,
                      onPress: () => selectProject(group.key),
                    })),
                  ],
                },
              ],
            },
          }),
          ...(props.trailingItems ?? []),
          ...(closeSettings
            ? [
                withNativeGlassHeaderItem({
                  accessibilityLabel: t("components.settingsEnvironmentFilterHeader.closeA11y"),
                  icon: { name: "xmark", type: "sfSymbol" },
                  identifier: "settings-close",
                  label: "",
                  onPress: () => navigation.goBack(),
                  type: "button",
                }),
              ]
            : []),
        ],
      }}
    />
  );
}

export function AndroidSettingsEnvironmentFilter() {
  const {
    availableTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  const filterIcon =
    selectedIds === null && selectedProjectKey === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";

  return (
    <ControlPillMenu
      accessible
      accessibilityRole="button"
      accessibilityLabel={t("components.settingsEnvironmentFilterHeader.filterA11y")}
      title={t("components.settingsEnvironmentFilterHeader.scopeTitle")}
      actions={[
        {
          id: "all",
          title: t("components.settingsEnvironmentFilterHeader.allConnectedEnvironments"),
          state: selectedIds === null ? ("on" as const) : ("off" as const),
        },
        ...availableTargets.map((entry) => ({
          id: `environment:${entry.environmentId}`,
          title: t("components.settingsEnvironmentFilterHeader.environmentOption", {
            label: entry.label,
          }),
          image: ENVIRONMENT_MACHINE_SYMBOLS[resolveEnvironmentMachineKind(entry.serverConfig)],
          subtitle: entry.displayUrl ?? undefined,
          state:
            selectedIds === null || selectedIds.has(entry.environmentId)
              ? ("on" as const)
              : ("off" as const),
        })),
        {
          id: "project:all",
          title: t("sidebar.allProjects"),
          state: selectedProjectKey === null ? ("on" as const) : ("off" as const),
        },
        ...selectableProjectGroups.map((group) => ({
          id: `project:${group.key}`,
          title: t("components.settingsEnvironmentFilterHeader.projectOption", {
            label: group.label,
          }),
          state: selectedProjectKey === group.key ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "all") selectAll();
        else if (nativeEvent.event === "project:all") selectProject(null);
        else if (nativeEvent.event.startsWith("project:")) {
          const group = selectableProjectGroups.find(
            (entry) => `project:${entry.key}` === nativeEvent.event,
          );
          if (group) selectProject(group.key);
        } else {
          const target = availableTargets.find(
            (entry) => `environment:${entry.environmentId}` === nativeEvent.event,
          );
          if (target) toggleEnvironment(target.environmentId);
        }
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("components.settingsEnvironmentFilterHeader.filterA11y")}
        className="size-11 items-center justify-center rounded-full"
      >
        <SymbolView name={filterIcon} size={22} tintColorClassName="accent-icon" />
      </Pressable>
    </ControlPillMenu>
  );
}
