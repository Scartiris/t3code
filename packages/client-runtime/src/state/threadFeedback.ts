import { MessageId, type ProviderUploadFeedbackResult } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";

type CodexFeedbackSubmissionDetails = {
  readonly id: MessageId;
  readonly command: string;
  readonly createdAt: string;
};

export type CodexFeedbackSubmission = CodexFeedbackSubmissionDetails &
  (
    | { readonly status: "uploading" | "interrupted" }
    | { readonly status: "sent"; readonly feedbackId: string }
    | { readonly status: "failed"; readonly errorMessage: string }
  );

export function parseCodexFeedbackCommand(text: string): { readonly reason?: string } | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) {
    return null;
  }
  const reason = match[1]?.trim();
  return reason ? { reason } : {};
}

export function codexFeedbackNotice(submission: CodexFeedbackSubmission) {
  switch (submission.status) {
    case "interrupted":
      return null;
    case "uploading":
      return { title: t("threadFeedback.threadFeedback.sending"), description: undefined };
    case "sent":
      return {
        title: t("threadFeedback.threadFeedback.sent"),
        description: t("threadFeedback.threadFeedback.threadIdLabel", {
          feedbackId: submission.feedbackId,
        }),
      };
    case "failed":
      return {
        title: t("threadFeedback.threadFeedback.sendFailed"),
        description: submission.errorMessage,
      };
  }
}

export function beginCodexFeedbackSubmission(
  submissionsInFlight: Set<string>,
  threadKey: string,
): (() => void) | null {
  if (submissionsInFlight.has(threadKey)) return null;
  submissionsInFlight.add(threadKey);
  return () => submissionsInFlight.delete(threadKey);
}

/** A chat row that exists only on this client, such as a feedback exchange. */
export interface LocalChatMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function codexFeedbackMessage(
  submission: CodexFeedbackSubmission,
  role: "user" | "assistant" = "user",
): LocalChatMessage {
  const text =
    role === "user"
      ? submission.command
      : submission.status === "sent"
        ? t("threadFeedback.threadFeedback.sentWithId", { feedbackId: submission.feedbackId })
        : submission.status === "failed"
          ? t("threadFeedback.threadFeedback.sendFailedWithError", {
              errorMessage: submission.errorMessage,
            })
          : t("threadFeedback.threadFeedback.sending");

  return {
    id: role === "user" ? submission.id : MessageId.make(`${submission.id}:feedback`),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: submission.createdAt,
    updatedAt: submission.createdAt,
  };
}

export async function submitCodexFeedback<E>(input: {
  readonly submission: CodexFeedbackSubmissionDetails;
  readonly clearDraft: () => void;
  readonly onUpdate: (submission: CodexFeedbackSubmission) => void;
  readonly upload: () => Promise<AtomCommandResult<ProviderUploadFeedbackResult, E>>;
}): Promise<AtomCommandResult<ProviderUploadFeedbackResult, E>> {
  input.onUpdate({ ...input.submission, status: "uploading" });
  input.clearDraft();

  const result = await input.upload();
  if (result._tag === "Success") {
    input.onUpdate({
      ...input.submission,
      status: "sent",
      feedbackId: result.value.feedbackId,
    });
  } else if (isAtomCommandInterrupted(result)) {
    input.onUpdate({ ...input.submission, status: "interrupted" });
  } else {
    const error = squashAtomCommandFailure(result);
    input.onUpdate({
      ...input.submission,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : t("error.generic"),
    });
  }

  return result;
}
