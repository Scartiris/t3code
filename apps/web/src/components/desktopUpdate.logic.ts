import { t } from "@t3tools/shared/i18n";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DESKTOP_RELEASE_HISTORY_URL = "https://github.com/pingdotgg/t3code/releases";
const DESKTOP_RELEASE_TAG_URL = `${DESKTOP_RELEASE_HISTORY_URL}/tag`;

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** Release notes for an exact downloaded build; nightly suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(): string {
  return DESKTOP_RELEASE_HISTORY_URL;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return t("components.desktopUpdate.correctArchitecture");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return t("components.desktopUpdate.appleSiliconDownloadUpdate");
  }
  if (action === "install") {
    return t("components.desktopUpdate.appleSiliconRestartToInstall");
  }
  return t("components.desktopUpdate.appleSiliconNextUpdate");
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  const versionFallback = t("components.desktopUpdate.versionFallback");
  if (state.status === "available") {
    return t("components.desktopUpdate.updateReadyToDownload", {
      version: state.availableVersion ?? versionFallback,
    });
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return t("components.desktopUpdate.downloadingUpdate", { progress });
  }
  if (state.status === "downloaded") {
    return t("components.desktopUpdate.updateDownloadedRestartToInstall", {
      version: state.downloadedVersion ?? state.availableVersion ?? versionFallback,
    });
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return t("components.desktopUpdate.downloadFailedRetry", {
        version: state.availableVersion,
      });
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return t("components.desktopUpdate.installFailedRetry", {
        version: state.downloadedVersion,
      });
    }
    if (state.downloadedVersion) {
      return t("components.desktopUpdate.updateDownloadedRestartToInstall", {
        version: state.downloadedVersion,
      });
    }
    return state.message ?? t("components.desktopUpdate.updateFailed");
  }
  return t("components.desktopUpdate.upToDate");
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return t("components.desktopUpdate.installConfirmation", {
    version: version ? ` ${version}` : "",
  });
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}
