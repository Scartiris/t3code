import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const ModelId = TrimmedString.check(Schema.isMaxLength(200), Schema.isPattern(/^[^\s]*$/u));
const SiteId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u));
export const CcSwitchSite = Schema.Struct({
  id: SiteId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  baseUrl: TrimmedNonEmptyString,
  models: Schema.Array(ModelId.check(Schema.isMinLength(1))).check(Schema.isMaxLength(1000)),
});
export type CcSwitchSite = typeof CcSwitchSite.Type;
export const CcSwitchSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  baseUrl: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("https://www.packyapi.ai")),
  ),
  claudeModel: ModelId.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  codexModel: ModelId.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  openCodeModel: ModelId.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  models: Schema.Array(TrimmedNonEmptyString)
    .check(Schema.isMaxLength(1000))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // Absent in the original single-site settings; an explicit empty list removes all sites.
  sites: Schema.optionalKey(Schema.Array(CcSwitchSite).check(Schema.isMaxLength(20))),
  claudeSiteId: SiteId.pipe(Schema.withDecodingDefault(Effect.succeed("default"))),
  codexSiteId: SiteId.pipe(Schema.withDecodingDefault(Effect.succeed("default"))),
  openCodeSiteId: SiteId.pipe(Schema.withDecodingDefault(Effect.succeed("default"))),
  claudeSiteIds: Schema.optionalKey(Schema.Array(SiteId).check(Schema.isMaxLength(20))),
  codexSiteIds: Schema.optionalKey(Schema.Array(SiteId).check(Schema.isMaxLength(20))),
  openCodeSiteIds: Schema.optionalKey(Schema.Array(SiteId).check(Schema.isMaxLength(20))),
});
export type CcSwitchSettings = typeof CcSwitchSettings.Type;

export function ccSwitchSites(settings: CcSwitchSettings): readonly CcSwitchSite[] {
  return (
    settings.sites ?? [
      { id: "default", name: "PackyAPI", baseUrl: settings.baseUrl, models: settings.models },
    ]
  );
}

export const CC_SWITCH_ENGINES = [
  {
    driver: "claudeAgent",
    name: "Claude Code",
    siteField: "claudeSiteId",
    sitesField: "claudeSiteIds",
    modelField: "claudeModel",
  },
  {
    driver: "codex",
    name: "Codex",
    siteField: "codexSiteId",
    sitesField: "codexSiteIds",
    modelField: "codexModel",
  },
  {
    driver: "opencode",
    name: "OpenCode",
    siteField: "openCodeSiteId",
    sitesField: "openCodeSiteIds",
    modelField: "openCodeModel",
  },
] as const;
export type CcSwitchEngine = (typeof CC_SWITCH_ENGINES)[number];

export function ccSwitchEngineSiteIds(
  settings: CcSwitchSettings,
  engine: CcSwitchEngine,
): readonly string[] {
  return settings[engine.sitesField] ?? [settings[engine.siteField]];
}

export function ccSwitchEngineModels(
  site: CcSwitchSite,
  engine: CcSwitchEngine,
): readonly string[] {
  const preferred = site.models.filter((model) =>
    engine.driver === "claudeAgent"
      ? /claude/iu.test(model)
      : engine.driver === "codex"
        ? /^(gpt-|o[1-9])/iu.test(model)
        : true,
  );
  // Some gateways use custom model aliases; their protocol support cannot be inferred from the name.
  return preferred.length ? preferred : site.models;
}

// The credential is an operation input, never part of T3's settings snapshot.
export const CcSwitchConfigureInput = Schema.Struct({
  settings: CcSwitchSettings,
  apiKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
  clearKey: Schema.optionalKey(Schema.Boolean),
  siteKeys: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        siteId: SiteId,
        apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
      }),
    ).check(Schema.isMaxLength(20)),
  ),
  clearSiteKeys: Schema.optionalKey(Schema.Array(SiteId).check(Schema.isMaxLength(20))),
  discoverModels: Schema.optionalKey(Schema.Boolean),
});
export type CcSwitchConfigureInput = typeof CcSwitchConfigureInput.Type;
export const CcSwitchModelsInput = Schema.Struct({
  baseUrl: TrimmedNonEmptyString,
  apiKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
  siteId: Schema.optionalKey(SiteId),
});
export type CcSwitchModelsInput = typeof CcSwitchModelsInput.Type;

export const CcSwitchStatus = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  apiKeyConfigured: Schema.Boolean,
  state: Schema.Literals(["disabled", "ready", "error"]),
  problem: Schema.NullOr(Schema.Literals(["install", "configuration", "gateway"])),
  sites: Schema.Array(Schema.Struct({ id: SiteId, apiKeyConfigured: Schema.Boolean })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type CcSwitchStatus = typeof CcSwitchStatus.Type;
export class CcSwitchError extends Schema.TaggedError<CcSwitchError>()("CcSwitchError", {
  code: Schema.Literals(["install", "configuration", "gateway", "unauthorized", "models"]),
}) {
  override get message(): string {
    return {
      install: "服务器需要安装 CC Switch CLI，且代理功能需要 Linux 或 macOS。",
      configuration: "请检查站点地址和 Key，并为启用的引擎选择有效的站点与模型。",
      gateway: "CC Switch 网关未就绪，请检查服务器上的 CC Switch 服务。",
      unauthorized: "站点未接受这个 API Key，请检查密钥和账户额度。",
      models: "无法获取模型列表，请检查服务地址和 API Key。",
    }[this.code];
  }
}
