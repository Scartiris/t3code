import type {
  EnvironmentId,
  MemoryConnectionStatus,
  MemorySettings as MemorySettingsValue,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsSection } from "./settingsLayout";

const problems = {
  configuration: "settings.memory.configurationError",
  unauthorized: "settings.memory.unauthorized",
  unavailable: "settings.memory.unavailable",
  backend: "settings.memory.backendError",
} as const;

export function MemorySettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.memory);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const checkConnection = useAtomCommand(serverEnvironment.checkMemoryConnection);
  const [status, setStatus] = useState<MemoryConnectionStatus | null>(null);
  const [draft, setDraft] = useState<Pick<
    MemorySettingsValue,
    "enabled" | "backend" | "baseUrl"
  > | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const checkGeneration = useRef(0);
  useEffect(() => {
    const generation = ++checkGeneration.current;
    setStatus(null);
    setNotice("");
    void checkConnection({ environmentId, input: {} }).then((result) => {
      if (generation !== checkGeneration.current) return;
      if (result._tag === "Success") setStatus(result.value);
      else setNotice(t("settings.memory.checkFailed"));
    });
    return () => {
      checkGeneration.current++;
    };
  }, [checkConnection, environmentId, saved]);

  const value = draft ?? {
    enabled: saved.enabled ?? status?.enabled ?? false,
    backend: saved.enabled === null ? (status?.backend ?? "openviking") : saved.backend,
    baseUrl: saved.enabled === null ? (status?.baseUrl ?? "") : saved.baseUrl,
  };
  const edit = (patch: Partial<typeof value>) => {
    setDraft({ ...value, ...patch });
    setNotice("");
  };
  const check = async () => {
    setBusy(true);
    const generation = ++checkGeneration.current;
    try {
      const result = await checkConnection({ environmentId, input: {} });
      if (generation === checkGeneration.current) {
        if (result._tag === "Success") {
          setStatus(result.value);
          setNotice("");
        } else setNotice(t("settings.memory.checkFailed"));
      }
    } finally {
      setBusy(false);
    }
  };
  const save = async (reset = false) => {
    setBusy(true);
    setNotice("");
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            memory: reset
              ? { enabled: null, baseUrl: "", apiKey: "" }
              : {
                  ...value,
                  enabled: value.enabled === true,
                  baseUrl: value.baseUrl.trim(),
                  ...(key.trim() ? { apiKey: key.trim() } : {}),
                },
          },
        },
      });
      if (result._tag !== "Success") return;
      setDraft(null);
      setKey("");
      setNotice(t("settings.memory.saved"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="openviking-memory" title={t("settings.memory.title")}>
      <form
        className="grid gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.memory.description")}
        </p>
        <fieldset disabled={busy || status === null} className="grid gap-4">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`memory-enabled-${environmentId}`}>
              {t("settings.memory.enabled")}
            </Label>
            <Switch
              id={`memory-enabled-${environmentId}`}
              checked={value.enabled === true}
              onCheckedChange={(enabled) => edit({ enabled })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("settings.memory.backend")}</Label>
            <ToggleGroup
              variant="segmented"
              aria-label={t("settings.memory.backend")}
              value={[value.backend]}
              onValueChange={(next) => {
                if (next[0] === "openviking" || next[0] === "protocol") edit({ backend: next[0] });
              }}
            >
              <Toggle value="openviking">OpenViking</Toggle>
              <Toggle value="protocol">{t("settings.memory.protocol")}</Toggle>
            </ToggleGroup>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`memory-url-${environmentId}`}>{t("settings.memory.url")}</Label>
            <Input
              id={`memory-url-${environmentId}`}
              size="sm"
              type="url"
              required={value.enabled === true}
              placeholder="http://127.0.0.1:1933"
              value={value.baseUrl}
              onChange={(event) => edit({ baseUrl: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("settings.memory.serverAddress")}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`memory-key-${environmentId}`}>API Key</Label>
            <Input
              id={`memory-key-${environmentId}`}
              size="sm"
              type="password"
              autoComplete="off"
              placeholder={t(
                status?.apiKeyConfigured
                  ? "settings.memory.keySaved"
                  : "settings.memory.keyMissing",
              )}
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                setNotice("");
              }}
            />
            <p className="text-xs text-muted-foreground">{t("settings.memory.keyHint")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={status === null || (draft === null && key.trim() === "")}
            >
              {t("settings.memory.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={saved.enabled === null}
              onClick={() => void save(true)}
            >
              {t("settings.memory.reset")}
            </Button>
          </div>
        </fieldset>
        <div>
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => void check()}
          >
            {t("settings.memory.check")}
          </Button>
        </div>
        <div role="status" aria-live="polite" className="grid gap-1 text-xs text-muted-foreground">
          {status ? (
            <p>
              {t(
                status.source === "deployment"
                  ? "settings.memory.deploymentSource"
                  : "settings.memory.settingsSource",
              )}
              {" · "}
              {status.problem
                ? t(problems[status.problem])
                : t(
                    status.state === "ready" ? "settings.memory.ready" : "settings.memory.disabled",
                  )}
            </p>
          ) : (
            <p>{t("settings.memory.loading")}</p>
          )}
          {notice ? <p>{notice}</p> : null}
        </div>
      </form>
    </SettingsSection>
  );
}
