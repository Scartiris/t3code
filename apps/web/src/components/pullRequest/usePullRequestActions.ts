/**
 * The actions a pull request offers, extracted from the detail panel so smaller surfaces — the
 * thread details panel's pull request row — perform them through the very same code. Two callers
 * running two copies of "merge" or "resolve in a thread" would drift apart one fix at a time;
 * these hooks are where that behavior lives, and the panels are only where it is rendered.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";
import { handoffPrompt, handoffReviewComments, readableFailure } from "./pullRequestDetail.logic";

const ACTION_SUCCESS_LABELS: Record<PullRequestAction, string> = {
  merge: t("pullRequest.pullRequestDetailPanel.actionMerged"),
  ready: t("pullRequest.pullRequestDetailPanel.actionMarkedReady"),
  draft: t("pullRequest.pullRequestDetailPanel.actionConvertedToDraft"),
  close: t("pullRequest.pullRequestDetailPanel.actionClosed"),
  reopen: t("pullRequest.pullRequestDetailPanel.actionReopened"),
  "update-branch": t("pullRequest.pullRequestDetailPanel.actionBranchUpdated"),
  "enable-auto-merge": t("pullRequest.pullRequestDetailPanel.actionAutoMergeEnabled"),
  "disable-auto-merge": t("pullRequest.pullRequestDetailPanel.actionAutoMergeDisabled"),
  revert: t("pullRequest.pullRequestDetailPanel.actionRevertOpened"),
  "approve-workflows": t("pullRequest.pullRequestDetailPanel.actionWorkflowsApproved"),
};

/** Said as the thing that did not happen, rather than as the operation that returned an error. */
const ACTION_FAILURE_LABELS: Record<PullRequestAction, string> = {
  merge: t("pullRequest.pullRequestDetailPanel.failedMerge"),
  ready: t("pullRequest.pullRequestDetailPanel.failedMarkReady"),
  draft: t("pullRequest.pullRequestDetailPanel.failedConvertToDraft"),
  close: t("pullRequest.pullRequestDetailPanel.failedClose"),
  reopen: t("pullRequest.pullRequestDetailPanel.failedReopen"),
  "update-branch": t("pullRequest.pullRequestDetailPanel.failedUpdateBranch"),
  "enable-auto-merge": t("pullRequest.pullRequestDetailPanel.failedEnableAutoMerge"),
  "disable-auto-merge": t("pullRequest.pullRequestDetailPanel.failedDisableAutoMerge"),
  revert: t("pullRequest.pullRequestDetailPanel.failedOpenRevert"),
  "approve-workflows": t("pullRequest.pullRequestDetailPanel.failedApproveWorkflows"),
};

/** What to try, for the times the host says only that it refused. */
const ACTION_FAILURE_HINTS: Record<PullRequestAction, string> = {
  merge: t("pullRequest.pullRequestDetailPanel.hintMergeRefused"),
  ready: t("pullRequest.pullRequestDetailPanel.hintRefusedWriteAccess"),
  draft: t("pullRequest.pullRequestDetailPanel.hintRefusedWriteAccess"),
  close: t("pullRequest.pullRequestDetailPanel.hintCloseRefused"),
  reopen: t("pullRequest.pullRequestDetailPanel.hintReopenRefused"),
  "update-branch": t("pullRequest.pullRequestDetailPanel.hintUpdateBranchRefused"),
  "enable-auto-merge": t("pullRequest.pullRequestDetailPanel.hintEnableAutoMergeRefused"),
  "disable-auto-merge": t("pullRequest.pullRequestDetailPanel.hintDisableAutoMergeRefused"),
  revert: t("pullRequest.pullRequestDetailPanel.hintRevertRefused"),
  "approve-workflows": t("pullRequest.pullRequestDetailPanel.hintApproveWorkflowsRefused"),
};

/**
 * Runs one host action against a pull request, with the toasts every surface should say the same
 * way. `onSuccess` is where the caller re-reads whatever it is showing.
 */
export function usePullRequestActionRunner({
  environmentId,
  reference,
  onSuccess,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef | null;
  onSuccess?: (action: PullRequestAction) => void;
}) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [actionPending, setActionPending] = useState(false);

  const perform = async (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (actionPending || reference === null) return;
    setActionPending(true);
    const result = await runAction({
      environmentId,
      input: { ...reference, action, ...(method ? { mergeMethod: method } : {}) },
    });
    setActionPending(false);
    if (result._tag === "Failure") {
      // The host's own sentence, because it is the only thing that says why. A merge strategy a
      // branch policy forbids is refused at completion and nowhere earlier — Azure DevOps
      // publishes no per-strategy availability to hide the control with — so "action failed"
      // would leave the reader pressing the same button again.
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: ACTION_FAILURE_LABELS[action],
        description: readableFailure(failure, ACTION_FAILURE_HINTS[action]),
      });
      return;
    }
    toastManager.add({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
    onSuccess?.(action);
  };

  return { actionPending, perform };
}

export interface PullRequestThreadTask {
  prompt: string;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
}

/** What a hand-off needs to know about the pull request it is handing over. */
export type PullRequestHandoffDetail = Pick<
  PullRequestDetail,
  "projectId" | "workspaceRoot" | "url"
>;

/**
 * What the last hand-off wrote into each draft, kept outside React because the panel that wrote it
 * is closed by the time the next one opens. It is how a prompt the reader has since edited is told
 * apart from the one they were handed: only the sentence still exactly as written may be replaced.
 */
const lastHandoffPromptByDraft = new Map<DraftId, string>();

/**
 * The hand-offs from a pull request into a thread: a question that needs nothing checked out, and
 * a task that needs the branch under the agent's feet first. One `handoff` key holds them all to
 * one at a time, whatever surface pressed the button.
 */
export function usePullRequestHandoffs({
  environmentId,
  detail,
}: {
  environmentId: EnvironmentId;
  detail: PullRequestHandoffDetail | null;
}) {
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId,
    cwd: detail?.workspaceRoot ?? null,
  });
  // Which handoff is preparing, keyed so a per-finding button can say "Preparing..." on itself
  // alone. One at a time whatever the key: they all check the same pull request out.
  const [handoff, setHandoff] = useState<string | null>(null);

  /**
   * Opens a thread on this project and leaves the task in its composer for the reader to send.
   *
   * Nothing is checked out: asking a question is not a reason to move somebody's working tree or
   * to make a worktree they did not ask for. The two hand-offs that do need the code call this
   * after preparing it, so there is one path from "a task" to "a thread holding it".
   */
  const openThreadWithTask = async (
    projectRef: ReturnType<typeof scopeProjectRef>,
    task: PullRequestThreadTask | null,
    opened?: { draftId: DraftId },
  ): Promise<{ draftId: DraftId } | null> => {
    const session =
      opened ??
      (await newThread(projectRef).then(
        (result) => result,
        () => null,
      ));
    if (session === null) return null;
    const store = useComposerDraftStore.getState();
    if (task === null) return session;
    // The latest press is the ask: it takes over what an earlier hand-off left, prompt and chips
    // both, rather than stacking a second one under the first. What the reader typed themselves
    // survives — the composer they are handed is not always a fresh one, and a prompt they have
    // since edited is theirs rather than the hand-off's.
    const draft = store.getComposerDraft(session.draftId);
    const existingComments = draft?.reviewComments ?? [];
    const prompt = handoffPrompt(
      {
        prompt: draft?.prompt ?? "",
        lastHandoffPrompt: lastHandoffPromptByDraft.get(session.draftId),
      },
      task.prompt,
    );
    // Remember the hand-off's own contribution, not the merged prompt: only that sentence is
    // this session's to take back next time, and the reader's text around it is not.
    lastHandoffPromptByDraft.set(session.draftId, task.prompt);
    store.setPrompt(session.draftId, prompt);
    store.setReviewComments(
      session.draftId,
      handoffReviewComments(existingComments, task.reviewComments ?? []),
    );
    return session;
  };

  /** A question about the change, which needs a thread and nothing else. */
  const startAsk = async (kind: string, task: PullRequestThreadTask) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    const opened = await openThreadWithTask(projectRef, task);
    setHandoff(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: t("pullRequest.pullRequestDetailPanel.couldNotOpenThread"),
        description: t("pullRequest.pullRequestDetailPanel.tryAgainFromProject"),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: t("pullRequest.pullRequestDetailPanel.askedInThread"),
      // "Ask" leaves the composer empty on purpose, so saying the question is in it would send
      // the reader looking for something that is not there. The chips are what landed.
      description:
        task.prompt.length > 0
          ? t("pullRequest.pullRequestDetailPanel.questionInComposer")
          : t("pullRequest.pullRequestDetailPanel.pullRequestInComposer"),
    });
  };

  // Every handoff works the same way: check the pull request out into its own worktree, open a
  // thread there, and — when it carries a task — put that in the composer for the user to read
  // before sending. Checking out is the whole point of the ones that carry nothing.
  const startHandoff = async (
    kind: string,
    task: PullRequestThreadTask | null,
    // A worktree leaves whatever is open alone, which is why it is the default. Checking out in
    // the repository itself is what you want when the point is to run the thing where you
    // already work — and it moves the branch under everything else that is open there.
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    // The menu closes on the press and takes its "Preparing..." label with it, so this is the
    // only thing answering for the checkout. It carries no timeout of its own: a loading toast
    // never expires, and an explicit one would survive the update and pin the result on screen.
    const toastId = toastManager.add({
      type: "loading",
      title: t("pullRequest.pullRequestDetailPanel.preparingCheckout"),
    });
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    // The thread is opened before the checkout rather than after it, because the project's setup
    // script only runs for a checkout that knows which thread it is for — and a worktree with no
    // dependencies installed is not something anyone can test.
    const opened = await newThread(projectRef).then(
      (session) => session,
      () => null,
    );
    if (opened === null) {
      setHandoff(null);
      // Without a thread there is nowhere for the checkout to belong: its setup script would not
      // run and its task would have no composer to land in. Better to stop before touching the
      // working tree than to prepare a worktree nobody asked for.
      toastManager.update(toastId, {
        type: "error",
        title: t("pullRequest.pullRequestDetailPanel.couldNotOpenThreadForCheckout"),
        description: t("pullRequest.pullRequestDetailPanel.tryAgainFromProject"),
      });
      return;
    }
    const prepared = await prepareThread.run({
      reference: detail.url,
      mode,
      threadId: opened.threadId,
    });
    if (prepared._tag === "Failure") {
      setHandoff(null);
      // The server says what to do about it — that the branch is already checked out in the main
      // repository, say — and that sentence is the only way out of the failure.
      const detailMessage =
        prepareThread.error instanceof Error ? prepareThread.error.message : null;
      toastManager.update(toastId, {
        type: "error",
        title: t("pullRequest.pullRequestDetailPanel.couldNotPrepareCheckout"),
        ...(detailMessage ? { description: detailMessage } : {}),
      });
      return;
    }
    // The same thread again, now that there is somewhere to point it at. A local checkout has
    // no worktree of its own, so the thread runs where the repository already is.
    const pointed = await newThread(projectRef, {
      branch: prepared.value.branch,
      worktreePath: prepared.value.worktreePath,
      envMode: prepared.value.worktreePath === null ? "local" : "worktree",
    }).then(
      (session) => session !== null,
      () => false,
    );
    if (!pointed) {
      setHandoff(null);
      // The checkout is on disk; only the thread failed to move onto it. Writing the task now
      // would send the agent at whatever the thread was already open on — which is the one
      // outcome worth stopping for, since it reads as success and is not.
      toastManager.update(toastId, {
        type: "error",
        title: t("pullRequest.pullRequestDetailPanel.checkedOutThreadStayed"),
        description: t("pullRequest.pullRequestDetailPanel.checkedOutThreadStayedDetail", {
          branch: prepared.value.branch,
        }),
      });
      return;
    }
    // Released here whatever happened next: a loading toast never expires on its own, so leaving
    // this set would spin forever and lock every handoff behind it until a reload.
    setHandoff(null);
    // A worktree that was already there and had been worked in keeps whatever it holds, so the
    // thread opens on older code than the pull request carries. Said once, in place of the
    // success, because everything else about the handoff did happen.
    const staleCheckoutToast = {
      type: "warning",
      title: t("pullRequest.pullRequestDetailPanel.checkedOutNotLatest"),
      description: t("pullRequest.pullRequestDetailPanel.checkedOutNotLatestDetail"),
    } as const;
    if (task === null) {
      toastManager.update(
        toastId,
        prepared.value.isOnPullRequestHead
          ? {
              type: "success",
              title:
                mode === "local"
                  ? t("pullRequest.pullRequestDetailPanel.checkedOutHere")
                  : t("pullRequest.pullRequestDetailPanel.checkedOut"),
              description:
                mode === "local"
                  ? t("pullRequest.pullRequestDetailPanel.checkedOutHereDetail")
                  : t("pullRequest.pullRequestDetailPanel.checkedOutDetail"),
            }
          : staleCheckoutToast,
      );
      return;
    }
    await openThreadWithTask(projectRef, task, opened);
    toastManager.update(
      toastId,
      prepared.value.isOnPullRequestHead
        ? {
            type: "success",
            title: t("pullRequest.pullRequestDetailPanel.checkoutReady"),
            description: t("pullRequest.pullRequestDetailPanel.taskInComposer"),
          }
        : staleCheckoutToast,
    );
  };

  return { handoff, startAsk, startHandoff };
}
