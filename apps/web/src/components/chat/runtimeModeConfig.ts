import type { RuntimeMode } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: t("chat.runtimeModeConfig.approvalRequiredLabel"),
    description: t("chat.runtimeModeConfig.approvalRequiredDescription"),
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: t("chat.runtimeModeConfig.autoAcceptEditsLabel"),
    description: t("chat.runtimeModeConfig.autoAcceptEditsDescription"),
    icon: PenLineIcon,
  },
  auto: {
    label: t("chat.runtimeModeConfig.autoLabel"),
    description: t("chat.runtimeModeConfig.autoDescription"),
    icon: SparklesIcon,
  },
  "full-access": {
    label: t("chat.runtimeModeConfig.fullAccessLabel"),
    description: t("chat.runtimeModeConfig.fullAccessDescription"),
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
