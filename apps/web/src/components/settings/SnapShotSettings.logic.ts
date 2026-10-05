import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(state: DesktopSnapShotState | null, enabled: boolean): string {
  if (!state) return t("settings.snapShotSettings.checkingSnapshots");
  if (state.mode === "unavailable")
    return state.message ?? t("settings.snapShotSettings.notSupportedOnPlatform");
  if (!enabled) return t("settings.snapShotSettings.turnOnToSetUpSnapshots");
  return snapShotSetupSummary(state, enabled);
}

export function snapShotSetupSummary(state: DesktopSnapShotState, enabled: boolean): string {
  if (state.message) return t("settings.snapShotSettings.captureNeedsAttention");
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? t("settings.snapShotSettings.checkCaptureAccessInSetup")
      : t("settings.snapShotSettings.installCaptureHelperToContinue");
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return t("settings.snapShotSettings.setUpActiveWindowSnapshots");
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? t("settings.snapShotSettings.checkCaptureAccessInSetup")
      : t("settings.snapShotSettings.installCaptureHelperToContinue");
  if (captureSetupBackend(state) === "picker")
    return t("settings.snapShotSettings.manualCaptureOnly");
  if (!enabled) return t("settings.snapShotSettings.enableCaptureToContinue");
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? t("settings.snapShotSettings.connectingShortcut")
      : t("settings.snapShotSettings.waitingForShortcutPermission");
  if (state.shortcutVerified) return t("settings.snapShotSettings.readyToCapture");
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return t("settings.snapShotSettings.useShortcutFromAnotherApp");
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return t("settings.snapShotSettings.useShortcutFromAnotherApp");
  if (state.shortcutRegistered)
    return state.shortcutLabel
      ? t("settings.snapShotSettings.readyToCapture")
      : t("settings.snapShotSettings.shortcutSaved");
  return t("settings.snapShotSettings.finishShortcutSetup");
}

export function snapShotShortcutStatus(state: DesktopSnapShotState | null): string | null {
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending) return t("settings.snapShotSettings.approveShortcutPermissionPrompt");
  if (state.shortcutRegistered)
    return state.mode === "portal" ? null : t("settings.snapShotSettings.shortcutSaved");
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(state: DesktopSnapShotState | null): string {
  if (!state) return t("settings.snapShotSettings.continueSetup");
  if (captureSetupAccessReady(state)) return t("settings.snapShotSettings.manageCapture");
  const desktop = captureSetupDesktopName(state);
  return desktop
    ? t("settings.snapShotSettings.setUpCaptureFor", { desktop })
    : t("settings.snapShotSettings.continueSetup");
}

// Windows needs no permissions or setup: turning capture on is enough. macOS setup
// has nothing left to manage once permissions and the shortcut are in place; the
// shortcut row stays editable inline. Revoking a permission brings the button back
// as "Continue setup" through the state message.
export function snapShotSetupComplete(
  state: DesktopSnapShotState | null,
  includeAccessibility: boolean,
): boolean {
  if (state?.windows) return true;
  return (
    state?.macPermissions !== undefined &&
    captureSetupAccessReady(state) &&
    captureSetupMacPermissionsReady(state, includeAccessibility) &&
    state.shortcutRegistered
  );
}

export type SnapShotSoundSelection = SnapShotSound | "off";

export function snapShotFeedbackUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "hyprland")
    return state.hyprlandHelper?.status === "ready"
      ? t("settings.snapShotSettings.captureEffectsUnavailableOnDesktop")
      : t("settings.snapShotSettings.installOrUpdateCaptureHelper");
  if (state.linuxBackend === "niri")
    return t("settings.snapShotSettings.captureEffectsUnavailableOnNiri");
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? t("settings.snapShotSettings.captureEffectsUnavailableOnDesktop")
      : t("settings.snapShotSettings.installOrUpdateCaptureHelper");
  return state.linuxBackend === "gnome-extension"
    ? t("settings.snapShotSettings.updateGnomeExtensionForEffects")
    : captureSetupBackend(state) === "gnome"
      ? t("settings.snapShotSettings.finishExtensionSetupForEffects")
      : t("settings.snapShotSettings.captureEffectsUnavailableOnDesktop");
}

export function snapShotDescription(state: DesktopSnapShotState | null): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? t("settings.snapShotSettings.automaticCaptureUnavailable")
    : t("settings.snapShotSettings.captureWindowDescription");
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return t("settings.snapShotSettings.desktopProvidesScreenshotOnly");
  return undefined;
}

export function snapShotUnavailableMessage(hasBridge: boolean): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? t("settings.snapShotSettings.updateDesktopAppForSnapshots")
    : t("settings.snapShotSettings.desktopAppOnly");
}

export function snapShotSoundPatch(sound: SnapShotSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { snapShotPlaySound: false }
    : { snapShotPlaySound: true, snapShotSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}
