import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { Platform, View } from "react-native";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { t } from "@t3tools/shared/i18n";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsRouteScreen() {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <>
      {Platform.OS === "ios" && layout.usesSplitView ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            accessibilityLabel={t("sidebar.back")}
            icon="chevron.left"
            onPress={() => navigation.goBack()}
          />
        </NativeHeaderToolbar>
      ) : null}
      <SettingsEnvironmentFilterHeader closeSettings />
      {Platform.OS === "android" ? (
        <SettingsScreen title={t("settings.title")} trailing={<AndroidSettingsEnvironmentFilter />}>
          {content}
        </SettingsScreen>
      ) : (
        content
      )}
    </>
  );
}

function ConfiguredSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const accountLabel = !isLoaded
    ? t("settings.settingsRouteScreen.accountChecking")
    : !isSignedIn
      ? t("settings.settingsRouteScreen.signIn")
      : (user?.primaryEmailAddress?.emailAddress ?? t("settings.settingsRouteScreen.signedIn"));

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={t("settings.section.connections")}>
          <SettingsRow
            icon="person.crop.circle"
            label={t("settings.settingsRouteScreen.t3Account")}
            value={accountLabel}
            disabled={!isLoaded}
            onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
          />
          <SettingsRow
            icon="desktopcomputer"
            label={t("settings.settingsRouteScreen.environments")}
            value={`${Object.keys(savedConnectionsById).length}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
          <SettingsRow
            icon="bell.badge"
            label={t("settings.settingsRouteScreen.notifications")}
            target="SettingsNotifications"
          />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={t("settings.section.connections")}>
          <SettingsRow
            icon="desktopcomputer"
            label={t("settings.settingsRouteScreen.environments")}
            value={`${environmentCount}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function SettingsIndexSections() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? t("settings.settingsRouteScreen.unavailableProject"));
  return (
    <>
      <SettingsSection title={t("settings.group.interface")}>
        <SettingsRow
          icon="paintbrush"
          label={t("settings.section.appearance")}
          target="SettingsAppearance"
        />
        {Platform.OS === "ios" ? (
          <SettingsRow
            icon="keyboard"
            label={t("settings.settingsRouteScreen.keyboard")}
            target="SettingsKeyboard"
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("settings.settingsRouteScreen.automations")}>
        <SettingsRow
          icon="clock"
          label={t("settings.settingsRouteScreen.scheduledTasks")}
          target="SettingsScheduledTasks"
        />
      </SettingsSection>

      <SettingsSection title={t("settings.group.projectsThreads")}>
        {selectedProjectKey !== null ? (
          <SettingsRow
            icon="folder"
            label={t("settings.settingsRouteScreen.overview")}
            value={projectLabel}
            target="SettingsProjectOverview"
          />
        ) : null}
        <SettingsRow
          icon="folder"
          label={t("settings.group.organization")}
          target="SettingsOrganization"
        />
        <SettingsRow
          icon="text.bubble"
          label={t("settings.settingsRouteScreen.threadBehavior")}
          target="SettingsThreads"
        />
        <SettingsRow
          icon="arrow.turn.left.up"
          label={t("settings.settingsRouteScreen.followUps")}
          target="SettingsFollowUp"
        />
        <SettingsRow
          icon="archivebox"
          label={t("settings.option.archivedThreads")}
          target="SettingsArchive"
        />
      </SettingsSection>

      <SettingsSection title={t("settings.settingsRouteScreen.serverSettings")}>
        <SettingsRow
          icon="person.crop.circle"
          label={t("settings.settingsRouteScreen.providerAccounts")}
          target="SettingsProviderAccounts"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.bubble"
          label={t("settings.option.newThreads")}
          target="SettingsEnvironmentNewThreads"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.triangle.branch"
          label={t("settings.option.sourceControl")}
          target="SettingsEnvironmentSourceControl"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.alignleft"
          label={t("settings.settingsRouteScreen.agentBehavior")}
          target="SettingsEnvironmentAgentBehavior"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.clockwise"
          label={t("settings.settingsRouteScreen.maintenance")}
          target="SettingsEnvironmentMaintenance"
          disabled={noServerTargets}
        />
      </SettingsSection>

      <SettingsSection title={t("settings.settingsRouteScreen.app")}>
        <SettingsRow icon="chart.bar.xaxis" label={t("sidebar.usage")} target="SettingsUsage" />
        <SettingsRow
          icon="info.circle"
          label={t("settings.settingsRouteScreen.aboutT3Code")}
          target="SettingsAbout"
        />
      </SettingsSection>
    </>
  );
}
