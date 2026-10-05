import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { t } from "@t3tools/shared/i18n";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

// Reflects whether the relay actually accepted this device's registration.
// The notification and Live Activity switches are gated on this so they can
// never read as enabled when the device cannot receive anything (e.g. the
// registration request timed out).
function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

export function SettingsNotificationsRouteScreen() {
  if (!hasCloudPublicConfig()) {
    return (
      <SettingsScreen title={t("settings.settingsNotificationsRouteScreen.title")}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            {t("settings.settingsNotificationsRouteScreen.requiresConnect")}
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  return <ConfiguredSettingsNotificationsRouteScreen />;
}

function ConfiguredSettingsNotificationsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? t("settings.settingsNotificationsRouteScreen.installNewerBuild")
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");
  const liveActivityWriteInFlight = useRef(false);
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const canClearLiveActivitiesPreference =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.liveActivitiesEnabled !== false;

  const connections = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);
  const environmentCount = connections.length;

  const refreshNotifications = useCallback(async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      setNotificationStatus("unsupported");
      return;
    }
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refreshNotifications();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshNotifications();
    });
    return () => subscription.remove();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus("signed-out");
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) {
      if (AsyncResult.isFailure(preferencesResult)) {
        reportAtomCommandResult(preferencesResult, { label: "live activity preference load" });
        setLiveActivityStatus("enabled");
      } else {
        setLiveActivityStatus("checking");
      }
      return;
    }
    setLiveActivityStatus(
      preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled",
    );
  }, [isLoaded, isSignedIn, preferencesResult]);

  const requestNotifications = useCallback(async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          t("settings.settingsNotificationsRouteScreen.notificationsUnavailable"),
          error instanceof Error
            ? error.message
            : t("settings.settingsNotificationsRouteScreen.permissionRequestFailed"),
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      // Permission alone is not enough: the switch stays off until the relay
      // registration succeeds, so tell the user the truth about which happened.
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Alert.alert(
          t("settings.settingsNotificationsRouteScreen.notificationsEnabledTitle"),
          t("settings.settingsNotificationsRouteScreen.notificationsEnabledBody"),
        );
      } else {
        Alert.alert(
          t("settings.settingsNotificationsRouteScreen.enableNotificationsFailedTitle"),
          t("settings.settingsNotificationsRouteScreen.enableNotificationsFailedBody"),
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Alert.alert(
        t("settings.settingsNotificationsRouteScreen.notificationsUnavailable"),
        t("settings.settingsNotificationsRouteScreen.agentNotificationsUnsupported"),
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Alert.alert(
        t("settings.settingsNotificationsRouteScreen.notificationsDisabledTitle"),
        t("settings.settingsNotificationsRouteScreen.notificationsNotEnabledBody"),
      );
      return;
    }
    Alert.alert(
      t("settings.settingsNotificationsRouteScreen.notificationsDisabledTitle"),
      t("settings.settingsNotificationsRouteScreen.notificationsDeniedBody"),
      [
        { text: t("action.cancel"), style: "cancel" },
        {
          text: t("settings.settingsNotificationsRouteScreen.openSettings"),
          onPress: () => void Linking.openSettings(),
        },
      ],
    );
  }, []);

  const promptSignIn = useCallback(() => {
    Alert.alert(
      t("settings.settingsNotificationsRouteScreen.signInToConnectTitle"),
      t("settings.settingsNotificationsRouteScreen.signInToConnectBody"),
      [
        { text: t("action.cancel"), style: "cancel" },
        {
          text: t("settings.settingsNotificationsRouteScreen.continue"),
          onPress: () => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" }),
        },
      ],
    );
  }, [navigation]);

  const linkEnvironments = useCallback(async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    if (Platform.OS === "android") {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure") {
        setLiveActivityStatus("disabled");
        const error = squashAtomCommandFailure(permission);
        Alert.alert(
          t("settings.settingsNotificationsRouteScreen.ongoingActivityUnavailable"),
          error instanceof Error
            ? error.message
            : t("settings.settingsNotificationsRouteScreen.enableAgentNotificationsFailed"),
        );
        return;
      }
      if (permission.value.type !== "granted") {
        setLiveActivityStatus("disabled");
        Alert.alert(
          t("settings.settingsNotificationsRouteScreen.notificationPermissionNeededTitle"),
          t("settings.settingsNotificationsRouteScreen.notificationPermissionNeededBody"),
          [
            { text: t("action.cancel"), style: "cancel" },
            {
              text: t("settings.settingsNotificationsRouteScreen.openSettings"),
              onPress: () => void Linking.openSettings(),
            },
          ],
        );
        return;
      }
      setNotificationStatus("enabled");
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Alert.alert(
        Platform.OS === "android"
          ? t("settings.settingsNotificationsRouteScreen.ongoingActivityUnavailable")
          : t("settings.settingsNotificationsRouteScreen.liveActivitiesUnavailable"),
        error instanceof Error
          ? error.message
          : t("settings.settingsNotificationsRouteScreen.enableActivityUpdatesFailed"),
      );
      return;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: tokenResult.value,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Alert.alert(
          Platform.OS === "android"
            ? t("settings.settingsNotificationsRouteScreen.ongoingActivityUnavailable")
            : t("settings.settingsNotificationsRouteScreen.liveActivitiesUnavailable"),
          error instanceof Error
            ? error.message
            : t("settings.settingsNotificationsRouteScreen.enableActivityUpdatesFailed"),
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // The environment link can succeed while this device's own registration
    // (the push-to-start token the relay needs) has not — don't claim Live
    // Activities are live until the device is actually registered.
    if (getAgentAwarenessRegistrationStatus() === "registered") {
      Alert.alert(
        Platform.OS === "android"
          ? t("settings.settingsNotificationsRouteScreen.ongoingActivityEnabled")
          : t("settings.settingsNotificationsRouteScreen.liveActivitiesEnabled"),
        environmentCount > 0
          ? t("settings.settingsNotificationsRouteScreen.environmentsLinked", {
              count: environmentCount,
            })
          : t("settings.settingsNotificationsRouteScreen.activityUpdatesEnabledBody"),
      );
    } else {
      Alert.alert(
        t("settings.settingsNotificationsRouteScreen.finishEnablingActivityFailedTitle"),
        t("settings.settingsNotificationsRouteScreen.finishEnablingActivityFailedBody"),
      );
    }
  }, [
    connections,
    environmentCount,
    getToken,
    isSignedIn,
    liveActivitiesPreferenceEnabled,
    promptSignIn,
    savePreferences,
  ]);

  const handleDeviceNotificationsChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        if (!isSignedIn) {
          promptSignIn();
          return;
        }
        void requestNotifications();
        return;
      }

      Alert.alert(
        t("settings.settingsNotificationsRouteScreen.disableNotificationsTitle"),
        t("settings.settingsNotificationsRouteScreen.disableNotificationsBody"),
        [
          { text: t("action.cancel"), style: "cancel" },
          {
            text: t("settings.settingsNotificationsRouteScreen.openSettings"),
            onPress: () => void Linking.openSettings(),
          },
        ],
      );
    },
    [isSignedIn, promptSignIn, requestNotifications],
  );

  const handleLiveActivitiesChange = useCallback(
    (enabled: boolean) => {
      if (liveActivityWriteInFlight.current) return;
      if (!enabled) {
        liveActivityWriteInFlight.current = true;
        setLiveActivityStatus("linking");
        void (async () => {
          try {
            let token: string | null = null;
            if (isSignedIn) {
              const tokenResult = await settlePromise(() =>
                getToken(resolveRelayClerkTokenOptions()),
              );
              if (tokenResult._tag === "Failure") {
                setLiveActivityStatus("enabled");
                reportAtomCommandResult(tokenResult, {
                  label: "live activity disable token lookup",
                });
                return;
              }
              token = tokenResult.value;
            }

            const updateResult = await settleAsyncResult(() =>
              runtime.runPromiseExit(
                setLiveActivityUpdatesEnabled({
                  enabled: false,
                  previousEnabled: liveActivitiesPreferenceEnabled,
                  clerkToken: token,
                  connections,
                }),
              ),
            );
            if (updateResult._tag === "Failure") {
              setLiveActivityStatus(isSignedIn ? "enabled" : "signed-out");
              reportAtomCommandResult(updateResult, {
                label: "live activity disable",
              });
              return;
            }
            savePreferences({ liveActivitiesEnabled: false });
            refreshManagedRelayEnvironments();
            setLiveActivityStatus("disabled");
          } finally {
            liveActivityWriteInFlight.current = false;
          }
        })();
        return;
      }

      if (!isSignedIn) {
        promptSignIn();
        return;
      }

      liveActivityWriteInFlight.current = true;
      void linkEnvironments().finally(() => {
        liveActivityWriteInFlight.current = false;
      });
    },
    [
      connections,
      getToken,
      isSignedIn,
      linkEnvironments,
      liveActivitiesPreferenceEnabled,
      promptSignIn,
      savePreferences,
    ],
  );

  return (
    <SettingsScreen title={t("settings.settingsNotificationsRouteScreen.title")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={t("settings.settingsNotificationsRouteScreen.agentActivity")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={t("settings.settingsNotificationsRouteScreen.deviceNotifications")}
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            // Only reads as on when this device is actually registered with the
            // relay; otherwise notifications cannot be delivered regardless of
            // the local iOS permission.
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && deviceRegistered
            }
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !isLoaded ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label={
              Platform.OS === "android"
                ? supportsAndroidLiveUpdateSettings()
                  ? t("settings.settingsNotificationsRouteScreen.agentLiveUpdates")
                  : t("settings.settingsNotificationsRouteScreen.ongoingAgentActivity")
                : t("settings.settingsNotificationsRouteScreen.liveActivityUpdates")
            }
            subtitle={agentAwarenessSubtitle}
            // Same gate: a saved preference is meaningless until the device
            // registration the relay needs to push updates has succeeded.
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              deviceRegistered
            }
            onValueChange={handleLiveActivitiesChange}
          />
          {liveActivityStatus === "signed-out" && canClearLiveActivitiesPreference ? (
            <SettingsRow
              icon="bolt.circle"
              label={t("settings.settingsNotificationsRouteScreen.turnOffLiveActivityPreference")}
              onPress={() => handleLiveActivitiesChange(false)}
            />
          ) : null}
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label={t("settings.settingsNotificationsRouteScreen.liveUpdateSettings")}
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Alert.alert(
                    t("settings.settingsNotificationsRouteScreen.openSettingsFailedTitle"),
                    t("settings.settingsNotificationsRouteScreen.openSettingsFailedBody"),
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
