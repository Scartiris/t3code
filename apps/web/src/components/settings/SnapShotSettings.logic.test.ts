import { assert, expect, it } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type DesktopSnapShotState } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

import {
  createRecordingRequestTracker,
  snapShotStatus,
  snapShotShortcutStatus,
  snapShotUnavailableMessage,
  snapShotSoundPatch,
  snapShotFeedbackUnavailableMessage,
  snapShotSetupSummary,
  snapShotSetupButtonLabel,
  snapShotSetupComplete,
  snapShotDescription,
  snapShotAccessibilityUnavailableMessage,
} from "./SnapShotSettings.logic";

it.each([
  ["off", { snapShotPlaySound: false }],
  ["soft-pop", { snapShotPlaySound: true, snapShotSound: "soft-pop" }],
  ["camera-shutter", { snapShotPlaySound: true, snapShotSound: "camera-shutter" }],
] as const)("maps %s to compatible capture settings", (sound, patch) => {
  expect(snapShotSoundPatch(sound)).toEqual(patch);
});

it("offers effects only with a capable GNOME extension, explaining how to upgrade v1", () => {
  const state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: "gnome-extension",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
  };
  expect(snapShotFeedbackUnavailableMessage(state)).toContain("更新");
  expect(
    snapShotFeedbackUnavailableMessage({ ...state, linuxFeedbackAvailable: true }),
  ).toBeUndefined();
  expect(snapShotFeedbackUnavailableMessage({ ...state, linuxBackend: "picker" })).toContain(
    "不支持捕获效果",
  );
  expect(snapShotFeedbackUnavailableMessage({ ...state, mode: "direct" })).toBeUndefined();
});

it("ignores a stale request after a newer request starts", () => {
  const requests = createRecordingRequestTracker();
  const firstRequest = requests.tryBegin();
  assert(firstRequest);

  requests.clear();
  const secondRequest = requests.tryBegin();
  assert(secondRequest);

  expect(requests.owns(firstRequest)).toBe(false);
  expect(requests.owns(secondRequest)).toBe(true);
  expect(requests.tryBegin()).toBeNull();
});

it("reports unavailable capture support without browser globals", () => {
  expect(snapShotUnavailableMessage(false)).toBe(t("settings.snapShotSettings.desktopAppOnly"));
});

it("describes Niri setup without claiming a global shortcut is registered", () => {
  const state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: "niri",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutMessage: "Managed by Niri",
    message: null,
  };
  expect(snapShotStatus(state, true)).toBe(t("settings.snapShotSettings.finishShortcutSetup"));
  expect(snapShotStatus(state, true)).not.toContain("could not be registered");
  expect(snapShotFeedbackUnavailableMessage(state)).toContain("不支持捕获效果");
});

it("distinguishes Hyprland helper setup, action registration, and verified shortcut delivery", () => {
  const state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: "hyprland",
    linuxDesktop: "hyprland",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutMessage: "Connecting to Hyprland shortcuts…",
    message: null,
    hyprlandHelper: { status: "not-installed", message: "Install helper" },
  };
  expect(snapShotSetupButtonLabel(state)).toBe(
    t("settings.snapShotSettings.setUpCaptureFor", { desktop: "Hyprland" }),
  );
  expect(snapShotStatus(state, false)).toBe(t("settings.snapShotSettings.turnOnToSetUpSnapshots"));
  expect(snapShotStatus(state, true)).toContain("安装捕获辅助程序");
  expect(snapShotFeedbackUnavailableMessage(state)).toContain("安装或更新");
  const ready = {
    ...state,
    hyprlandHelper: { status: "ready" as const, message: "Ready" },
    linuxFeedbackAvailable: true,
  };
  expect(snapShotSetupButtonLabel(ready)).toBe(t("settings.snapShotSettings.manageCapture"));
  expect(snapShotShortcutStatus({ ...ready, shortcutPending: true })).not.toContain("permission");
  expect(snapShotStatus({ ...ready, shortcutActionRegistered: true }, true)).toBe(
    t("settings.snapShotSettings.useShortcutFromAnotherApp"),
  );
  expect(snapShotStatus({ ...ready, shortcutVerified: true }, true)).toBe(
    t("settings.snapShotSettings.readyToCapture"),
  );
  expect(snapShotFeedbackUnavailableMessage(ready)).toBeUndefined();
  expect(snapShotAccessibilityUnavailableMessage(ready)).toBeUndefined();
});

it("keeps unavailable capture distinct from the opt-in setup prompt", () => {
  const state: DesktopSnapShotState = {
    mode: "unavailable",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutMessage: null,
    message: "Wayland is required.",
  };

  expect(snapShotStatus(state, false)).toBe("Wayland is required.");
});

it.each(["gnome-extension", "niri", "screenshot-portal", "picker"] as const)(
  "waits for opt-in before presenting %s setup requirements",
  (linuxBackend) => {
    const state: DesktopSnapShotState = {
      mode: "portal",
      linuxBackend,
      shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
      shortcutRegistered: false,
      shortcutMessage: "Shortcut permission needed",
      message: "Capture needs attention",
      gnomeExtension: { status: "not-installed", message: "Install the extension" },
    };

    expect(DEFAULT_CLIENT_SETTINGS.snapShotEnabled).toBe(false);
    expect(snapShotStatus(state, false)).toBe(
      t("settings.snapShotSettings.turnOnToSetUpSnapshots"),
    );
    expect(snapShotStatus(state, true)).toBe(t("settings.snapShotSettings.captureNeedsAttention"));
  },
);

it("distinguishes saved shortcuts from observed delivery without making users repeat setup", () => {
  const state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: "gnome-extension",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: "Requested",
    message: null,
    gnomeExtension: { status: "enabled", message: "Running" },
  };
  expect(snapShotSetupSummary(state, true)).toBe(t("settings.snapShotSettings.shortcutSaved"));
  expect(snapShotSetupButtonLabel(state)).toBe(t("settings.snapShotSettings.manageCapture"));
  expect(snapShotSetupSummary({ ...state, shortcutVerified: true }, true)).toBe(
    t("settings.snapShotSettings.readyToCapture"),
  );
  expect(snapShotSetupButtonLabel({ ...state, shortcutVerified: true })).toBe(
    t("settings.snapShotSettings.manageCapture"),
  );
  expect(snapShotSetupButtonLabel({ ...state, shortcutRegistered: false })).toBe(
    t("settings.snapShotSettings.manageCapture"),
  );
  expect(
    snapShotSetupButtonLabel({
      ...state,
      gnomeExtension: { status: "disabled", message: "Enable the extension" },
    }),
  ).toBe(t("settings.snapShotSettings.setUpCaptureFor", { desktop: "GNOME" }));
  expect(snapShotSetupSummary({ ...state, shortcutVerified: true }, false)).toContain("启用捕获");
  expect(
    snapShotSetupSummary(
      {
        ...state,
        gnomeExtension: { status: "restart-required", message: "Sign out" },
        shortcutVerified: true,
      },
      true,
    ),
  ).toBe(t("settings.snapShotSettings.setUpActiveWindowSnapshots"));
  expect(
    snapShotSetupSummary(
      { ...state, linuxBackend: "niri", gnomeExtension: undefined, shortcutRegistered: false },
      true,
    ),
  ).toBe(t("settings.snapShotSettings.finishShortcutSetup"));
  expect(
    snapShotSetupSummary(
      { ...state, linuxBackend: "picker", gnomeExtension: undefined, shortcutVerified: true },
      true,
    ),
  ).toBe(t("settings.snapShotSettings.manualCaptureOnly"));
  expect(
    snapShotSetupSummary(
      {
        ...state,
        linuxBackend: "screenshot-portal",
        gnomeExtension: { status: "not-installed", message: "Optional extension" },
        shortcutVerified: true,
      },
      true,
    ),
  ).toBe(t("settings.snapShotSettings.readyToCapture"));
});

it.each([
  ["gnome", "GNOME"],
  ["kde", "KDE Plasma"],
  ["niri", "Niri"],
] as const)(
  "names %s when setup cannot yet determine the capture backend",
  (linuxDesktop, name) => {
    const state: DesktopSnapShotState = {
      mode: "portal",
      linuxDesktop,
      shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
      shortcutRegistered: false,
      shortcutMessage: null,
      message: "Capability check failed",
    };
    expect(snapShotSetupButtonLabel(state)).toBe(
      t("settings.snapShotSettings.setUpCaptureFor", { desktop: name }),
    );
  },
);

it("keeps picker limitations visible after shortcut verification without recommending a GNOME extension", () => {
  const state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: "picker",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
    shortcutVerified: true,
  };
  expect(snapShotStatus(state, true)).toContain("仅支持手动捕获");
  expect(snapShotDescription(state)).toContain("不支持自动捕获");
  expect(snapShotFeedbackUnavailableMessage(state)).not.toContain("GNOME");
  expect(snapShotAccessibilityUnavailableMessage(state)).toContain("仅提供屏幕截图");
  expect(
    snapShotAccessibilityUnavailableMessage({ ...state, linuxBackend: "screenshot-portal" }),
  ).toContain("仅提供屏幕截图");
  expect(
    snapShotAccessibilityUnavailableMessage({ ...state, linuxBackend: "kde" }),
  ).toBeUndefined();
  expect(snapShotFeedbackUnavailableMessage({ ...state, linuxBackend: "kde" })).toContain(
    "捕获辅助程序",
  );
  expect(
    snapShotFeedbackUnavailableMessage({
      ...state,
      linuxBackend: "kde",
      linuxFeedbackAvailable: true,
      kdeHelper: { status: "ready", message: "Ready", feedbackAvailable: true },
    }),
  ).toBeUndefined();
  expect(
    snapShotStatus(
      { ...state, linuxBackend: "kde", kdeHelper: { status: "not-installed", message: "Install" } },
      true,
    ),
  ).toContain("安装捕获辅助程序");
});

it("does not ask Niri users to repeat setup when its capture endpoint is available", () => {
  const state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: "niri",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutBinding: "Ctrl+Shift+2 { spawn ...; }",
    shortcutMessage: null,
    message: null,
  };
  expect(snapShotStatus(state, true)).toBe(
    t("settings.snapShotSettings.useShortcutFromAnotherApp"),
  );
  expect(snapShotSetupButtonLabel(state)).toBe(t("settings.snapShotSettings.manageCapture"));
});

it("reports pending, denied, and assigned shortcuts without inferring consent from saved keys", () => {
  const state: DesktopSnapShotState = {
    mode: "portal",
    linuxBackend: "screenshot-portal",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutPending: true,
    shortcutMessage: null,
    message: null,
  };
  expect(snapShotStatus(state, true)).toContain("等待快捷键权限");
  expect(snapShotShortcutStatus(state)).toContain("批准快捷键权限提示");
  const denied = { ...state, shortcutPending: false, shortcutMessage: "Permission wasn't granted" };
  expect(snapShotShortcutStatus(denied)).toBe("Permission wasn't granted");
  const approved = {
    ...denied,
    shortcutRegistered: true,
    shortcutLabel: "Press <Shift><Control>2",
    shortcutMessage: "Desktop shortcut: Press <Shift><Control>2",
  };
  expect(snapShotStatus(approved, true)).toBe(t("settings.snapShotSettings.readyToCapture"));
  expect(snapShotShortcutStatus(approved)).toBeNull();
  expect(snapShotShortcutStatus({ ...approved, shortcutPending: true })).toContain(
    "批准快捷键权限提示",
  );
  expect(
    snapShotShortcutStatus({
      ...approved,
      shortcutRegistered: false,
      shortcutMessage: "Permission wasn't granted",
    }),
  ).toBe("Permission wasn't granted");
});

it("hides macOS setup only while permissions and the shortcut are all in place", () => {
  const ready: DesktopSnapShotState = {
    mode: "direct",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
    macPermissions: { screenRecording: true, accessibility: true },
  };
  expect(snapShotSetupComplete(ready, true)).toBe(true);
  expect(snapShotSetupComplete({ ...ready, macPermissions: undefined }, true)).toBe(false);
  expect(snapShotSetupComplete({ ...ready, shortcutRegistered: false }, true)).toBe(false);
  const revoked = {
    ...ready,
    macPermissions: { screenRecording: true, accessibility: false },
    message: "Allow Accessibility in System Settings, then restart T3 Code.",
  };
  expect(snapShotSetupComplete(revoked, true)).toBe(false);
  expect(snapShotStatus(revoked, true)).toBe(t("settings.snapShotSettings.captureNeedsAttention"));
  expect(snapShotSetupButtonLabel(revoked)).toBe(t("settings.snapShotSettings.continueSetup"));
  expect(snapShotSetupComplete({ ...revoked, message: null }, false)).toBe(true);
  expect(
    snapShotSetupComplete(
      { ...ready, windows: true, macPermissions: undefined, shortcutRegistered: false },
      true,
    ),
  ).toBe(true);
});
