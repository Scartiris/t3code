import { describe, expect, it } from "@effect/vitest";
import { t } from "@t3tools/shared/i18n";

import { projectThreadContentPresentation } from "./threadContentPresentation";

describe("thread content presentation", () => {
  it("renders cached detail while its environment reconnects", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: true,
        detailError: null,
        detailDeleted: false,
        connectionState: "reconnecting",
      }),
    ).toEqual({ kind: "ready" });
  });

  it("loads missing detail inside the thread screen when connected", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: null,
        detailDeleted: false,
        connectionState: "connected",
      }),
    ).toEqual({ kind: "loading" });
  });

  it("explains uncached detail while disconnected instead of loading forever", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: null,
        detailDeleted: false,
        connectionState: "error",
      }),
    ).toEqual({
      kind: "unavailable",
      title: t("threads.threadContentPresentation.messagesNotCached"),
      detail: t("threads.threadContentPresentation.reconnectToLoadConversation"),
    });
  });

  it("surfaces detail errors before presenting a loading state", () => {
    expect(
      projectThreadContentPresentation({
        hasDetail: false,
        detailError: "The thread stream failed.",
        detailDeleted: false,
        connectionState: "connected",
      }),
    ).toEqual({
      kind: "unavailable",
      title: t("threads.threadContentPresentation.couldNotLoadConversation"),
      detail: "The thread stream failed.",
    });
  });
});
