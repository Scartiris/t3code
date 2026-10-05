import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";
import { t } from "@t3tools/shared/i18n";

const mobileClientUpdatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", t("clerk.mobileClientsUserProfilePage.alertApprovals")],
  ["notifyOnInput", t("clerk.mobileClientsUserProfilePage.alertInputRequests")],
  ["notifyOnCompletion", t("clerk.mobileClientsUserProfilePage.alertCompletions")],
  ["notifyOnFailure", t("clerk.mobileClientsUserProfilePage.alertFailures")],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], string]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  const platform =
    device.platform === "android"
      ? "Android"
      : device.iosMajorVersion === null
        ? "iOS"
        : `iOS ${device.iosMajorVersion}`;
  return `${platform}${device.appVersion ? ` · T3 Code ${device.appVersion}` : ""}`;
}

export function mobileClientNotificationDetail(device: RelayClientDeviceRecord): string {
  if (!device.notifications.enabled) {
    return t("clerk.mobileClientsUserProfilePage.pushNotificationsDisabled");
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [label] : [],
  );
  return enabledPreferences.length > 0
    ? t("clerk.mobileClientsUserProfilePage.alertsEnabledFor", {
        types: enabledPreferences.join(", "),
      })
    : t("clerk.mobileClientsUserProfilePage.alertsEnabledNoTypesSelected");
}

export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? t("clerk.mobileClientsUserProfilePage.updatedAtUnavailable")
    : t("clerk.mobileClientsUserProfilePage.updatedAt", {
        time: mobileClientUpdatedAtFormatter.format(date),
      });
}
