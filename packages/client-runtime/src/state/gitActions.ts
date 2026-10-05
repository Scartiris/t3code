import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  "action" | "commitMessage" | "featureBranch" | "filePaths"
>;

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !hasOpenPr &&
    gitStatus.aheadCount > 0 &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  return [
    {
      id: "commit",
      label: t("gitActions.gitActions.commit"),
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: t("gitActions.gitActions.push"),
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: t("gitActions.gitActions.viewPr"),
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: t("gitActions.gitActions.createPr"),
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
): GitQuickAction {
  if (isBusy) {
    return {
      label: t("gitActions.gitActions.commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("gitActions.gitActions.gitActionInProgress"),
    };
  }

  if (!gitStatus) {
    return {
      label: t("gitActions.gitActions.commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("gitActions.gitActions.gitStatusUnavailable"),
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;

  if (!hasBranch) {
    return {
      label: t("gitActions.gitActions.commit"),
      disabled: true,
      kind: "show_hint",
      hint: t("gitActions.gitActions.createBranchBeforePush"),
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return {
        label: t("gitActions.gitActions.commit"),
        disabled: false,
        kind: "run_action",
        action: "commit",
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: t("gitActions.gitActions.commitAndPush"),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: t("gitActions.gitActions.commitPushAndPr"),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (hasOpenPr && !isAhead) {
        return { label: t("gitActions.gitActions.viewPr"), disabled: false, kind: "open_pr" };
      }
      return {
        label: t("gitActions.gitActions.push"),
        disabled: true,
        kind: "show_hint",
        hint: t("gitActions.gitActions.addOriginRemoteBeforePushOrPr"),
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return { label: t("gitActions.gitActions.viewPr"), disabled: false, kind: "open_pr" };
      }
      return {
        label: t("gitActions.gitActions.push"),
        disabled: true,
        kind: "show_hint",
        hint: t("gitActions.gitActions.noLocalCommitsToPush"),
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: t("gitActions.gitActions.push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: t("gitActions.gitActions.pushAndCreatePr"),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: t("gitActions.gitActions.syncBranch"),
      disabled: true,
      kind: "show_hint",
      hint: t("gitActions.gitActions.branchDiverged"),
    };
  }

  if (isBehind) {
    return {
      label: t("gitActions.gitActions.pull"),
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: t("gitActions.gitActions.push"),
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: t("gitActions.gitActions.pushAndCreatePr"),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return { label: t("gitActions.gitActions.viewPr"), disabled: false, kind: "open_pr" };
  }

  return {
    label: t("gitActions.gitActions.commit"),
    disabled: true,
    kind: "show_hint",
    hint: t("gitActions.gitActions.branchUpToDate"),
  };
}

export function getGitActionDisabledReason(input: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
}): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote } = input;
  if (!item.disabled) return null;
  if (isBusy) return t("gitActions.gitActions.gitActionInProgress");
  if (!gitStatus) return t("gitActions.gitActions.gitStatusUnavailable");

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "commit") {
    if (!hasChanges) {
      return t("gitActions.gitActions.worktreeClean");
    }
    return t("gitActions.gitActions.commitUnavailable");
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return t("gitActions.gitActions.detachedHeadBeforePush");
    }
    if (hasChanges) {
      return t("gitActions.gitActions.commitOrStashBeforePush");
    }
    if (isBehind) {
      return t("gitActions.gitActions.branchBehindBeforePush");
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return t("gitActions.gitActions.addOriginRemoteBeforePush");
    }
    if (!isAhead) {
      return t("gitActions.gitActions.noLocalCommitsToPush");
    }
    return t("gitActions.gitActions.pushUnavailable");
  }

  if (hasOpenPr) {
    return t("gitActions.gitActions.viewPrUnavailable");
  }
  if (!hasBranch) {
    return t("gitActions.gitActions.detachedHeadBeforeCreate");
  }
  if (hasChanges) {
    return t("gitActions.gitActions.commitBeforeCreate");
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return t("gitActions.gitActions.addOriginRemoteBeforeCreate");
  }
  if (!isAhead) {
    return t("gitActions.gitActions.noLocalCommitsToInclude");
  }
  if (isBehind) {
    return t("gitActions.gitActions.branchBehindBeforeCreate");
  }
  return t("gitActions.gitActions.createPrUnavailable");
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  if (!isDefaultBranch) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = t("gitActions.gitActions.defaultBranchSuffix", { branch: branchLabel });

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: t("gitActions.gitActions.commitAndPushToDefaultBranchTitle"),
        description: t("gitActions.gitActions.commitAndPushToDefaultBranchDescription", { suffix }),
        continueLabel: t("gitActions.gitActions.commitAndPushToDefaultBranchContinue", {
          branch: branchLabel,
        }),
      };
    }
    return {
      title: t("gitActions.gitActions.pushToDefaultBranchTitle"),
      description: t("gitActions.gitActions.pushToDefaultBranchDescription", { suffix }),
      continueLabel: t("gitActions.gitActions.pushToDefaultBranchContinue", {
        branch: branchLabel,
      }),
    };
  }

  if (input.includesCommit) {
    return {
      title: t("gitActions.gitActions.commitPushPrFromDefaultBranchTitle"),
      description: t("gitActions.gitActions.commitPushPrFromDefaultBranchDescription", { suffix }),
      continueLabel: t("gitActions.gitActions.commitPushPrFromDefaultBranchContinue"),
    };
  }
  return {
    title: t("gitActions.gitActions.pushPrFromDefaultBranchTitle"),
    description: t("gitActions.gitActions.pushPrFromDefaultBranchDescription", { suffix }),
    continueLabel: t("gitActions.gitActions.pushPrFromDefaultBranchContinue"),
  };
}
