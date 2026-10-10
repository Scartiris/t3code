import type { StaticScreenProps } from "@react-navigation/native";
import {
  ccSwitchSites,
  CC_SWITCH_ENGINES,
  ccSwitchEngineSiteIds,
  ccSwitchEngineModels,
  DEFAULT_SERVER_SETTINGS,
  type CcSwitchSettings,
  type CcSwitchSite,
  type CcSwitchStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  addCcSwitchSite,
  removeCcSwitchSite,
  toggleCcSwitchSite,
} from "@t3tools/client-runtime/cc-switch";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";

const engines = CC_SWITCH_ENGINES;
const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "操作失败，请检查连接后重试。";
};

function GatewayForm({ environmentId }: { environmentId: EnvironmentId }) {
  const saved =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.ccSwitch ??
    DEFAULT_SERVER_SETTINGS.ccSwitch;
  const statusCommand = useAtomCommand(serverEnvironment.ccSwitchStatus, { reportFailure: false });
  const configure = useAtomCommand(serverEnvironment.configureCcSwitch, { reportFailure: false });
  const fetchModels = useAtomCommand(serverEnvironment.ccSwitchModels, { reportFailure: false });
  const [draft, setDraft] = useState<CcSwitchSettings | null>(null);
  const [status, setStatus] = useState<CcSwitchStatus | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const value = draft ?? saved;
  const sites = ccSwitchSites(value);
  const edit = (patch: Partial<CcSwitchSettings>) => {
    setDraft({ ...value, sites, ...patch });
    setNotice("");
  };
  const editSite = (id: string, patch: Partial<CcSwitchSite>) =>
    edit({ sites: sites.map((site) => (site.id === id ? { ...site, ...patch } : site)) });
  useEffect(() => {
    let active = true;
    void statusCommand({ environmentId, input: {} }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") setStatus(result.value);
      else setNotice(failureText(result));
    });
    return () => {
      active = false;
    };
  }, [environmentId, statusCommand]);
  const save = async (clearSiteId?: string) => {
    setBusy(true);
    setNotice("");
    try {
      const selected =
        clearSiteId &&
        engines.some((engine) => ccSwitchEngineSiteIds(value, engine).includes(clearSiteId));
      const result = await configure({
        environmentId,
        input: {
          settings: { ...value, sites, ...(selected ? { enabled: false } : {}) },
          discoverModels: !clearSiteId,
          siteKeys: sites.flatMap((site) =>
            keys[site.id]?.trim() && site.id !== clearSiteId
              ? [{ siteId: site.id, apiKey: keys[site.id]!.trim() }]
              : [],
          ),
          ...(clearSiteId ? { clearSiteKeys: [clearSiteId] } : {}),
        },
      });
      if (result._tag !== "Success") {
        setNotice(failureText(result));
        return;
      }
      setStatus(result.value);
      setDraft(null);
      setKeys({});
      setNotice(
        clearSiteId
          ? selected
            ? "站点 Key 已删除，网关已停用。"
            : "站点 Key 已删除。"
          : "已保存并自动获取模型，可在聊天中选择引擎、站点和模型。",
      );
    } finally {
      setBusy(false);
    }
  };
  const loadModels = async (site: CcSwitchSite) => {
    setBusy(true);
    setNotice("");
    try {
      const result = await fetchModels({
        environmentId,
        input: {
          siteId: site.id,
          baseUrl: site.baseUrl,
          ...(keys[site.id]?.trim() ? { apiKey: keys[site.id]!.trim() } : {}),
        },
      });
      if (result._tag !== "Success") {
        setNotice(failureText(result));
        return;
      }
      editSite(site.id, { models: result.value });
      setNotice(`${site.name}：已获取 ${result.value.length} 个模型。`);
    } finally {
      setBusy(false);
    }
  };
  const removeSite = (id: string) => {
    edit(removeCcSwitchSite(value, id));
    setNotice("保存后删除站点及其 Key，其他已勾选的站点继续可用。");
  };
  const addSite = () =>
    edit(
      addCcSwitchSite(
        value,
        { id: uuidv4(), name: "新站点", baseUrl: "https://", models: [] },
        status?.sites.filter((site) => site.apiKeyConfigured).map((site) => site.id) ?? [],
      ),
    );
  return (
    <>
      <SettingsSection title="统一模型网关">
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground-muted">
            填写站点地址和
            Key，保存时自动获取模型。为每个引擎选择多个可用站点，聊天时直接选择站点和模型。
          </Text>
          <Text className="text-sm text-foreground-muted">
            {status
              ? `${status.version ?? "CC Switch CLI 未安装"} · ${status.state === "ready" ? "网关已就绪" : status.state === "disabled" ? "未启用" : "网关未就绪"}`
              : "正在检查服务器…"}
          </Text>
        </View>
        <SettingsSwitchRow
          icon="server.rack"
          label="启用统一模型网关"
          value={value.enabled}
          disabled={busy}
          onValueChange={(enabled) => edit({ enabled })}
        />
        <SettingsActionRow
          icon="plus"
          label="新增站点"
          disabled={busy || sites.length >= 20}
          onPress={addSite}
        />
      </SettingsSection>
      {sites.map((site) => {
        const keySaved =
          status?.sites.find((entry) => entry.id === site.id)?.apiKeyConfigured ??
          (site.id === "default" && status?.apiKeyConfigured && status.sites.length === 0);
        return (
          <SettingsSection key={site.id} title={site.name || "新站点"}>
            <View className="gap-3 p-4">
              <Text className="text-sm text-foreground-muted">站点名称</Text>
              <AppTextInput
                accessibilityLabel="站点名称"
                value={site.name}
                maxLength={100}
                onChangeText={(name) => editSite(site.id, { name })}
                editable={!busy}
                className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
              />
              <Text className="text-sm text-foreground-muted">API 服务地址</Text>
              <AppTextInput
                accessibilityLabel={`${site.name} API 地址`}
                value={site.baseUrl}
                onChangeText={(baseUrl) => editSite(site.id, { baseUrl, models: [] })}
                editable={!busy}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
              />
              <Text className="text-sm text-foreground-muted">站点 API Key</Text>
              <AppTextInput
                accessibilityLabel={`${site.name} API Key`}
                value={keys[site.id] ?? ""}
                onChangeText={(key) => setKeys({ ...keys, [site.id]: key })}
                editable={!busy}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={keySaved ? "已保存在 CC Switch；留空保留" : "填写此站点的 Key"}
                className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
              />
              <Text className="text-sm text-foreground-muted">更换地址需重新填写 Key。</Text>
            </View>
            <SettingsActionRow
              icon="arrow.clockwise"
              label={`刷新模型（${site.models.length}）`}
              disabled={busy}
              onPress={() => void loadModels(site)}
            />
            <SettingsActionRow
              icon="trash"
              label="删除 Key"
              disabled={busy || !keySaved}
              onPress={() => void save(site.id)}
            />
            <SettingsActionRow
              icon="trash"
              label="移除站点"
              disabled={busy}
              onPress={() => removeSite(site.id)}
            />
          </SettingsSection>
        );
      })}
      {engines.map((engine) => {
        const { siteField, modelField, name: label } = engine;
        const allowedIds = ccSwitchEngineSiteIds(value, engine);
        const selected = sites.find((site) => site.id === value[siteField]);
        const query = (modelSearch[modelField] ?? "").trim().toLowerCase();
        const matches = selected
          ? ccSwitchEngineModels(selected, engine).filter((model) =>
              model.toLowerCase().includes(query),
            )
          : [];
        return (
          <SettingsSection key={siteField} title={`${label} 连接`}>
            <View className="p-4">
              <Text className="text-sm text-foreground-muted">可用站点（可多选）</Text>
            </View>
            {sites.map((site) => (
              <SettingsSwitchRow
                key={site.id}
                icon="server.rack"
                label={site.name}
                value={allowedIds.includes(site.id)}
                disabled={busy}
                onValueChange={(checked) =>
                  edit(toggleCcSwitchSite(value, engine, site.id, checked))
                }
              />
            ))}
            <View className="p-4">
              <Text className="text-sm text-foreground-muted">默认站点</Text>
            </View>
            {sites
              .filter((site) => allowedIds.includes(site.id))
              .map((site) => (
                <SettingsChoiceRow
                  key={site.id}
                  label={site.name}
                  description={site.baseUrl}
                  selected={value[siteField] === site.id}
                  separated
                  disabled={busy}
                  onPress={() => edit({ [siteField]: site.id, [modelField]: "" })}
                />
              ))}
            <View className="gap-3 p-4">
              <Text className="text-sm text-foreground-muted">默认模型</Text>
              <AppTextInput
                accessibilityLabel={`${label} 模型`}
                value={value[modelField]}
                onChangeText={(model) => edit({ [modelField]: model })}
                editable={!busy && !!selected && allowedIds.includes(selected.id)}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="留空自动选择，或输入模型 ID"
                className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
              />
              {selected && selected.models.length > 0 ? (
                <>
                  <AppTextInput
                    accessibilityLabel={`${label} 搜索模型`}
                    value={modelSearch[modelField] ?? ""}
                    onChangeText={(text) => setModelSearch({ ...modelSearch, [modelField]: text })}
                    editable={!busy}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="搜索站点模型"
                    className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
                  />
                  <Text className="text-xs text-foreground-muted">
                    {matches.length > 20
                      ? `显示前 20 个匹配模型，共 ${matches.length} 个。输入名称缩小范围。`
                      : `${matches.length} 个匹配模型`}
                  </Text>
                </>
              ) : null}
            </View>
            {matches.slice(0, 20).map((model) => (
              <SettingsChoiceRow
                key={model}
                label={model}
                description=""
                selected={value[modelField] === model}
                separated
                disabled={busy}
                onPress={() => edit({ [modelField]: model })}
              />
            ))}
          </SettingsSection>
        );
      })}
      <SettingsSection title="应用设置">
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground-muted">
            Claude Code 使用 Messages，Codex 和 OpenCode 使用
            Responses，请选择站点支持的模型。关闭后恢复各引擎原连接。
          </Text>
          {notice ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {notice}
            </Text>
          ) : null}
        </View>
        <SettingsActionRow
          icon="checkmark"
          label="保存设置"
          disabled={busy}
          onPress={() => void save()}
        />
      </SettingsSection>
    </>
  );
}

export function SettingsCcSwitchRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return (
    <SettingsScreen title="CC Switch">
      <ScreenScrollView>
        <GatewayForm key={route.params.environmentId} environmentId={route.params.environmentId} />
      </ScreenScrollView>
    </SettingsScreen>
  );
}
