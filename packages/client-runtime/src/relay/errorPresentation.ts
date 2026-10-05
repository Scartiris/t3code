import type { DpopFailureReason } from "@t3tools/contracts";
import type { RelayProtectedError } from "@t3tools/contracts/relay";
import { t } from "@t3tools/shared/i18n";

export const DPOP_CLOCK_HINT = t("relayErrors.errorPresentation.dpopClockHint");

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
export const DPOP_UNKNOWN_HINT = t("relayErrors.errorPresentation.dpopUnknownHint");

export const DPOP_RETRY_HINT = t("relayErrors.errorPresentation.dpopRetryHint");

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return DPOP_CLOCK_HINT;
  if (reason === undefined) return DPOP_UNKNOWN_HINT;
  return DPOP_RETRY_HINT;
}

export function dpopFailureMessage(message: string, reason: DpopFailureReason | undefined): string {
  return `${message} ${dpopFailureHint(reason)}`;
}

export function relayProtectedErrorMessage(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return t("relayErrors.errorPresentation.cloudSessionTokenRejected");
        case "invalid_dpop":
          return dpopFailureMessage(
            t("relayErrors.errorPresentation.dpopProofRejected"),
            error.dpopFailureReason,
          );
        case "not_authorized":
          return t("relayErrors.errorPresentation.authenticatedRequestRejected");
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return t("relayErrors.errorPresentation.linkProofExpired");
    case "RelayEnvironmentLinkProofInvalidError":
      return t("relayErrors.errorPresentation.linkProofInvalid", { reason: error.reason });
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link does not read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return t("relayErrors.errorPresentation.noActiveEnvironmentLink");
      }
      return error.reason
        ? t("relayErrors.errorPresentation.connectionRequestRejectedWithReason", {
            reason: error.reason,
          })
        : t("relayErrors.errorPresentation.connectionRequestRejected");
    case "RelayEnvironmentEndpointUnavailableError":
      return t("relayErrors.errorPresentation.endpointUnreachable", { reason: error.reason });
    case "RelayEnvironmentEndpointTimedOutError":
      return t("relayErrors.errorPresentation.endpointTimedOut");
    case "RelayEnvironmentLinkFailedError":
      return t("relayErrors.errorPresentation.linkFailed", { reason: error.reason });
    case "RelayEnvironmentLinkUnavailableError":
      return t("relayErrors.errorPresentation.endpointProvisionFailed", { reason: error.reason });
    case "RelayEnvironmentLinkLimitExceededError":
      return t("relayErrors.errorPresentation.linkLimitExceeded", {
        maxTunnels: error.maxTunnels,
      });
    case "RelayAgentActivityPublishProofExpiredError":
      return t("relayErrors.errorPresentation.agentActivityProofExpired");
    case "RelayAgentActivityPublishProofInvalidError":
      return t("relayErrors.errorPresentation.agentActivityProofInvalid", {
        reason: error.reason,
      });
    case "RelayInternalError":
      return t("relayErrors.errorPresentation.internalError", { reason: error.reason });
  }
}
