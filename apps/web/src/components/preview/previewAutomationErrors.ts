import {
  EnvironmentId,
  type PreviewAutomationHost,
  PreviewAutomationOperation,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewTabId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import * as Schema from "effect/Schema";

export interface PreviewAutomationOperationContext {
  readonly requestId: PreviewAutomationRequest["requestId"];
  readonly operation: PreviewAutomationRequest["operation"];
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly threadId: PreviewAutomationRequest["threadId"];
  readonly tabId: Exclude<PreviewAutomationRequest["tabId"], undefined> | null;
}

export class PreviewAutomationOverlayTimeoutError extends Schema.TaggedError<PreviewAutomationOverlayTimeoutError>()(
  "PreviewAutomationOverlayTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return t("preview.previewAutomationErrors.overlayTimeout", {
      requestId: this.requestId,
      environmentId: this.environmentId,
      threadId: this.threadId,
      timeoutMs: this.timeoutMs,
    });
  }
}

export class PreviewAutomationNavigationTimeoutError extends Schema.TaggedError<PreviewAutomationNavigationTimeoutError>()(
  "PreviewAutomationNavigationTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    readiness: Schema.Literals(["domContentLoaded", "load"]),
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return t("preview.previewAutomationErrors.navigationTimeout", {
      requestId: this.requestId,
      environmentId: this.environmentId,
      threadId: this.threadId,
      tabId: this.tabId,
      readiness: this.readiness,
      timeoutMs: this.timeoutMs,
    });
  }
}

export class PreviewAutomationViewportTimeoutError extends Schema.TaggedError<PreviewAutomationViewportTimeoutError>()(
  "PreviewAutomationViewportTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return t("preview.previewAutomationErrors.viewportTimeout", {
      requestId: this.requestId,
      environmentId: this.environmentId,
      threadId: this.threadId,
      tabId: this.tabId,
      timeoutMs: this.timeoutMs,
    });
  }
}

export class PreviewAutomationTargetUnavailableError extends Schema.TaggedError<PreviewAutomationTargetUnavailableError>()(
  "PreviewAutomationTargetUnavailableError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    bridgeAvailable: Schema.Boolean,
  },
) {
  get responseTag() {
    return "PreviewAutomationTabNotFoundError" as const;
  }

  override get message(): string {
    return t("preview.previewAutomationErrors.targetUnavailable", {
      operation: this.operation,
      requestId: this.requestId,
      environmentId: this.environmentId,
      threadId: this.threadId,
      tabId: this.tabId ?? "未分配",
      bridgeState: this.bridgeAvailable ? "可用" : "不可用",
    });
  }
}

export class PreviewAutomationRecordingNotActiveError extends Schema.TaggedError<PreviewAutomationRecordingNotActiveError>()(
  "PreviewAutomationRecordingNotActiveError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
  },
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return t("preview.previewAutomationErrors.recordingNotActive", {
      requestId: this.requestId,
      tabId: this.tabId ?? "未分配",
      environmentId: this.environmentId,
      threadId: this.threadId,
    });
  }
}

export class PreviewAutomationTargetNotEditableHostError extends Schema.TaggedError<PreviewAutomationTargetNotEditableHostError>()(
  "PreviewAutomationTargetNotEditableHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  get responseTag() {
    return "PreviewAutomationTargetNotEditableError" as const;
  }

  override get message(): string {
    return t("preview.previewAutomationErrors.targetNotEditable", {
      operation: this.operation,
      requestId: this.requestId,
      tabId: this.tabId ?? "未分配",
    });
  }
}

const targetNotEditableDiagnostics = (
  cause: unknown,
): {
  readonly selectorKind?: "focused-element" | "locator" | "selector";
  readonly selectorLength?: number;
} | null => {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("_tag" in cause) ||
    cause._tag !== "PreviewAutomationTargetNotEditableError"
  ) {
    return null;
  }
  const selectorKind =
    "selectorKind" in cause &&
    (cause.selectorKind === "focused-element" ||
      cause.selectorKind === "locator" ||
      cause.selectorKind === "selector")
      ? cause.selectorKind
      : undefined;
  const selectorLength =
    "selectorLength" in cause &&
    typeof cause.selectorLength === "number" &&
    Number.isInteger(cause.selectorLength) &&
    cause.selectorLength >= 0
      ? cause.selectorLength
      : undefined;
  return {
    ...(selectorKind === undefined ? {} : { selectorKind }),
    ...(selectorLength === undefined ? {} : { selectorLength }),
  };
};

export class PreviewAutomationOperationError extends Schema.TaggedError<PreviewAutomationOperationError>()(
  "PreviewAutomationOperationError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    input: PreviewAutomationOperationContext & { readonly cause: unknown },
  ): PreviewAutomationHostError {
    if (isPreviewAutomationHostError(input.cause)) return input.cause;
    const diagnostics = targetNotEditableDiagnostics(input.cause);
    return diagnostics
      ? new PreviewAutomationTargetNotEditableHostError({
          requestId: input.requestId,
          operation: input.operation,
          environmentId: input.environmentId,
          threadId: input.threadId,
          tabId: input.tabId,
          ...diagnostics,
        })
      : new PreviewAutomationOperationError(input);
  }

  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return t("preview.previewAutomationErrors.operationFailed", {
      operation: this.operation,
      requestId: this.requestId,
      environmentId: this.environmentId,
      threadId: this.threadId,
      tabId: this.tabId ?? "未分配",
    });
  }
}

export const PreviewAutomationHostError = Schema.Union([
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationViewportTimeoutError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetNotEditableHostError,
  PreviewAutomationOperationError,
]);
export type PreviewAutomationHostError = typeof PreviewAutomationHostError.Type;

const isPreviewAutomationHostError = Schema.is(PreviewAutomationHostError);

export function serializePreviewAutomationHostError(
  error: PreviewAutomationHostError,
): NonNullable<PreviewAutomationResponse["error"]> {
  const detail = Object.fromEntries(
    Object.entries(error).filter(
      ([key]) =>
        key !== "_tag" && key !== "cause" && key !== "name" && key !== "message" && key !== "stack",
    ),
  );
  return {
    _tag: "responseTag" in error ? error.responseTag : error._tag,
    message: error.message,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}
