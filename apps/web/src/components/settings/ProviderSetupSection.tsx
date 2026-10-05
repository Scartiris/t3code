import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  ANTIGRAVITY_AUTH_METHODS,
  type AntigravityAuthMethod,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

interface ProviderSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly binaryPath?: string | undefined;
  readonly authMethod?: AntigravityAuthMethod | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}

/** Read the configured method from the instance config. Unknown values fall back to personal. */
export function readAntigravityAuthMethod(config: unknown): AntigravityAuthMethod {
  const value =
    config !== null && typeof config === "object" && "authMethod" in config
      ? config.authMethod
      : undefined;
  return (
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === value)?.value ?? "oauth-personal"
  );
}

/** "Downloading 12.3 MB of 45.6 MB." — the total stays absent while the size is unknown. */
function downloadProgressLabel(downloadedBytes: number, totalBytes: number | null): string {
  const downloaded = (downloadedBytes / 1_000_000).toFixed(1);
  if (totalBytes === null) {
    return t("settings.providerSetupSection.downloadingMb", { downloaded });
  }
  return t("settings.providerSetupSection.downloadingMbOfTotal", {
    downloaded,
    total: (totalBytes / 1_000_000).toFixed(1),
  });
}

/** Setup state belongs to the selected environment and is never saved in client settings. */
export function ProviderSetupSection(props: ProviderSetupSectionProps) {
  return (
    <section
      aria-label={t("settings.providerSetupSection.setupSectionAria")}
      className="@container/setup divide-y divide-border/50 text-xs"
    >
      <SettingsRow
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        title={t("settings.providerSetupSection.environment")}
        description={t("settings.providerSetupSection.environmentDescription")}
        control={
          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {props.environmentLabel}
            </span>
            {!props.enabled && !props.readOnly ? (
              <Button size="sm" variant="outline" onClick={props.onEnable}>
                {t("settings.providerSetupSection.enableAntigravity")}
              </Button>
            ) : null}
          </div>
        }
      />
      {props.readOnly ? (
        <SettingsRow
          title={t("settings.providerSetupSection.setupUnavailable")}
          description={t("settings.providerSetupSection.setupUnavailableDescription")}
        />
      ) : props.provider?.setup === undefined ? (
        <SettingsRow
          title={t("settings.providerSetupSection.updateRequired")}
          description={t("settings.providerSetupSection.updateRequiredDescription")}
        />
      ) : (
        <ProviderSetupActions
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
          binaryPath={props.binaryPath}
          authMethod={props.authMethod ?? "oauth-personal"}
          enabled={props.enabled}
        />
      )}
    </section>
  );
}

function ProviderSetupActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  enabled,
  binaryPath,
}: Pick<
  ProviderSetupSectionProps,
  "environmentId" | "environmentLabel" | "instanceId" | "enabled" | "binaryPath"
> & {
  readonly provider: ServerProvider;
  readonly authMethod: AntigravityAuthMethod;
}) {
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const auth = authQuery.data;
  const installation = installQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, commandOptions);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, commandOptions);
  const removeInstall = useAtomCommand(
    serverEnvironment.removeProviderInstallation,
    commandOptions,
  );
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const usesCustomBinary = Boolean(binaryPath?.trim());
  const installed =
    provider.installed || (!usesCustomBinary && installation?.installedVersion != null);
  const queryError = authQuery.error ?? installQuery.error;
  const actionsDisabled = pendingLabel !== null || queryError !== null;
  const installationStatusMessage =
    installation?.phase === "downloading"
      ? downloadProgressLabel(installation.downloadedBytes, installation.totalBytes)
      : installation?.phase === "extracting"
        ? t("settings.providerSetupSection.extractingAntigravity")
        : installation?.phase === "verifying"
          ? t("settings.providerSetupSection.checkingDownloadedRuntime")
          : installed
            ? t("settings.providerSetupSection.installed")
            : usesCustomBinary
              ? enabled
                ? t("settings.providerSetupSection.configuredRuntimeUnavailable")
                : t("settings.providerSetupSection.configuredRuntimeNotChecked")
              : installation?.totalBytes
                ? t("settings.providerSetupSection.megabyteDownload", {
                    size: Math.ceil(installation.totalBytes / 1_000_000),
                  })
                : t("settings.providerSetupSection.notInstalled");

  async function runCommand<A, E>(
    label: string,
    request: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingLabel(label);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : t("settings.providerSetupSection.providerSetupFailed"),
          );
        }
        return false;
      }
      return true;
    } catch {
      setError(t("settings.providerSetupSection.providerSetupFailedRetry"));
      return false;
    } finally {
      pendingRef.current = false;
      setPendingLabel(null);
    }
  }

  async function removeRuntime() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      t("settings.providerSetupSection.removeRuntimeConfirmation", { environmentLabel }),
    );
    if (confirmed) {
      await runCommand(t("settings.providerSetupSection.removingRuntime"), () =>
        removeInstall(target),
      );
    }
  }

  return (
    <div className="divide-y divide-border/50">
      <SettingsRow
        title={t("settings.providerSetupSection.runtime")}
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        description={t("settings.providerSetupSection.runtimeDescription")}
        status={
          <div className="space-y-2">
            {usesCustomBinary ? (
              <p className="text-muted-foreground">
                {t("settings.providerSetupSection.usesCustomBinaryPath")}
              </p>
            ) : null}
            {!installed && !provider.setup?.canInstall ? (
              <p className="text-muted-foreground">
                {t("settings.providerSetupSection.automaticInstallUnavailable")}
              </p>
            ) : null}
          </div>
        }
        control={
          <div className="flex w-full min-w-0 flex-col gap-2 sm:w-56 sm:text-right">
            <p role="status" className="min-h-4 text-muted-foreground tabular-nums">
              {installationStatusMessage}
            </p>
            <div className="h-1">
              {installation?.phase === "downloading" &&
              installation.totalBytes !== null &&
              installation.totalBytes > 0 ? (
                <progress
                  aria-label={t("settings.providerSetupSection.downloadProgressAria")}
                  className="block h-1 w-full accent-foreground"
                  value={installation.downloadedBytes}
                  max={installation.totalBytes}
                />
              ) : null}
            </div>
            {!installActive &&
            installation?.message &&
            installation.message !== installationStatusMessage ? (
              <p className="text-muted-foreground [overflow-wrap:anywhere]">
                {installation.message}
              </p>
            ) : null}
            <div className="grid min-h-7 grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
              <div className="col-start-2 row-start-1 grid">
                {installActive && installation.operationId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionsDisabled}
                    onClick={() => {
                      const operationId = installation.operationId;
                      if (!operationId) return;
                      void runCommand(
                        t("settings.providerSetupSection.cancellingInstallation"),
                        () => cancelInstall({ environmentId, input: { instanceId, operationId } }),
                      );
                    }}
                  >
                    {t("settings.providerSetupSection.cancelInstallation")}
                  </Button>
                ) : !installActive && provider.setup?.canInstall ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionsDisabled || installation === null || authActive}
                    onClick={() =>
                      void runCommand(t("settings.providerSetupSection.startingInstallation"), () =>
                        startInstall(target),
                      )
                    }
                  >
                    {installation?.installedVersion
                      ? installation.version &&
                        installation.version !== installation.installedVersion
                        ? t("settings.providerSetupSection.updateAntigravity")
                        : t("settings.providerSetupSection.reinstallAntigravity")
                      : installation?.phase === "failed" || installation?.phase === "cancelled"
                        ? t("settings.providerSetupSection.retryInstallation")
                        : installed
                          ? t("settings.providerSetupSection.installManagedRuntime")
                          : t("settings.providerSetupSection.installAntigravity")}
                  </Button>
                ) : null}
              </div>
              {installation?.canRemove && !installActive ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="col-start-1 row-start-1"
                        aria-label={t("settings.providerSetupSection.removeDownloadedRuntime")}
                        disabled={actionsDisabled || authActive}
                        onClick={() => void removeRuntime()}
                      />
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup>
                    {t("settings.providerSetupSection.removeDownloadedRuntime")}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          </div>
        }
      />

      <ProviderAuthenticationSection
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={instanceId}
        provider={provider}
        readOnly={false}
      />

      <p className="sr-only" role="status">
        {pendingLabel ? `${pendingLabel}.` : null}
      </p>
      {error || queryError ? (
        <div className="grid gap-2 px-3 py-3 sm:px-4">
          <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
            {error ?? queryError}
          </p>
          {queryError ? (
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => {
                authQuery.refresh();
                installQuery.refresh();
              }}
            >
              {t("settings.providerSetupSection.retrySetupStatus")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
