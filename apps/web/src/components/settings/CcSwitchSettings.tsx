import {
  ccSwitchSites,
  CC_SWITCH_ENGINES,
  ccSwitchEngineSiteIds,
  ccSwitchEngineModels,
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
import { useEffect, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const engines = CC_SWITCH_ENGINES;
const failureText = (failure: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error ? error.message : "操作失败，请检查连接后重试。";
};

function GatewayForm({ environmentId }: { environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.ccSwitch);
  const statusCommand = useAtomCommand(serverEnvironment.ccSwitchStatus, { reportFailure: false });
  const configure = useAtomCommand(serverEnvironment.configureCcSwitch, { reportFailure: false });
  const fetchModels = useAtomCommand(serverEnvironment.ccSwitchModels, { reportFailure: false });
  const [draft, setDraft] = useState<CcSwitchSettings | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<CcSwitchStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
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
        { id: randomUUID(), name: "新站点", baseUrl: "https://", models: [] },
        status?.sites.filter((site) => site.apiKeyConfigured).map((site) => site.id) ?? [],
      ),
    );
  return (
    <SettingsSection id="cc-switch" title="CC Switch · 统一模型网关">
      <form
        className="grid gap-6 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="text-sm text-muted-foreground">
          填写站点地址和
          Key，保存时自动获取模型。为每个引擎勾选多个可用站点，聊天时直接选择站点和模型。
        </p>
        <p className="text-xs text-muted-foreground" role="status">
          {status
            ? `${status.version ?? "CC Switch CLI 未安装"} · ${status.state === "ready" ? "网关已就绪" : status.state === "disabled" ? "未启用" : "网关未就绪"}`
            : "正在检查服务器…"}
        </p>
        <fieldset disabled={busy} className="grid gap-6">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="cc-switch-enabled">启用统一模型网关</Label>
            <Switch
              id="cc-switch-enabled"
              checked={value.enabled}
              onCheckedChange={(enabled) => edit({ enabled })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">模型站点</h3>
            <Button type="button" variant="outline" disabled={sites.length >= 20} onClick={addSite}>
              新增站点
            </Button>
          </div>
          {sites.length === 0 ? (
            <p className="text-sm text-muted-foreground">添加一个站点后即可配置模型连接。</p>
          ) : null}
          {sites.map((site) => {
            const prefix = `cc-site-${site.id}`;
            const keySaved =
              status?.sites.find((entry) => entry.id === site.id)?.apiKeyConfigured ??
              (site.id === "default" && status?.apiKeyConfigured && status.sites.length === 0);
            return (
              <div key={site.id} className="grid gap-3 rounded-lg border p-4">
                <div className="grid gap-1.5">
                  <Label htmlFor={`${prefix}-name`}>站点名称</Label>
                  <Input
                    id={`${prefix}-name`}
                    value={site.name}
                    maxLength={100}
                    onChange={(event) => editSite(site.id, { name: event.target.value })}
                    placeholder="例如 PackyAPI、备用站点"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${prefix}-url`}>API 服务地址</Label>
                  <Input
                    id={`${prefix}-url`}
                    value={site.baseUrl}
                    onChange={(event) =>
                      editSite(site.id, { baseUrl: event.target.value, models: [] })
                    }
                    placeholder="https://www.packyapi.ai"
                    autoComplete="off"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${prefix}-key`}>站点 API Key</Label>
                  <Input
                    id={`${prefix}-key`}
                    type="password"
                    value={keys[site.id] ?? ""}
                    onChange={(event) => setKeys({ ...keys, [site.id]: event.target.value })}
                    autoComplete="new-password"
                    placeholder={keySaved ? "已保存在 CC Switch；留空保留" : "填写此站点的 Key"}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Key 由服务器端 CC Switch 保存。更换地址时需重新填写 Key；保存时自动获取模型。
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => void loadModels(site)}>
                    刷新模型（{site.models.length}）
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!keySaved}
                    onClick={() => void save(site.id)}
                  >
                    删除 Key
                  </Button>
                  <Button type="button" variant="outline" onClick={() => removeSite(site.id)}>
                    移除站点
                  </Button>
                </div>
              </div>
            );
          })}
          <h3 className="text-sm font-medium">引擎连接</h3>
          {engines.map((engine) => {
            const { siteField, modelField, name: label } = engine;
            const allowedIds = ccSwitchEngineSiteIds(value, engine);
            const allowed = sites.filter((site) => allowedIds.includes(site.id));
            const selected = sites.find((site) => site.id === value[siteField]);
            const modelList = `cc-models-${modelField}`;
            return (
              <div key={siteField} className="grid gap-3 rounded-lg border p-4">
                <h4 className="text-sm font-medium">{label}</h4>
                <p className="text-xs text-muted-foreground">
                  勾选可用站点，可多选。聊天模型列表将按“引擎 · 站点”显示。
                </p>
                <div className="grid gap-2">
                  {sites.map((site) => (
                    <div key={site.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`cc-${engine.driver}-${site.id}`}
                        checked={allowedIds.includes(site.id)}
                        onCheckedChange={(checked) =>
                          edit(toggleCcSwitchSite(value, engine, site.id, checked))
                        }
                      />
                      <Label htmlFor={`cc-${engine.driver}-${site.id}`}>
                        {site.name}（{ccSwitchEngineModels(site, engine).length} 个模型）
                      </Label>
                    </div>
                  ))}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`cc-switch-${siteField}`}>默认站点</Label>
                  <Select
                    value={allowedIds.includes(selected?.id ?? "") ? selected?.id : null}
                    onValueChange={(id) => {
                      if (id && allowed.some((site) => site.id === id))
                        edit({ [siteField]: id, [modelField]: "" });
                    }}
                  >
                    <SelectTrigger id={`cc-switch-${siteField}`} aria-label={`${label} 使用站点`}>
                      <SelectValue>
                        {(id: string | null) =>
                          sites.find((site) => site.id === id)?.name ?? "选择站点"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {allowed.map((site) => (
                        <SelectItem key={site.id} value={site.id}>
                          {site.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`cc-switch-${modelField}`}>默认模型</Label>
                  <Input
                    id={`cc-switch-${modelField}`}
                    list={modelList}
                    disabled={!selected || !allowedIds.includes(selected.id)}
                    value={value[modelField]}
                    onChange={(event) => edit({ [modelField]: event.target.value })}
                    placeholder="留空自动选择，或输入模型 ID"
                    autoComplete="off"
                  />
                  <datalist id={modelList}>
                    {selected &&
                      ccSwitchEngineModels(selected, engine).map((model) => (
                        <option key={model} value={model} />
                      ))}
                  </datalist>
                </div>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Claude Code 使用 Messages 协议，Codex 和 OpenCode 使用 Responses
            协议，请选择站点支持的模型。关闭网关后恢复原有连接，OpenViking 知识库和记忆继续共用。
          </p>
          <div>
            <Button type="submit">保存设置</Button>
          </div>
        </fieldset>
        {notice ? (
          <p className="text-sm text-muted-foreground" role="status">
            {notice}
          </p>
        ) : null}
      </form>
    </SettingsSection>
  );
}

export function CcSwitchSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment ? (
        <GatewayForm key={environment.environmentId} environmentId={environment.environmentId} />
      ) : (
        <p className="text-sm text-muted-foreground">连接一个环境后即可管理 CC Switch 模型网关。</p>
      )}
    </SettingsPageContainer>
  );
}
