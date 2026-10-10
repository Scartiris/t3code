import {
  ccSwitchSites,
  CcSwitchError,
  CC_SWITCH_ENGINES,
  ccSwitchEngineSiteIds,
  type CcSwitchConfigureInput,
  type CcSwitchModelsInput,
  type CcSwitchSettings,
  type CcSwitchStatus,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ServerSettings from "../serverSettings.ts";
import * as CcSwitchGateway from "./CcSwitchGateway.ts";
import { defaultModel, routeThroughCcSwitch } from "./CcSwitchRouting.ts";
export { routeThroughCcSwitch } from "./CcSwitchRouting.ts";
const decodeModels = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);

export function ccSwitchBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid gateway URL");
  return url.href.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

export class CcSwitch extends Context.Service<
  CcSwitch,
  {
    readonly status: Effect.Effect<CcSwitchStatus, CcSwitchError>;
    readonly configure: (
      input: CcSwitchConfigureInput,
    ) => Effect.Effect<CcSwitchStatus, CcSwitchError>;
    readonly models: (
      input: CcSwitchModelsInput,
    ) => Effect.Effect<readonly string[], CcSwitchError>;
    readonly resolve: (
      settings: CcSwitchSettings,
      map: ProviderInstanceConfigMap,
    ) => Effect.Effect<ProviderInstanceConfigMap>;
  }
>()("t3/provider/CcSwitch") {}

const fail = (code: CcSwitchError["code"]) => new CcSwitchError({ code });
const siteModels = (settings: CcSwitchSettings, siteId: string) => {
  const site = ccSwitchSites(settings).find((entry) => entry.id === siteId);
  const model = (engine: (typeof CC_SWITCH_ENGINES)[number]) =>
    site && ccSwitchEngineSiteIds(settings, engine).includes(siteId)
      ? defaultModel(settings, site, engine)
      : "";
  return {
    claude: model(CC_SWITCH_ENGINES[0]),
    codex: model(CC_SWITCH_ENGINES[1]) || model(CC_SWITCH_ENGINES[2]),
  };
};
const selectedApps = (
  settings: CcSwitchSettings,
  siteId: string,
): readonly CcSwitchGateway.GatewayApp[] =>
  !settings.enabled
    ? []
    : [
        ...(ccSwitchEngineSiteIds(settings, CC_SWITCH_ENGINES[0]).includes(siteId)
          ? ["claude" as const]
          : []),
        ...(CC_SWITCH_ENGINES.slice(1).some((engine) =>
          ccSwitchEngineSiteIds(settings, engine).includes(siteId),
        )
          ? ["codex" as const]
          : []),
      ];

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const semaphore = yield* Semaphore.make(1);
  const forSite = yield* CcSwitchGateway.factory;
  const installation = forSite("default");
  const load = (settings: CcSwitchSettings) =>
    Effect.forEach(ccSwitchSites(settings), (site) =>
      Effect.gen(function* () {
        const gateway = forSite(site.id);
        const stored = yield* gateway.state;
        return { site, gateway, stored };
      }),
    );
  const inspect = (settings: CcSwitchSettings) =>
    Effect.gen(function* () {
      const version = yield* installation.version.pipe(Effect.option);
      const entries = yield* load(settings);
      const keyReady = (entry: (typeof entries)[number]) =>
        entry.stored.apiKey.length > 0 &&
        entry.stored.apiKey !== "PROXY_MANAGED" &&
        entry.stored.baseUrl === entry.site.baseUrl;
      let problem: CcSwitchStatus["problem"] = Option.isNone(version) ? "install" : null;
      if (settings.enabled) {
        if (
          CC_SWITCH_ENGINES.every(
            (engine) => ccSwitchEngineSiteIds(settings, engine).length === 0,
          ) ||
          CC_SWITCH_ENGINES.some((engine) =>
            ccSwitchEngineSiteIds(settings, engine).some((id) => {
              const site = entries.find((entry) => entry.site.id === id)?.site;
              return !site || !defaultModel(settings, site, engine);
            }),
          )
        )
          problem = "configuration";
        for (const entry of entries) {
          const apps = selectedApps(settings, entry.site.id);
          if (!apps.length) continue;
          const expected = CcSwitchGateway.profileId(
            entry.site,
            siteModels(settings, entry.site.id),
            entry.stored.apiKey,
          );
          const legacy =
            settings.sites === undefined && entry.site.id === "default"
              ? CcSwitchGateway.legacyProfileId(settings, entry.stored.apiKey)
              : "";
          if (
            !keyReady(entry) ||
            apps.some(
              (app) => entry.stored.ids[app] !== expected && entry.stored.ids[app] !== legacy,
            )
          )
            problem = "configuration";
        }
        if (problem === null) {
          const ready = yield* Effect.forEach(
            entries.filter((entry) => selectedApps(settings, entry.site.id).length > 0),
            (entry) => entry.gateway.setRoutes(selectedApps(settings, entry.site.id)),
          ).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!ready) problem = "gateway";
        }
      }
      return {
        installed: Option.isSome(version),
        version: Option.getOrNull(version),
        enabled: settings.enabled,
        apiKeyConfigured: entries.some(keyReady),
        sites: entries.map((entry) => ({ id: entry.site.id, apiKeyConfigured: keyReady(entry) })),
        state: settings.enabled ? (problem === null ? "ready" : "error") : "disabled",
        problem,
      } satisfies CcSwitchStatus;
    });
  const validateUrl = (value: string) =>
    Effect.try({ try: () => ccSwitchBaseUrl(value), catch: () => fail("configuration") });
  const fetchCatalog = (baseUrl: string, apiKey: string) =>
    Effect.gen(function* () {
      const response = yield* http
        .execute(
          HttpClientRequest.get(`${baseUrl}/v1/models`).pipe(HttpClientRequest.bearerToken(apiKey)),
        )
        .pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(() => fail("models")),
        );
      if ([401, 403].includes(response.status)) return yield* fail("unauthorized");
      if (response.status !== 200) return yield* fail("models");
      const body = yield* decodeModels(response).pipe(Effect.mapError(() => fail("models")));
      return [
        ...new Set(
          body.data
            .map((item) => item.id)
            .filter((id) => id.length > 0 && id.length <= 200 && !/\s/u.test(id)),
        ),
      ]
        .sort()
        .slice(0, 1000);
    });
  const configure = (input: CcSwitchConfigureInput) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const before = yield* settingsService.getSettings.pipe(
          Effect.mapError(() => fail("gateway")),
        );
        const sites = yield* Effect.forEach(ccSwitchSites(input.settings), (site) =>
          validateUrl(site.baseUrl).pipe(Effect.map((baseUrl) => ({ ...site, baseUrl }))),
        );
        const ids = sites.map((site) => site.id);
        const updates = input.clearKey
          ? []
          : [
              ...(input.siteKeys ?? []),
              ...(input.apiKey ? [{ siteId: "default", apiKey: input.apiKey }] : []),
            ];
        const keyUpdates = new Map(updates.map((item) => [item.siteId, item.apiKey]));
        const clear = new Set(input.clearKey ? ids : (input.clearSiteKeys ?? []));
        if (
          new Set(ids).size !== ids.length ||
          keyUpdates.size !== updates.length ||
          [...keyUpdates.keys(), ...clear].some((id) => !ids.includes(id))
        )
          return yield* fail("configuration");
        let next: CcSwitchSettings = {
          ...input.settings,
          sites,
          ...(input.settings.sites === undefined ? { baseUrl: sites[0]!.baseUrl } : {}),
          ...(input.clearKey ? { enabled: false } : {}),
        };
        for (const engine of CC_SWITCH_ENGINES) {
          const selected = ccSwitchEngineSiteIds(next, engine);
          // Settings patches merge nested objects; write the fallback selection
          // explicitly so an older client can replace previously saved arrays.
          next = { ...next, [engine.sitesField]: selected };
          if (
            new Set(selected).size !== selected.length ||
            (next.enabled && selected.some((id) => !ids.includes(id) || clear.has(id)))
          )
            return yield* fail("configuration");
          if (selected.length && !selected.includes(next[engine.siteField]))
            next = { ...next, [engine.siteField]: selected[0], [engine.modelField]: "" };
        }
        const entries = yield* load(next);
        let jobs = entries.map((entry) => ({
          ...entry,
          apiKey: clear.has(entry.site.id)
            ? ""
            : (keyUpdates.get(entry.site.id) ??
              (entry.stored.baseUrl === entry.site.baseUrl ? entry.stored.apiKey : "")),
        }));
        if (jobs.some((job) => selectedApps(next, job.site.id).length > 0 && !job.apiKey))
          return yield* fail("configuration");
        if (input.discoverModels) {
          jobs = yield* Effect.forEach(jobs, (job) =>
            Effect.gen(function* () {
              if (
                !job.apiKey ||
                (!keyUpdates.has(job.site.id) &&
                  job.site.models.length > 0 &&
                  job.stored.baseUrl === job.site.baseUrl)
              )
                return job;
              const models = yield* fetchCatalog(job.site.baseUrl, job.apiKey);
              if (models.length === 0) return yield* fail("models");
              return { ...job, site: { ...job.site, models } };
            }),
          );
          next = { ...next, sites: jobs.map((job) => job.site) };
          for (const engine of CC_SWITCH_ENGINES) {
            const selected = ccSwitchEngineSiteIds(next, engine);
            const primary = selected.includes(next[engine.siteField])
              ? next[engine.siteField]
              : selected[0];
            const site = next.sites!.find((entry) => entry.id === primary);
            if (site)
              next = {
                ...next,
                [engine.siteField]: site.id,
                [engine.modelField]:
                  next[engine.modelField] ||
                  defaultModel({ ...next, [engine.siteField]: site.id }, site, engine),
              };
          }
        }
        if (
          next.enabled &&
          (CC_SWITCH_ENGINES.every((engine) => ccSwitchEngineSiteIds(next, engine).length === 0) ||
            CC_SWITCH_ENGINES.some((engine) =>
              ccSwitchEngineSiteIds(next, engine).some((id) => {
                const site = jobs.find((job) => job.site.id === id)?.site;
                return !site || !defaultModel(next, site, engine);
              }),
            ))
        )
          return yield* fail("configuration");
        if (jobs.some((job) => job.apiKey)) yield* installation.version;
        const previous = yield* load(before.ccSwitch);
        const apply = Effect.gen(function* () {
          for (const job of jobs) {
            if (job.apiKey)
              yield* job.gateway.apply(job.site, siteModels(next, job.site.id), job.apiKey);
            yield* job.gateway.setRoutes(job.apiKey ? selectedApps(next, job.site.id) : []);
          }
          for (const entry of previous)
            if (!ids.includes(entry.site.id)) yield* entry.gateway.setRoutes([]);
          yield* settingsService
            .updateSettings({ ccSwitch: next })
            .pipe(Effect.mapError(() => fail("gateway")));
        });
        yield* apply.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              for (const job of jobs) {
                if (job.stored.rows.length > 0)
                  yield* job.gateway.restore(job.stored.ids).pipe(Effect.ignore);
                else yield* job.gateway.remove.pipe(Effect.ignore);
              }
              for (const entry of previous)
                yield* entry.gateway
                  .setRoutes(selectedApps(before.ccSwitch, entry.site.id))
                  .pipe(Effect.ignore);
              return yield* error;
            }),
          ),
        );
        // Credential deletion happens only after the settings commit, with other sites untouched.
        for (const job of jobs)
          if (clear.has(job.site.id) || (!job.apiKey && job.stored.apiKey))
            yield* job.gateway.remove;
        for (const entry of previous) if (!ids.includes(entry.site.id)) yield* entry.gateway.remove;
        return yield* inspect(next);
      }),
    );
  const models = (input: CcSwitchModelsInput) =>
    Effect.gen(function* () {
      const baseUrl = yield* validateUrl(input.baseUrl);
      const gateway = forSite(input.siteId ?? "default");
      const stored = yield* semaphore.withPermit(gateway.state);
      const apiKey = input.apiKey ?? (stored.baseUrl === baseUrl ? stored.apiKey : "");
      if (!apiKey) return yield* fail("configuration");
      return yield* fetchCatalog(baseUrl, apiKey);
    });
  return CcSwitch.of({
    configure,
    models,
    status: semaphore.withPermit(
      settingsService.getSettings.pipe(
        Effect.mapError(() => fail("gateway")),
        Effect.flatMap((settings) => inspect(settings.ccSwitch)),
      ),
    ),
    resolve: (settings, map) =>
      semaphore
        .withPermit(
          Effect.gen(function* () {
            if (!settings.enabled) return map;
            const status = yield* inspect(settings);
            const entries = yield* load(settings);
            return routeThroughCcSwitch(
              map,
              settings,
              Object.fromEntries(entries.map((entry) => [entry.site.id, entry.gateway.paths])),
              entries
                .map(
                  (entry) =>
                    `${entry.site.id}:${entry.stored.ids.claude}:${entry.stored.ids.codex}`,
                )
                .join("|"),
              status.state === "ready",
            );
          }),
        )
        .pipe(
          Effect.orElseSucceed(() =>
            routeThroughCcSwitch(map, settings, installation.paths, "", false),
          ),
        ),
  });
});

export const layer = Layer.effect(CcSwitch, make);
