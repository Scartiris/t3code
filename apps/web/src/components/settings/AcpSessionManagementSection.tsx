import type {
  AcpRegistryConfigurableProvider,
  AcpRegistrySession,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { t } from "@t3tools/shared/i18n";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

interface AcpSessionProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description:
      error instanceof Error
        ? error.message
        : t("settings.acpSessionManagementSection.acpOperationFailed"),
  });
}

export function AcpSessionManagementSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly projects: ReadonlyArray<AcpSessionProject>;
  readonly readOnly: boolean;
}) {
  const [projectId, setProjectId] = useState<ProjectId | null>(props.projects[0]?.id ?? null);
  const [sessions, setSessions] = useState<ReadonlyArray<AcpRegistrySession>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [providers, setProviders] = useState<ReadonlyArray<AcpRegistryConfigurableProvider>>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<
    Readonly<Record<string, { apiType: string; baseUrl: string; headers: string }>>
  >({});
  const listSessions = useAtomCommand(serverEnvironment.listAcpRegistrySessions, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importAcpRegistrySession, {
    reportFailure: false,
  });
  const deleteSession = useAtomCommand(serverEnvironment.deleteAcpRegistrySession, {
    reportFailure: false,
  });
  const listProviders = useAtomCommand(serverEnvironment.listAcpRegistryProviders, {
    reportFailure: false,
  });
  const setProvider = useAtomCommand(serverEnvironment.setAcpRegistryProvider, {
    reportFailure: false,
  });
  const disableProvider = useAtomCommand(serverEnvironment.disableAcpRegistryProvider, {
    reportFailure: false,
  });
  const logout = useAtomCommand(serverEnvironment.logoutAcpRegistry, { reportFailure: false });
  const canList = props.provider.nativeSessions?.canList === true;
  const canImport =
    props.provider.nativeSessions?.canLoad === true ||
    props.provider.nativeSessions?.canResume === true;
  const canLogout =
    props.provider.auth.canLogout === true && !props.provider.setup?.canAuthenticate;
  const canDelete = props.provider.nativeSessions?.canDelete === true;
  const canConfigureProviders = props.provider.configurableProviders === true;
  const projectOperationPending =
    loading ||
    importingSessionId !== null ||
    deletingSessionId !== null ||
    loadingProviders ||
    savingProviderId !== null;

  if (!canList && !canLogout && !canConfigureProviders) return null;

  const loadSessions = async (cursor?: string) => {
    if (projectId === null || loading) return;
    setLoading(true);
    const result = await listSessions({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    setLoading(false);
    if (result._tag === "Success") {
      setSessions((current) =>
        cursor === undefined ? result.value.sessions : [...current, ...result.value.sessions],
      );
      setNextCursor(result.value.nextCursor);
      return;
    }
    reportFailure(t("settings.acpSessionManagementSection.couldNotListSessions"), result);
  };

  const importNativeSession = async (session: AcpRegistrySession) => {
    if (projectId === null || importingSessionId !== null) return;
    setImportingSessionId(session.sessionId);
    const result = await importSession({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
    setImportingSessionId(null);
    if (result._tag === "Success") {
      setSessions((current) =>
        current.map((candidate) =>
          candidate.sessionId === session.sessionId
            ? { ...candidate, importedThreadId: result.value.threadId }
            : candidate,
        ),
      );
      toastManager.add({
        type: "success",
        title: result.value.imported
          ? t("settings.acpSessionManagementSection.sessionImported")
          : t("settings.acpSessionManagementSection.sessionAlreadyImported"),
      });
      return;
    }
    reportFailure(t("settings.acpSessionManagementSection.couldNotImportSession"), result);
  };

  const deleteNativeSession = async (session: AcpRegistrySession) => {
    if (projectId === null || deletingSessionId !== null || session.importedThreadId !== null)
      return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      t("settings.acpSessionManagementSection.confirmDeleteSession", {
        session: session.title ?? session.sessionId,
      }),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setDeletingSessionId(session.sessionId);
    const result = await deleteSession({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, projectId, sessionId: session.sessionId },
    });
    setDeletingSessionId(null);
    if (result._tag === "Success") {
      setSessions((current) =>
        current.filter((candidate) => candidate.sessionId !== session.sessionId),
      );
      toastManager.add({
        type: "success",
        title: t("settings.acpSessionManagementSection.sessionDeleted"),
      });
      return;
    }
    reportFailure(t("settings.acpSessionManagementSection.couldNotDeleteSession"), result);
  };

  const loadProviders = async () => {
    if (projectId === null || loadingProviders) return;
    setLoadingProviders(true);
    const result = await listProviders({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, projectId },
    });
    setLoadingProviders(false);
    if (result._tag === "Success") {
      setProviders(result.value.providers);
      setProviderDrafts(
        Object.fromEntries(
          result.value.providers.map((provider) => [
            provider.providerId,
            {
              apiType: provider.current?.apiType ?? provider.supported[0] ?? "",
              baseUrl: provider.current?.baseUrl ?? "",
              headers: "",
            },
          ]),
        ),
      );
      return;
    }
    reportFailure(t("settings.acpSessionManagementSection.couldNotListProviders"), result);
  };

  const saveProvider = async (provider: AcpRegistryConfigurableProvider) => {
    if (projectId === null || savingProviderId !== null) return;
    const draft = providerDrafts[provider.providerId];
    if (draft === undefined || draft.apiType.length === 0 || draft.baseUrl.length === 0) return;
    let headers: Record<string, string> | undefined;
    if (draft.headers.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(draft.headers);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          !Object.values(parsed).every((value) => typeof value === "string")
        ) {
          throw new Error(t("settings.acpSessionManagementSection.headersMustBeJsonObject"));
        }
        headers = parsed as Record<string, string>;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings.acpSessionManagementSection.invalidProviderHeaders"),
          description:
            error instanceof Error
              ? error.message
              : t("settings.acpSessionManagementSection.headersMustBeValidJson"),
        });
        return;
      }
    }
    setSavingProviderId(provider.providerId);
    const result = await setProvider({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        providerId: provider.providerId,
        apiType: draft.apiType,
        baseUrl: draft.baseUrl,
        ...(headers === undefined ? {} : { headers }),
      },
    });
    setSavingProviderId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: t("settings.acpSessionManagementSection.providerConfigured"),
      });
      await loadProviders();
      return;
    }
    reportFailure(t("settings.acpSessionManagementSection.couldNotConfigureProvider"), result);
  };

  const disableConfiguredProvider = async (provider: AcpRegistryConfigurableProvider) => {
    if (projectId === null || savingProviderId !== null || provider.required) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      t("settings.acpSessionManagementSection.confirmDisableProvider", {
        provider: provider.providerId,
      }),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setSavingProviderId(provider.providerId);
    const result = await disableProvider({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, projectId, providerId: provider.providerId },
    });
    setSavingProviderId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: t("settings.acpSessionManagementSection.providerDisabled"),
      });
      await loadProviders();
      return;
    }
    reportFailure(t("settings.acpSessionManagementSection.couldNotDisableProvider"), result);
  };

  const logoutProvider = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    const result = await logout({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    });
    setLoggingOut(false);
    if (result._tag === "Success") {
      setSessions([]);
      setNextCursor(null);
      toastManager.add({
        type: "success",
        title: t("settings.acpSessionManagementSection.loggedOut"),
      });
      return;
    }
    reportFailure(t("settings.acpSessionManagementSection.couldNotLogOut"), result);
  };

  return (
    <div className="grid gap-3">
      <SettingsRow
        title={t("settings.acpSessionManagementSection.nativeSessions")}
        description={t("settings.acpSessionManagementSection.nativeSessionsDescription")}
        status={
          canList && props.projects.length === 0
            ? t("settings.acpSessionManagementSection.addProjectFirst")
            : undefined
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            {canLogout ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={props.readOnly || loggingOut}
                onClick={() => void logoutProvider()}
              >
                {loggingOut
                  ? t("settings.acpSessionManagementSection.loggingOut")
                  : t("settings.acpSessionManagementSection.logOut")}
              </Button>
            ) : null}
            {canList && props.projects.length > 0 ? (
              <>
                <Select
                  value={projectId ?? ""}
                  disabled={props.readOnly || projectOperationPending}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setProjectId(value as ProjectId);
                    setSessions([]);
                    setNextCursor(null);
                    setProviders([]);
                    setProviderDrafts({});
                  }}
                >
                  <SelectTrigger
                    aria-label={t("settings.acpSessionManagementSection.projectForSessionsAria")}
                    className="w-40"
                    size="sm"
                  >
                    <SelectValue>
                      {props.projects.find((project) => project.id === projectId)?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {props.projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={props.readOnly || loading || projectId === null}
                  onClick={() => void loadSessions()}
                >
                  {loading
                    ? t("settings.acpSessionManagementSection.loading")
                    : sessions.length === 0
                      ? t("settings.acpSessionManagementSection.listSessions")
                      : t("settings.acpSessionManagementSection.refresh")}
                </Button>
              </>
            ) : null}
          </div>
        }
      >
        {canList && (sessions.length > 0 || nextCursor !== null) ? (
          <>
            {sessions.length > 0 ? (
              <div className="divide-y divide-border/60 border-y border-border/60">
                {sessions.map((session) => (
                  <div
                    key={session.sessionId}
                    className="flex min-w-0 items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs text-foreground">
                        {session.title ?? session.sessionId}
                      </p>
                      <code className="block truncate text-3xs text-muted-foreground">
                        {session.sessionId}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost-muted"
                        disabled={
                          props.readOnly ||
                          !canImport ||
                          session.importedThreadId !== null ||
                          importingSessionId !== null
                        }
                        onClick={() => void importNativeSession(session)}
                      >
                        {session.importedThreadId !== null
                          ? t("settings.acpSessionManagementSection.imported")
                          : importingSessionId === session.sessionId
                            ? t("settings.acpSessionManagementSection.importing")
                            : t("settings.acpSessionManagementSection.import")}
                      </Button>
                      {canDelete ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost-muted"
                          disabled={
                            props.readOnly ||
                            session.importedThreadId !== null ||
                            deletingSessionId !== null
                          }
                          onClick={() => void deleteNativeSession(session)}
                        >
                          {deletingSessionId === session.sessionId
                            ? t("settings.acpSessionManagementSection.deleting")
                            : t("settings.acpSessionManagementSection.delete")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {nextCursor !== null ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                className="w-fit"
                disabled={props.readOnly || loading}
                onClick={() => void loadSessions(nextCursor)}
              >
                {loading
                  ? t("settings.acpSessionManagementSection.loading")
                  : t("settings.acpSessionManagementSection.loadMore")}
              </Button>
            ) : null}
          </>
        ) : null}
      </SettingsRow>

      {canConfigureProviders ? (
        <div className="grid gap-3 border-t border-border/60 px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-foreground">
                {t("settings.acpSessionManagementSection.agentProviders")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("settings.acpSessionManagementSection.agentProvidersDescription")}
              </p>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={props.readOnly || loadingProviders || projectId === null}
              onClick={() => void loadProviders()}
            >
              {loadingProviders
                ? t("settings.acpSessionManagementSection.loading")
                : providers.length === 0
                  ? t("settings.acpSessionManagementSection.listProviders")
                  : t("settings.acpSessionManagementSection.refresh")}
            </Button>
          </div>

          {!canList && props.projects.length > 1 ? (
            <Select
              value={projectId ?? ""}
              disabled={props.readOnly || projectOperationPending}
              onValueChange={(value) => {
                if (value === null) return;
                setProjectId(value as ProjectId);
                setProviders([]);
                setProviderDrafts({});
              }}
            >
              <SelectTrigger
                aria-label={t("settings.acpSessionManagementSection.projectForProvidersAria")}
                className="min-w-48"
                size="xs"
              >
                <SelectValue>
                  {props.projects.find((project) => project.id === projectId)?.title}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {props.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}

          {providers.length > 0 ? (
            <div className="divide-y divide-border/60 border-y border-border/60">
              {providers.map((provider) => {
                const draft = providerDrafts[provider.providerId] ?? {
                  apiType: provider.current?.apiType ?? provider.supported[0] ?? "",
                  baseUrl: provider.current?.baseUrl ?? "",
                  headers: "",
                };
                const updateDraft = (update: Partial<typeof draft>) =>
                  setProviderDrafts((current) => ({
                    ...current,
                    [provider.providerId]: { ...draft, ...update },
                  }));
                return (
                  <div key={provider.providerId} className="grid gap-2 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">
                          {provider.providerId}
                        </p>
                        <p className="text-3xs text-muted-foreground">
                          {provider.current === null
                            ? t("settings.acpSessionManagementSection.disabled")
                            : t("settings.acpSessionManagementSection.configured")}
                          {provider.required
                            ? t("settings.acpSessionManagementSection.requiredSuffix")
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={
                            props.readOnly ||
                            savingProviderId !== null ||
                            draft.apiType.length === 0 ||
                            draft.baseUrl.length === 0
                          }
                          onClick={() => void saveProvider(provider)}
                        >
                          {savingProviderId === provider.providerId
                            ? t("settings.acpSessionManagementSection.saving")
                            : t("action.save")}
                        </Button>
                        {!provider.required && provider.current !== null ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost-muted"
                            disabled={props.readOnly || savingProviderId !== null}
                            onClick={() => void disableConfiguredProvider(provider)}
                          >
                            {t("settings.acpSessionManagementSection.disable")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                      <Select
                        value={draft.apiType}
                        disabled={props.readOnly || savingProviderId !== null}
                        onValueChange={(value) => {
                          if (value !== null) updateDraft({ apiType: value });
                        }}
                      >
                        <SelectTrigger
                          aria-label={t("settings.acpSessionManagementSection.protocolAria", {
                            provider: provider.providerId,
                          })}
                          size="sm"
                        >
                          <SelectValue>{draft.apiType}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {provider.supported.map((protocol) => (
                            <SelectItem key={protocol} value={protocol}>
                              {protocol}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <Input
                        size="sm"
                        type="url"
                        aria-label={t("settings.acpSessionManagementSection.baseUrlAria", {
                          provider: provider.providerId,
                        })}
                        placeholder="https://api.example.com"
                        value={draft.baseUrl}
                        disabled={props.readOnly || savingProviderId !== null}
                        onValueChange={(value) => updateDraft({ baseUrl: value })}
                      />
                    </div>
                    <Input
                      size="sm"
                      type="password"
                      aria-label={t("settings.acpSessionManagementSection.headersAria", {
                        provider: provider.providerId,
                      })}
                      placeholder={t("settings.acpSessionManagementSection.headersPlaceholder")}
                      value={draft.headers}
                      disabled={props.readOnly || savingProviderId !== null}
                      onValueChange={(value) => updateDraft({ headers: value })}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
