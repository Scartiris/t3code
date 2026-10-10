import * as Schema from "effect/Schema";
import {
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  type ProviderInstanceEnvironment,
  type CcSwitchSettings,
  type CcSwitchSite,
  type CcSwitchEngine,
  ClaudeSettings,
  CodexSettings,
  OpenCodeSettings,
  CC_SWITCH_ENGINES,
  ccSwitchSites,
  ccSwitchEngineSiteIds,
  ccSwitchEngineModels,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export interface GatewayPaths {
  readonly claudeHome: string;
  readonly codexHome: string;
  readonly claudeUrl: string;
  readonly codexUrl: string;
}
const PLACEHOLDER = "PROXY_MANAGED";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeOpenCodeSettings = Schema.decodeUnknownOption(OpenCodeSettings);
const isCommonPaths = (
  paths: GatewayPaths | Readonly<Record<string, GatewayPaths>>,
): paths is GatewayPaths => typeof paths.claudeHome === "string";

export function defaultModel(
  settings: CcSwitchSettings,
  site: CcSwitchSite,
  engine: CcSwitchEngine,
) {
  const models = ccSwitchEngineModels(site, engine);
  return (
    (settings[engine.siteField] === site.id ? settings[engine.modelField] : "") ||
    (engine.driver === "opencode"
      ? models.find((model) => /^(gpt-|o[1-9])/iu.test(model))
      : undefined) ||
    models[0] ||
    ""
  );
}
function gatewayEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  values: Readonly<Record<string, string>>,
): ProviderInstanceEnvironment {
  return [
    ...(environment ?? []).filter((entry) => !(entry.name in values)),
    ...Object.entries(values).map(([name, value]) => ({ name, value, sensitive: false })),
  ];
}

/** Site instances share the engine's launch settings, but have isolated routes and catalogs. */
export function routeThroughCcSwitch(
  map: ProviderInstanceConfigMap,
  settings: CcSwitchSettings,
  paths: GatewayPaths | Readonly<Record<string, GatewayPaths>>,
  revision: string,
  ready: boolean,
): ProviderInstanceConfigMap {
  if (!settings.enabled) return map;
  const next = { ...map };
  const sites = ccSwitchSites(settings);
  for (const engine of CC_SWITCH_ENGINES) {
    const baseId = ProviderInstanceId.make(engine.driver);
    const instance = map[baseId];
    if (!instance || instance.driver !== engine.driver) continue;
    next[baseId] = { ...instance, enabled: false };
    for (const siteId of ccSwitchEngineSiteIds(settings, engine)) {
      const site = sites.find((entry) => entry.id === siteId);
      if (!site) continue;
      // The original routing IDs keep existing threads and project defaults usable.
      const instanceId =
        siteId === settings[engine.siteField]
          ? baseId
          : ProviderInstanceId.make(`cc-switch-${engine.driver}-${siteId}`);
      const enginePaths = isCommonPaths(paths) ? paths : (paths[siteId] ?? paths[engine.driver]);
      if (!enginePaths) continue;
      const chosen = defaultModel(settings, site, engine);
      const available = [...new Set([chosen, ...ccSwitchEngineModels(site, engine)])].filter(
        Boolean,
      );
      const catalog = (selected: string, models: readonly string[]) => ({
        T3CODE_CC_SWITCH_MODELS: encodeJson({ selected, models }),
      });
      const marker = { T3CODE_CC_SWITCH_REVISION: revision, T3CODE_CC_SWITCH_SITE: site.id };
      const base = {
        ...instance,
        displayName: `${engine.name} · ${site.name}`,
        enabled: ready && instance.enabled !== false,
      };
      if (engine.driver === "claudeAgent") {
        const config = decodeClaudeSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        next[instanceId] = {
          ...base,
          enabled: base.enabled && config.value.enabled !== false,
          config: { ...config.value, homePath: enginePaths.claudeHome, customModels: available },
          environment: gatewayEnvironment(instance.environment, {
            ...marker,
            ...catalog(chosen, available),
            ANTHROPIC_BASE_URL: enginePaths.claudeUrl,
            ANTHROPIC_AUTH_TOKEN: PLACEHOLDER,
            ANTHROPIC_API_KEY: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
          }),
        };
      } else if (engine.driver === "codex") {
        const config = decodeCodexSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        next[instanceId] = {
          ...base,
          enabled: base.enabled && config.value.enabled !== false,
          config: {
            ...config.value,
            setupMode: "existing",
            homePath: enginePaths.codexHome,
            shadowHomePath: "",
            customModels: available,
          },
          environment: gatewayEnvironment(instance.environment, {
            ...marker,
            ...catalog(chosen, available),
            OPENAI_API_KEY: "",
          }),
        };
      } else {
        const config = decodeOpenCodeSettings(instance.config ?? {});
        if (Option.isNone(config)) continue;
        const provider = {
          npm: "@ai-sdk/openai",
          name: site.name,
          options: { baseURL: `${enginePaths.codexUrl}/codex/v1`, apiKey: PLACEHOLDER },
          models: Object.fromEntries(available.map((model) => [model, { name: model }])),
        };
        next[instanceId] = {
          ...base,
          enabled: base.enabled && config.value.enabled !== false,
          config: {
            ...config.value,
            serverUrl: "",
            serverPassword: "",
            customModels: available.map((model) => `cc-switch/${model}`),
          },
          environment: gatewayEnvironment(instance.environment, {
            ...marker,
            ...catalog(
              `cc-switch/${chosen}`,
              available.map((model) => `cc-switch/${model}`),
            ),
            OPENCODE_CONFIG_CONTENT: encodeJson({
              enabled_providers: ["cc-switch"],
              provider: { "cc-switch": provider },
              model: `cc-switch/${chosen}`,
            }),
          }),
        };
      }
    }
  }
  return next;
}
