import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { t } from "@t3tools/shared/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { T3ConnectEnvironmentRow } from "./T3ConnectUserProfilePage";

const environment: RelayClientEnvironmentRecord = {
  environmentId: "environment-1" as EnvironmentId,
  label: "Studio Mac",
  endpoint: {
    httpBaseUrl: "https://studio.example.com",
    wsBaseUrl: "wss://studio.example.com",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-08-12T12:00:00.000Z",
};

function renderRow({
  confirmationOpen = false,
  mutationPending = false,
}: {
  readonly confirmationOpen?: boolean;
  readonly mutationPending?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <T3ConnectEnvironmentRow
      environment={environment}
      confirmationOpen={confirmationOpen}
      mutationPending={mutationPending}
      onConfirmationChange={vi.fn()}
      onDeregister={vi.fn()}
    />,
  );
}

describe("T3 Connect environment row", () => {
  it("keeps deregistration confirmation inline and collapsed by default", () => {
    const markup = renderRow();

    expect(markup).toContain("Studio Mac");
    expect(markup).toContain(t("clerk.t3ConnectUserProfilePage.deregister"));
    expect(markup).not.toContain(t("clerk.t3ConnectUserProfilePage.deregisterServerTitle"));
    expect(markup).not.toContain(
      t("clerk.t3ConnectUserProfilePage.confirmDeregisterAria", { label: "Studio Mac" }),
    );
  });

  it("expands Clerk-style confirmation content beneath the environment row", () => {
    const markup = renderRow({ confirmationOpen: true });

    expect(markup).toContain(t("clerk.t3ConnectUserProfilePage.deregisterServerTitle"));
    expect(markup).toContain(
      t("clerk.t3ConnectUserProfilePage.deregisterConfirmBody", { label: "Studio Mac" }),
    );
    expect(markup).toContain(
      t("clerk.t3ConnectUserProfilePage.confirmDeregisterAria", { label: "Studio Mac" }),
    );
    expect(markup).toContain(t("clerk.t3ConnectUserProfilePage.deregisterConfirmDetail"));
    expect(markup).toContain(t("action.cancel"));
  });

  it("locks the confirmation actions while deregistration is pending", () => {
    const markup = renderRow({ confirmationOpen: true, mutationPending: true });

    expect(markup).toContain(t("clerk.t3ConnectUserProfilePage.deregistering"));
    expect(markup.match(/ disabled=""/g)).toHaveLength(3);
  });
});
