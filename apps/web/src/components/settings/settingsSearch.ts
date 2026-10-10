import { isElectron } from "~/env";
import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";
import { STATIC_KEYBINDING_COMMANDS, type KeybindingCommand } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { t } from "@t3tools/shared/i18n";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { commandLabel } from "./KeybindingsSettings.logic";
import {
  validateSettingsScopeSearch,
  type ResolvedSettingsScope,
  type SettingsScopeSearch,
} from "./settingsScope";

export type SettingsPath =
  | "/settings/projects"
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/snap-shot"
  | "/settings/providers"
  | "/settings/openviking"
  | "/settings/cc-switch"
  | "/settings/integrations"
  | "/settings/scheduled-tasks"
  | "/settings/source-control"
  | "/settings/storage"
  | "/settings/connections"
  | "/settings/archived";

/**
 * Where a setting can be edited. Device-local rows have no scope: they render
 * at every selection. `project-defaults` rows accept project overrides, so
 * they are reachable from any server-backed selection.
 */
export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  /** Descriptions, option labels, and aliases people may remember instead of the title. */
  readonly searchTerms?: ReadonlyArray<string>;
  readonly scope?: SettingsSearchScope;
  // Its row only renders in the desktop app, so a browser result would land on
  // an anchor that isn't there.
  readonly desktopOnly?: boolean;
  readonly macOnly?: boolean;
  // Its row only renders on Windows desktop, so other desktop platforms must
  // not expose a result that points to a missing anchor.
  readonly windowsOnly?: boolean;
  readonly cloudOnly?: boolean;
  readonly environmentOnly?: boolean;
  readonly providerSettingsOnly?: boolean;
  readonly macProviderSettingsOnly?: boolean;
  readonly localBackendManagementOnly?: boolean;
  readonly localEnvironmentOnly?: boolean;
  readonly wslAvailableOnly?: boolean;
  /**
   * Sorts after every other match. Keybinding commands mirror rows on other
   * surfaces, so "model" must still lead with Default model, not Model Picker.
   */
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

export interface SettingsSearchAvailability {
  readonly localEnvironmentDisabled?: boolean;
  readonly hasCloudPublicConfig: boolean;
  readonly hasEnvironment: boolean;
  readonly hasProviderSettingsEnvironment: boolean;
  readonly hasMacProviderSettingsEnvironment: boolean;
  readonly canManageLocalBackend: boolean;
  readonly isWslSettingsRowVisible: boolean;
  readonly hasThreadAutoSettlement: boolean;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/projects": t("settings.settingsSearch.projects"),
  "/settings/general": t("settings.settingsSearch.general"),
  "/settings/appearance": t("settings.settingsSearch.appearance"),
  "/settings/keybindings": t("settings.settingsSearch.keybindings"),
  "/settings/snap-shot": t("settings.settingsSearch.snapShots"),
  "/settings/providers": t("settings.settingsSearch.providers"),
  "/settings/openviking": "OpenViking",
  "/settings/cc-switch": "CC Switch",
  "/settings/integrations": t("settings.settingsSearch.integrations"),
  "/settings/scheduled-tasks": t("settings.settingsSearch.scheduledTasks"),
  "/settings/source-control": t("settings.settingsSearch.sourceControl"),
  "/settings/storage": t("settings.settingsSearch.storage"),
  "/settings/connections": t("settings.settingsSearch.connections"),
  "/settings/archived": t("settings.settingsSearch.archive"),
};

/** Anchor id of the first row bound to `command` on the Keybindings page. */
export function keybindingSearchAnchorId<Command extends KeybindingCommand>(command: Command) {
  return `keybinding-${command}` as const;
}

/**
 * One result per built-in command, alphabetical by label. The anchor is
 * the command's first row; default keys are searchable so "mod+b" lands on
 * Sidebar: Toggle. A command with no default binding may have no row, so it
 * points at the section instead.
 */
const KEYBINDING_SEARCH_ITEMS = STATIC_KEYBINDING_COMMANDS.toSorted((left, right) =>
  commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => {
  const defaultKeys = DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
    (binding) => binding.key,
  );
  return {
    id: keybindingSearchAnchorId(command),
    title: commandLabel(command),
    to: "/settings/keybindings" as const,
    searchTerms: [command, ...defaultKeys],
    secondary: true,
    ...(defaultKeys.length === 0 ? { targetId: "keybindings" } : {}),
  };
});

/**
 * Searchable settings and stable destinations, in result order. Rows with a
 * dedicated anchor render their id and title via `searchableSetting`; items
 * that may not be mounted point at their nearest stable section instead.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "storage-worktrees",
    title: t("settings.settingsSearch.storageWorktrees"),
    to: "/settings/storage",
    scope: "project-defaults",
    searchTerms: [
      "disk storage delete deleted archived threads old inactive merged unchanged worktrees retention days project inherit off custom",
    ],
  },
  {
    id: "storage-artifacts",
    title: t("settings.settingsSearch.storageArtifacts"),
    to: "/settings/storage",
    scope: "environment-defaults",
    searchTerms: ["disk storage browser screenshots captures rotated logs cleanup retention"],
  },
  {
    id: "project-defaults",
    title: t("settings.settingsSearch.projectDefaults"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["model workspace environments projects inheritance checkout"],
  },
  {
    id: "project-overview",
    title: t("settings.settingsSearch.projectOverview"),
    to: "/settings/projects",
    searchTerms: ["name icon emoji image checkout remove delete"],
  },
  {
    id: "default-model",
    title: t("settings.settingsSearch.defaultModel"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["new thread project provider reasoning effort"],
  },
  {
    id: "default-permissions",
    title: t("settings.settingsSearch.permissions"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: [
      "new thread default runtime mode supervised approvals auto accept edits full access",
    ],
  },
  {
    id: "color-scheme",
    title: t("settings.settingsSearch.colorScheme"),
    to: "/settings/appearance",
    searchTerms: ["appearance light dark system mode"],
    // The scheme tiles sit at the top of the Appearance section.
    targetId: "appearance",
  },
  {
    id: "theme",
    title: t("settings.settingsSearch.themes"),
    to: "/settings/appearance",
    searchTerms: ["appearance colors palette custom import"],
    // Theme cards live directly under the scheme tiles; the section is the
    // stable scroll destination for both.
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    title: t("settings.settingsSearch.contrast"),
    to: "/settings/appearance",
    searchTerms: ["colors borders interface"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: t("settings.settingsSearch.glassOpacity"),
    to: "/settings/appearance",
    searchTerms: ["transparent transparency solid menus dialogs composer"],
  },
  {
    id: "diff-color-scheme",
    title: t("settings.settingsSearch.diffColors"),
    to: "/settings/appearance",
    searchTerms: ["red green blue orange additions deletions changes counts palette colorblind"],
  },
  {
    id: "chat-width",
    title: t("settings.settingsSearch.chatWidth"),
    to: "/settings/appearance",
    searchTerms: ["wide full width column layout messages composer monitor"],
  },
  {
    id: "panel-animations",
    title: t("settings.settingsSearch.panelAnimations"),
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: t("settings.settingsSearch.environmentIdentification"),
    to: "/settings/appearance",
    searchTerms: ["dev nightly artwork pill label hide none"],
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance-interface",
  },
  {
    id: "interface-font",
    title: t("settings.settingsSearch.interfaceFont"),
    to: "/settings/appearance",
    searchTerms: ["typography family size system sans"],
  },
  {
    id: "prompt-font",
    title: t("settings.settingsSearch.promptFont"),
    to: "/settings/appearance",
    searchTerms: ["typography family size composer input"],
  },
  {
    id: "code-font",
    title: t("settings.settingsSearch.codeFont"),
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace code blocks diffs file previews"],
  },
  {
    id: "terminal-font",
    title: t("settings.settingsSearch.terminalFont"),
    to: "/settings/appearance",
    searchTerms: ["typography family size monospace output"],
  },
  {
    id: "font-smoothing",
    title: t("settings.settingsSearch.fontSmoothing"),
    to: "/settings/appearance",
    searchTerms: ["typography text grayscale anti aliasing macos thin"],
    macOnly: true,
  },
  {
    id: "word-wrap",
    title: t("settings.settingsSearch.wordWrap"),
    to: "/settings/appearance",
    searchTerms: ["long lines code blocks tables diffs file previews"],
  },
  {
    id: "composer-context",
    title: t("settings.settingsSearch.composerContext"),
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: t("settings.settingsSearch.projectGrouping"),
    to: "/settings/general",
    searchTerms: ["combine matching repositories environments sidebar"],
  },
  {
    id: "project-order",
    title: t("settings.settingsSearch.projectOrder"),
    to: "/settings/general",
    searchTerms: ["sort projects sidebar manual created recent"],
  },
  {
    id: "snooze-limited-threads",
    title: t("settings.settingsSearch.snoozeLimitedThreads"),
    to: "/settings/general",
    searchTerms: ["usage quota rate limit reset wake recover continue"],
  },
  {
    id: "auto-resume-limited-threads",
    title: t("settings.settingsSearch.autoResumeLimitedThreads"),
    to: "/settings/general",
    searchTerms: ["usage quota rate limit reset recover continue"],
  },
  {
    id: "working-shelf",
    title: t("settings.settingsSearch.workingSectionBeta"),
    to: "/settings/general",
    searchTerms: ["hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "auto-settle-inactive-threads",
    title: t("settings.settingsSearch.autoSettleInactiveThreads"),
    to: "/settings/general",
    searchTerms: ["sidebar inactivity days no activity automatically"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "auto-settle-merged-threads",
    title: t("settings.settingsSearch.autoSettleMergedThreads"),
    to: "/settings/general",
    searchTerms: ["pull request merge closed automatically sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "days-before-auto-settle",
    title: t("settings.settingsSearch.daysBeforeAutoSettle"),
    to: "/settings/general",
    targetId: "auto-settle-inactive-threads",
    searchTerms: ["thread timeout activity sidebar"],
    requiresThreadAutoSettlement: true,
    scope: "project-defaults",
  },
  {
    id: "thread-notifications",
    title: t("settings.settingsSearch.threadNotifications"),
    to: "/settings/general",
    searchTerms: ["notification sound alert completion input approval desktop"],
  },
  {
    id: "in-app-notifications",
    title: t("settings.settingsSearch.inAppNotifications"),
    to: "/settings/general",
    searchTerms: ["notification toast popup completion input approval failure"],
  },
  {
    id: "time-format",
    title: t("settings.settingsSearch.timeFormat"),
    to: "/settings/general",
    searchTerms: ["timestamp clock locale system browser os 12 hour 24 hour"],
  },
  {
    id: "response-streaming",
    title: t("settings.settingsSearch.responseStreaming"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["output token paragraph buffered wait turn legacy"],
  },
  {
    id: "hide-whitespace-changes",
    title: t("settings.settingsSearch.hideWhitespaceChanges"),
    to: "/settings/general",
    searchTerms: ["diff ignore spaces edits default"],
  },
  {
    id: "default-diff-file-state",
    title: t("settings.settingsSearch.defaultDiffFileState"),
    to: "/settings/general",
    searchTerms: ["collapsed expanded collapse expand files pull request pr code tab"],
  },
  {
    id: "diff-layout",
    title: t("settings.settingsSearch.diffLayout"),
    to: "/settings/general",
    searchTerms: ["stacked split side by side unified inline view"],
  },
  {
    id: "proactive-panels",
    title: t("settings.settingsSearch.proactivePanels"),
    to: "/settings/general",
    searchTerms: ["automatically open diff pull request pr right panel agent completion"],
  },
  {
    id: "skills-in-slash-menu",
    title: t("settings.settingsSearch.skillsInSlashMenu"),
    to: "/settings/general",
    searchTerms: ["command menu dollar $ slash /"],
  },
  {
    id: "composer-rich-text",
    title: t("settings.settingsSearch.richTextComposer"),
    to: "/settings/general",
    searchTerms: ["composer rich text tiptap bold italic markdown styled wysiwyg"],
  },
  {
    id: "composer-collapse",
    title: t("settings.settingsSearch.collapseComposer"),
    to: "/settings/general",
    searchTerms: ["composer rest resting scroll wheel conversation timeline shrink minimize"],
  },
  {
    id: "send-shortcut",
    title: t("settings.settingsSearch.sendShortcut"),
    to: "/settings/general",
    searchTerms: ["enter return command ctrl multiline prompt new line composer"],
  },
  {
    id: "follow-up-behavior",
    title: t("settings.settingsSearch.followUpBehavior"),
    to: "/settings/general",
    searchTerms: ["queue steer running turn send default behavior composer"],
  },
  {
    id: "provider-update-checks",
    title: t("settings.settingsSearch.providerUpdateChecks"),
    to: "/settings/general",
    searchTerms: ["installed cli versions newer available codex claude cursor grok opencode"],
    scope: "environment-defaults",
  },
  {
    id: "continue-threads-after-server-update",
    title: t("settings.settingsSearch.continueThreadsAfterRestarts"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    title: t("settings.settingsSearch.backgroundActivity"),
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "new-threads",
    title: t("settings.settingsSearch.newThreads"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["default workspace mode draft local worktree"],
  },
  {
    id: "worktree-submodules",
    title: t("settings.settingsSearch.submodules"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["git submodule init recursive top-level none worktree t3.json"],
  },
  {
    id: "start-from-origin",
    title: t("settings.settingsSearch.startFromOrigin"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["new worktrees latest matching remote branch local"],
  },
  {
    id: "add-project-starts-in",
    title: t("settings.settingsSearch.addProjectStartsIn"),
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    id: "unpin-confirmation",
    title: t("settings.settingsSearch.unpinConfirmation"),
    to: "/settings/general",
    searchTerms: ["ask before thread pinned section"],
  },
  {
    id: "archive-confirmation",
    title: t("settings.settingsSearch.archiveConfirmation"),
    to: "/settings/general",
    searchTerms: ["ask before thread second click inline action"],
  },
  {
    id: "delete-confirmation",
    title: t("settings.settingsSearch.deleteConfirmation"),
    to: "/settings/general",
    searchTerms: ["ask before thread chat history"],
  },
  {
    id: "quit-confirmation",
    title: t("settings.settingsSearch.quitShortcut"),
    to: "/settings/general",
    searchTerms: ["confirmation desktop app exit direct hold double click press twice"],
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: t("settings.settingsSearch.textGenerationModel"),
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: ["generated thread titles source control content default provider"],
  },
  {
    id: "cc-switch",
    title: "CC Switch 统一模型网关",
    to: "/settings/cc-switch",
    searchTerms: [
      "ccswitch packyapi API key 模型 网关 统一 站点 多站点 提供商 provider Claude Code Codex OpenCode",
    ],
    scope: "environment",
  },
  {
    id: "openviking-memory",
    title: t("settings.memory.title"),
    to: "/settings/openviking",
    searchTerms: ["openviking memory 记忆 长期记忆 API key 服务地址"],
  },
  {
    id: "openviking-knowledge",
    title: "知识库",
    to: "/settings/openviking",
    searchTerms: ["knowledge documents 知识库 文档 编辑 资料"],
  },
  {
    id: "openviking-documents",
    title: "记忆管理",
    to: "/settings/openviking",
    searchTerms: ["memory browse edit search 记忆 查看 编辑 搜索"],
  },
  {
    id: "diagnostics",
    title: t("settings.settingsSearch.diagnostics"),
    to: "/settings/general",
    searchTerms: ["logs traces processes resource history failures spans cpu memory"],
  },
  {
    id: "open-source-licenses",
    title: t("settings.settingsSearch.openSourceLicenses"),
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: t("settings.settingsSearch.legacyPlanMode"),
    to: "/settings/general",
    searchTerms: ["build plan composer old"],
  },
  {
    id: "legacy-context-window-indicator",
    title: t("settings.settingsSearch.legacyContextWindowIndicator"),
    to: "/settings/general",
    searchTerms: ["composer meter usage tokens circle old"],
  },
  {
    id: "legacy-sidebar",
    title: t("settings.settingsSearch.legacySidebar"),
    to: "/settings/general",
    searchTerms: ["project thread tree old flat list"],
  },
  {
    id: "keybindings",
    title: t("settings.settingsSearch.keybindings"),
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings json"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  {
    id: "snap-shot-enabled",
    title: t("settings.settingsSearch.snapShots"),
    searchTerms: ["window capture screenshot"],
    to: "/settings/snap-shot",
  },
  {
    id: "snap-shot-accessibility",
    title: t("settings.settingsSearch.includeAppText"),
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
    searchTerms: [
      "capture accessibility data text UI structure elements privacy omit agent context",
    ],
  },
  {
    id: "snap-shot-shortcut",
    title: t("settings.settingsSearch.captureShortcut"),
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-sound",
    title: t("settings.settingsSearch.captureSound"),
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-flash",
    title: t("settings.settingsSearch.captureFlash"),
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "snap-shot-animations",
    title: t("settings.settingsSearch.captureAnimations"),
    to: "/settings/snap-shot",
    targetId: "snap-shot-enabled",
  },
  {
    id: "providers",
    title: t("settings.settingsSearch.providers"),
    to: "/settings/providers",
    searchTerms: [
      "agents cli codex claude cursor grok opencode antigravity google sign in sign out install subscription instances authentication api key models configuration binary path config directory endpoint arguments environment variables display name accent color custom favorite hidden auto compact",
    ],
  },
  {
    id: "usage-providers",
    title: t("settings.settingsSearch.usageProviders"),
    to: "/settings/providers",
    searchTerms: [
      "usage sources CLIProxyAPI CLI proxy hub quota subscription limits management key add remove",
    ],
    providerSettingsOnly: true,
  },
  {
    id: "cursor-keychain-usage",
    title: t("settings.settingsSearch.cursorAccountUsage"),
    to: "/settings/providers",
    searchTerms: ["cursor macOS keychain usage tokens cost limits permission"],
    providerSettingsOnly: true,
    macProviderSettingsOnly: true,
  },
  {
    id: "provider-health-check-interval",
    title: t("settings.settingsSearch.healthCheckInterval"),
    to: "/settings/providers",
    searchTerms: ["refresh availability versions auth state models background probes seconds off"],
    providerSettingsOnly: true,
  },
  {
    id: "agent-browser-access",
    title: t("settings.settingsSearch.agentBrowserAccess"),
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["allow disable enable open drive preview tools sessions project override"],
  },
  {
    id: "device-hosts",
    title: t("settings.settingsSearch.deviceHosts"),
    to: "/settings/integrations",
    searchTerms: ["ssh remote simulator emulator ios android mac mini identity key connection"],
  },
  {
    id: "agent-device-access",
    title: t("settings.settingsSearch.agentDeviceAccess"),
    to: "/settings/integrations",
    targetId: "devices",
    searchTerms: ["allow simulator emulator ios android drive tools sessions"],
  },
  {
    id: "device-hub",
    title: t("settings.settingsSearch.deviceHub"),
    to: "/settings/integrations",
    targetId: "devices",
    searchTerms: ["simulator emulator ios android install start"],
  },
  {
    id: "device-platform-support",
    title: t("settings.settingsSearch.simulatorSupport"),
    to: "/settings/integrations",
    targetId: "devices",
    searchTerms: ["xcode android studio sdk avd runtime"],
  },
  {
    id: "browser-profiles",
    title: t("settings.settingsSearch.browserProfiles"),
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-profile",
    title: t("settings.settingsSearch.defaultBrowserProfile"),
    to: "/settings/integrations",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    title: t("settings.settingsSearch.defaultBrowserViewport"),
    to: "/settings/integrations",
    searchTerms: ["preview size width height device desktop mobile rotate"],
  },
  {
    id: "browser-default-zoom",
    title: t("settings.settingsSearch.defaultBrowserZoom"),
    to: "/settings/integrations",
    searchTerms: ["preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    title: t("settings.settingsSearch.defaultBrowserAppearance"),
    to: "/settings/integrations",
    searchTerms: ["preview color scheme light dark system os"],
  },
  {
    id: "browser-recording-frame-rate",
    title: t("settings.settingsSearch.browserRecordingFrameRate"),
    to: "/settings/integrations",
  },
  {
    id: "browser-recording-key-presses",
    title: t("settings.settingsSearch.showKeyPressesInRecordings"),
    to: "/settings/integrations",
    searchTerms: ["browser preview keyboard shortcuts keystrokes overlay capture"],
  },
  {
    id: "browser-recording-mouse-presses",
    title: t("settings.settingsSearch.showMousePressesInRecordings"),
    to: "/settings/integrations",
    searchTerms: ["browser preview clicks buttons drag overlay capture"],
  },
  {
    id: "browser-link-target",
    title: t("settings.settingsSearch.openLinksIn"),
    to: "/settings/integrations",
    searchTerms: ["links default browser in-app browser external open"],
  },
  {
    id: "browser-auto-show-floating-preview",
    title: t("settings.settingsSearch.autoShowFloatingPreview"),
    to: "/settings/integrations",
    searchTerms: ["agent opens browser device simulator pop into view hide"],
  },
  {
    id: "automatic-pull",
    title: t("settings.settingsSearch.automaticallyPull"),
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["auto pull default branch current checkout fast forward upstream"],
  },
  {
    id: "pull-request-merge-method",
    title: t("settings.settingsSearch.defaultMergeMethod"),
    to: "/settings/source-control",
    scope: "project-defaults",
    searchTerms: ["pull request merge squash rebase last selected"],
  },
  {
    id: "source-control",
    title: t("settings.settingsSearch.sourceControl"),
    to: "/settings/source-control",
    scope: "environment-defaults",
    searchTerms: [
      "version control git github gitlab forgejo gitea tea codeberg bitbucket azure devops hosting integrations credentials scan server environment",
    ],
  },
  {
    id: "git-fetch-interval",
    title: t("settings.settingsSearch.gitFetchInterval"),
    to: "/settings/source-control",
    searchTerms: [
      "automatic remote branch refresh background credentials security keys seconds off",
    ],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "worktree-branch-naming",
    title: t("settings.settingsSearch.worktreeBranchNaming"),
    to: "/settings/source-control",
    searchTerms: ["static semantic prefix custom prompt instructions feat fix refactor chore"],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "bitbucket-credentials",
    title: t("settings.settingsSearch.bitbucketCredentials"),
    to: "/settings/source-control",
    searchTerms: ["bitbucket atlassian access token api token email credentials sign in"],
    environmentOnly: true,
    scope: "environment-defaults",
  },
  {
    id: "source-control-writing-style",
    title: t("settings.settingsSearch.sourceControlWritingStyle"),
    to: "/settings/source-control",
    searchTerms: [
      "repository conventions conventional commits custom instructions change descriptions request titles",
    ],
    environmentOnly: true,
  },
  {
    id: "follow-change-request-templates",
    title: t("settings.settingsSearch.followChangeRequestTemplates"),
    to: "/settings/source-control",
    searchTerms: ["repository pr pull request description structure"],
    environmentOnly: true,
  },
  {
    id: "source-control-writer-model",
    title: t("settings.settingsSearch.sourceControlWriterModel"),
    to: "/settings/source-control",
    searchTerms: [
      "override generated commit change request pr titles descriptions branch bookmark",
    ],
    environmentOnly: true,
    scope: "project-defaults",
  },
  {
    id: "project-actions",
    title: t("settings.settingsSearch.actions"),
    to: "/settings/projects",
    searchTerms: ["commands scripts setup run dev server checkout worktree t3.json import"],
  },
  {
    id: "environment-icon",
    title: t("settings.settingsSearch.environmentIcon"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["machine glyph sidebar mac mini studio laptop desktop server cloud vm"],
    localBackendManagementOnly: true,
  },
  {
    id: "local-environment",
    title: t("settings.settingsSearch.localEnvironment"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["turn off on disable enable local server agents remote only restart"],
    desktopOnly: true,
  },
  {
    id: "network-access",
    title: t("settings.settingsSearch.networkAccess"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["expose backend remote pairing local machine interfaces host restart"],
    localBackendManagementOnly: true,
  },
  {
    id: "tailscale-https",
    title: t("settings.settingsSearch.tailscaleHttps"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["serve magicdns endpoint remote secure network"],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "wsl-backend",
    title: t("settings.settingsSearch.wslBackend"),
    to: "/settings/connections",
    searchTerms: [
      "windows subsystem linux distro second server projects stop windows backend restart",
    ],
    desktopOnly: true,
    windowsOnly: true,
    localBackendManagementOnly: true,
    wslAvailableOnly: true,
  },
  {
    id: "t3-connect",
    localEnvironmentOnly: true,
    title: t("settings.settingsSearch.t3Connect"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["managed tunnel cloud other devices remote"],
    desktopOnly: true,
    cloudOnly: true,
  },
  {
    id: "publish-agent-activity",
    localEnvironmentOnly: true,
    title: t("settings.settingsSearch.publishAgentActivity"),
    to: "/settings/connections",
    targetId: "connections-environment",
    searchTerms: ["mobile push notifications live activities cloud tunnel"],
    cloudOnly: true,
  },
  {
    id: "connections-environment",
    title: t("settings.settingsSearch.thisMachine"),
    to: "/settings/connections",
    searchTerms: [
      "connections server backend local remote access administrative permissions scope pairing links qr code authorized clients sessions revoke endpoint",
    ],
  },
  {
    id: "remote-environments",
    title: t("settings.settingsSearch.environments"),
    to: "/settings/connections",
    searchTerms: ["add pair backend host code ssh config agent tunnel saved t3 connect"],
  },
  {
    id: "load-balancing",
    title: t("settings.settingsSearch.loadBalancing"),
    to: "/settings/connections",
    searchTerms: [
      "automatic machine environment resources cpu memory capacity preference weight shared projects",
    ],
  },
  {
    id: "github-routing",
    title: t("settings.settingsSearch.gitHubRouting"),
    to: "/settings/connections",
    searchTerms: ["pull request trusted environments shared credentials permissions read actions"],
  },
  {
    id: "archive",
    title: t("settings.settingsSearch.archivedThreads"),
    to: "/settings/archived",
    searchTerms: ["restore reopen deleted history projects"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map(SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const));

const SETTINGS_CATEGORY_SCOPES: Readonly<Record<SettingsPath, SettingsSearchScope | null>> = {
  "/settings/projects": "project",
  "/settings/general": null,
  "/settings/appearance": null,
  "/settings/snap-shot": null,
  // Keybindings fan out to the selection; Providers shows the representative
  // environment at any selection. Neither needs a particular scope to render.
  "/settings/keybindings": null,
  "/settings/providers": null,
  "/settings/openviking": null,
  "/settings/cc-switch": null,
  "/settings/integrations": null,
  "/settings/source-control": "environment-defaults",
  "/settings/storage": "project-defaults",
  "/settings/connections": "connections",
  "/settings/scheduled-tasks": null,
  "/settings/archived": "project-defaults",
};

/** Search keeps the selected target. A missing row can explain its owning scope instead. */
export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? SETTINGS_CATEGORY_SCOPES[item.to],
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: { readonly threadAutoSettlement?: boolean };
    };
  } | null;
}

/** Discovery needs one capable environment; the selected page needs every connected target to support it. */
export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected
    .filter(
      (environment) =>
        environment.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    )
    .map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}

function settingsScopeKindFromSearch(search: SettingsScopeSearch): ResolvedSettingsScope["kind"] {
  const target = validateSettingsScopeSearch({ ...search });
  if (target.checkout && !target.project) return "unavailable";
  if (target.project) return target.checkout ? "checkout" : "project";
  return target.machine ? "environment" : "all";
}

export function isSettingsOverviewVisible(search: SettingsScopeSearch): boolean {
  const kind = settingsScopeKindFromSearch(search);
  return kind === "project" || kind === "checkout";
}

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

export function filterAvailableSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
  return items.filter(
    (item) =>
      item.to !== "/settings/providers" &&
      (!item.cloudOnly || availability.hasCloudPublicConfig) &&
      (!item.environmentOnly || availability.hasEnvironment) &&
      (!item.providerSettingsOnly || availability.hasProviderSettingsEnvironment) &&
      (!item.macProviderSettingsOnly || availability.hasMacProviderSettingsEnvironment) &&
      (!item.localBackendManagementOnly || availability.canManageLocalBackend) &&
      (!item.localEnvironmentOnly || !availability.localEnvironmentDisabled) &&
      (!item.wslAvailableOnly || availability.isWslSettingsRowVisible) &&
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement),
  );
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;

  return items
    .flatMap((item, index) => {
      if (item.to === "/settings/providers") return [];
      if (!isElectron && item.desktopOnly === true) return [];
      if (item.macOnly && !isMacPlatform(platform)) return [];
      if (item.windowsOnly && !isWindowsPlatform(platform)) return [];

      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}
