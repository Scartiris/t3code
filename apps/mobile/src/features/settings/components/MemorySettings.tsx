import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type MemoryConnectionStatus,
  type MemorySettings as MemorySettingsValue,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsActionRow } from "./SettingsActionRow";

const problems = {
  configuration: "settings.memory.configurationError",
  unauthorized: "settings.memory.unauthorized",
  unavailable: "settings.memory.unavailable",
  backend: "settings.memory.backendError",
} as const;

export function MemorySettings({
  environmentId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const saved =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.memory ??
    DEFAULT_SERVER_SETTINGS.memory;
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
  const locked = disabled || busy || status === null;
  return (
    <SettingsSection title={t("settings.memory.title")}>
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground-muted">{t("settings.memory.description")}</Text>
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {status
            ? `${t(status.source === "deployment" ? "settings.memory.deploymentSource" : "settings.memory.settingsSource")} · ${status.problem ? t(problems[status.problem]) : t(status.state === "ready" ? "settings.memory.ready" : "settings.memory.disabled")}`
            : t("settings.memory.loading")}
        </Text>
        {notice ? <Text className="text-sm text-foreground-muted">{notice}</Text> : null}
      </View>
      <SettingsSwitchRow
        icon={{ ios: "brain", android: "psychology" }}
        label={t("settings.memory.enabled")}
        value={value.enabled === true}
        disabled={locked}
        onValueChange={(enabled) => edit({ enabled })}
      />
      <SettingsChoiceRow
        label="OpenViking"
        description=""
        separated={false}
        selected={value.backend === "openviking"}
        disabled={locked}
        onPress={() => edit({ backend: "openviking" })}
      />
      <SettingsChoiceRow
        label={t("settings.memory.protocol")}
        description=""
        separated
        selected={value.backend === "protocol"}
        disabled={locked}
        onPress={() => edit({ backend: "protocol" })}
      />
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground-muted">{t("settings.memory.url")}</Text>
        <AppTextInput
          accessibilityLabel={t("settings.memory.url")}
          value={value.baseUrl}
          onChangeText={(baseUrl) => edit({ baseUrl })}
          editable={!locked}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://127.0.0.1:1933"
          className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        />
        <Text className="text-sm text-foreground-muted">{t("settings.memory.serverAddress")}</Text>
        <Text className="text-sm text-foreground-muted">API Key</Text>
        <AppTextInput
          accessibilityLabel="API Key"
          value={key}
          onChangeText={setKey}
          editable={!locked}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t(
            status?.apiKeyConfigured ? "settings.memory.keySaved" : "settings.memory.keyMissing",
          )}
          className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        />
        <Text className="text-sm text-foreground-muted">{t("settings.memory.keyHint")}</Text>
      </View>
      <SettingsActionRow
        icon="checkmark"
        label={t("settings.memory.save")}
        disabled={locked || (draft === null && key.trim() === "")}
        onPress={() => void save()}
      />
      <SettingsActionRow
        icon="arrow.clockwise"
        label={t("settings.memory.check")}
        disabled={busy || disabled}
        onPress={() => void check()}
      />
      <SettingsActionRow
        icon="arrow.uturn.backward"
        label={t("settings.memory.reset")}
        disabled={locked || saved.enabled === null}
        onPress={() => void save(true)}
      />
    </SettingsSection>
  );
}
