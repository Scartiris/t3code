import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

/**
 * Desktop-oriented effort keywords that don't belong in the phone picker.
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not
 * a reasoning level. A value set elsewhere still displays, it just isn't
 * offered.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: t("threads.threadSettingsOptions.approvalRequiredLabel"),
    description: t("threads.threadSettingsOptions.approvalRequiredDescription"),
  },
  {
    mode: "auto-accept-edits",
    label: t("threads.threadSettingsOptions.autoAcceptEditsLabel"),
    description: t("threads.threadSettingsOptions.autoAcceptEditsDescription"),
  },
  {
    mode: "auto",
    label: t("threads.threadSettingsOptions.autoLabel"),
    description: t("threads.threadSettingsOptions.autoDescription"),
  },
  {
    mode: "full-access",
    label: t("threads.threadSettingsOptions.fullAccessLabel"),
    description: t("threads.threadSettingsOptions.fullAccessDescription"),
  },
];

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  return supportedRuntimeModes && supportedRuntimeModes.length > 0
    ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
    : RUNTIME_MODE_CHOICES;
}

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}
