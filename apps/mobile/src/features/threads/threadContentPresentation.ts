import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { t } from "@t3tools/shared/i18n";

export type ThreadContentPresentation =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly detail: string;
    };

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
}): ThreadContentPresentation {
  if (input.hasDetail) {
    return { kind: "ready" };
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: t("threads.threadRouteScreen.threadUnavailable"),
      detail: t("threads.threadContentPresentation.threadDeleted"),
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: t("threads.threadContentPresentation.couldNotLoadConversation"),
      detail: input.detailError,
    };
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    // Messages will arrive once the (re)connection completes — present as
    // loading; the composer's connection pill reports the connection phase.
    return { kind: "loading" };
  }
  return {
    kind: "unavailable",
    title: t("threads.threadContentPresentation.messagesNotCached"),
    detail: t("threads.threadContentPresentation.reconnectToLoadConversation"),
  };
}
