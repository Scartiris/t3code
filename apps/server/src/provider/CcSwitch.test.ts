import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CcSwitchSettings,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeSqlite from "node:sqlite";
import { HostProcessPlatform, HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CcSwitch from "./CcSwitch.ts";
import * as CcSwitchGateway from "./CcSwitchGateway.ts";

const decodeMap = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
const settings = Schema.decodeUnknownSync(CcSwitchSettings)({
  enabled: true,
  claudeModel: "claude-smoke",
  codexModel: "gpt-smoke",
  openCodeModel: "gpt-smoke",
  models: ["claude-smoke", "gpt-smoke"],
});
const paths = {
  claudeHome: "/isolated/claude",
  codexHome: "/isolated/codex",
  claudeUrl: "http://127.0.0.1:15721",
  codexUrl: "http://127.0.0.1:15722",
};
const key = (id: string) => ProviderInstanceId.make(id);
const map = decodeMap({
  claudeAgent: {
    driver: "claudeAgent",
    enabled: true,
    config: { homePath: "/original/claude" },
    environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "old-key", sensitive: true }],
  },
  codex: { driver: "codex", enabled: true, config: { homePath: "/original/codex" } },
  opencode: { driver: "opencode", enabled: true, config: { enabled: true } },
  personal: { driver: "codex", enabled: true, config: { homePath: "/personal" } },
  cursor: { driver: "cursor", enabled: false, config: {} },
});
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePorts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ claude: Schema.Number, codex: Schema.Number })),
);

describe("CC Switch routing", () => {
  it("routes all three engines through loopback without an upstream credential in their runtime configuration", () => {
    const result = CcSwitch.routeThroughCcSwitch(map, settings, paths, "revision", true);
    const env = (id: string) =>
      Object.fromEntries(result[key(id)]!.environment!.map((entry) => [entry.name, entry.value]));
    assert.equal(env("claudeAgent").ANTHROPIC_BASE_URL, paths.claudeUrl);
    assert.equal(env("claudeAgent").ANTHROPIC_AUTH_TOKEN, "PROXY_MANAGED");
    assert.equal(env("codex").OPENAI_API_KEY, "");
    assert.include(env("opencode").OPENCODE_CONFIG_CONTENT!, `${paths.codexUrl}/codex/v1`);
    assert.include(env("opencode").OPENCODE_CONFIG_CONTENT!, "cc-switch/gpt-smoke");
    assert.notInclude(encode(result), "old-key");
    assert.notInclude(encode(result), "packyapi.ai");
    assert.strictEqual(result[key("personal")], map[key("personal")]);
    assert.strictEqual(result[key("cursor")], map[key("cursor")]);
  });
  it("restores the original provider map when switched off and never revives disabled engines", () => {
    assert.strictEqual(
      CcSwitch.routeThroughCcSwitch(map, { ...settings, enabled: false }, paths, "", false),
      map,
    );
    const disabled = decodeMap({
      codex: { driver: "codex", enabled: false, config: {} },
      opencode: { driver: "opencode", config: { enabled: false } },
    });
    const result = CcSwitch.routeThroughCcSwitch(disabled, settings, paths, "", true);
    assert.isFalse(result[key("codex")]!.enabled);
    assert.isFalse(result[key("opencode")]!.enabled);
    assert.include(encode(result[key("opencode")]!.config), '"enabled":false');
  });
  it("makes configured engines unavailable when the gateway fails instead of silently using another credential", () => {
    const result = CcSwitch.routeThroughCcSwitch(map, settings, paths, "", false);
    for (const id of ["claudeAgent", "codex", "opencode"]) assert.isFalse(result[key(id)]!.enabled);
    assert.strictEqual(result[key("personal")], map[key("personal")]);
  });
  it("normalizes protocol paths and rejects malformed destinations", () => {
    assert.equal(
      CcSwitch.ccSwitchBaseUrl("https://www.packyapi.ai/v1/"),
      "https://www.packyapi.ai",
    );
    for (const url of [
      "file:///tmp/key",
      "https://user:key@example.com",
      "https://example.com?key=x",
      "https://example.com#key",
    ])
      assert.throws(() => CcSwitch.ccSwitchBaseUrl(url));
  });
});

const upstreamKey = "only-cc-switch-stores-this-key";
function seedDatabase(dbPath: string) {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE providers (id TEXT, app_type TEXT, settings_config TEXT, is_current INTEGER)",
    );
    db.prepare("INSERT INTO providers VALUES (?, ?, ?, ?)").run(
      "t3-test",
      "claude",
      encode({
        env: { ANTHROPIC_BASE_URL: "https://www.packyapi.ai", ANTHROPIC_AUTH_TOKEN: upstreamKey },
      }),
      1,
    );
  } finally {
    db.close();
  }
}
const dependencies = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-cc-switch-test-" }),
  ServerSettings.layerTest(),
  Layer.succeed(ProcessRunner.ProcessRunner, {
    run: () => Effect.die("This test must not spawn a CLI"),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      assert.equal(request.headers.authorization, `Bearer ${upstreamKey}`);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("{}", { status: 401 })),
      );
    }),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));
const testLayer = CcSwitch.layer.pipe(Layer.provideMerge(dependencies));
const seed = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const directory = path.join(stateDir, "cc-switch", ".cc-switch");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* Effect.sync(() => seedDatabase(path.join(directory, "cc-switch.db")));
});

const configureConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cc-switch-configure-",
});
class GatewayTestState extends Context.Service<
  GatewayTestState,
  {
    failedSite: string | null;
    wrongWorker: boolean;
    routes: Map<string, Set<string>>;
    runtimePaths: Map<string, string>;
    requests: { url: string; authorization: string | undefined }[];
    modelsStatus: number;
    emptyCatalog: boolean;
  }
>()("t3/provider/CcSwitch.test/GatewayTestState") {}
const gatewayTestState = Layer.sync(GatewayTestState, () => ({
  failedSite: null,
  wrongWorker: false,
  routes: new Map(),
  runtimePaths: new Map(),
  requests: [],
  modelsStatus: 200,
  emptyCatalog: false,
}));
const configureDependencies = Layer.mergeAll(
  configureConfig,
  gatewayTestState,
  ServerSettings.layerTest(),
  Layer.succeed(HostProcessPlatform, "linux"),
  Layer.succeed(HostProcessEnvironment, {
    XDG_STATE_HOME: "/inherited-state",
    XDG_RUNTIME_DIR: "/inherited-runtime",
  }),
  Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const controls = yield* GatewayTestState;
      return ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            const args = input.args ?? [];
            const directory = input.env!.CC_SWITCH_CONFIG_DIR!;
            const root = path.dirname(directory);
            const siteId = path.basename(root) === "cc-switch" ? "default" : path.basename(root);
            const dbPath = path.join(directory, "cc-switch.db");
            assert.notEqual(input.env!.XDG_RUNTIME_DIR, "/inherited-runtime");
            assert.equal(input.env!.XDG_STATE_HOME, path.join(root, ".state"));
            controls.runtimePaths.set(siteId, input.env!.XDG_RUNTIME_DIR!);
            const routes = controls.routes.get(siteId) ?? new Set<string>();
            controls.routes.set(siteId, routes);
            let stdout = args.includes("--version") ? "cc-switch 5.11.0" : "";
            let code = 0;
            if (args.includes("enable")) {
              if (controls.failedSite === siteId) code = 1;
              else routes.add(args[args.indexOf("--app") + 1]!);
            } else if (args.includes("disable")) {
              routes.delete(args[args.indexOf("--app") + 1]!);
            } else if (args.includes("status")) {
              if (routes.size === 0) stdout = "daemon not reachable: disconnected";
              else {
                const ports = yield* decodePorts(
                  yield* fs.readFileString(path.join(root, "ports.json")),
                );
                stdout = [...routes]
                  .map(
                    (app) =>
                      `worker[${app}]: 127.0.0.1:${ports[app as "claude" | "codex"] + (controls.wrongWorker ? 10 : 0)} (pid 123)`,
                  )
                  .join("\n");
              }
            } else if (args.includes("stop") && routes.size === 0) {
              code = 1;
            }
            if (args.includes("add")) {
              const file = args[args.indexOf("--config-file") + 1]!;
              const contents = yield* fs.readFileString(file);
              const app = args[args.indexOf("--app") + 1]!;
              const id = args[args.indexOf("--id") + 1]!;
              // CC Switch requires Codex's auth object even with a TOML bearer token.
              if (app === "codex") assert.include(contents, '"auth":{"OPENAI_API_KEY":');
              yield* Effect.sync(() => {
                const db = new NodeSqlite.DatabaseSync(dbPath);
                try {
                  db.prepare("INSERT INTO providers VALUES (?, ?, ?, 0)").run(id, app, contents);
                } finally {
                  db.close();
                }
              });
            } else if (args.includes("switch")) {
              const app = args[args.indexOf("--app") + 1]!;
              const id = args.at(-1)!;
              yield* Effect.sync(() => {
                const db = new NodeSqlite.DatabaseSync(dbPath);
                try {
                  db.prepare("UPDATE providers SET is_current = (id = ?) WHERE app_type = ?").run(
                    id,
                    app,
                  );
                } finally {
                  db.close();
                }
              });
            } else if (args.includes("config") && !(yield* fs.exists(dbPath))) {
              yield* fs.makeDirectory(directory, { recursive: true });
              yield* Effect.sync(() => {
                const db = new NodeSqlite.DatabaseSync(dbPath);
                try {
                  db.exec(
                    "CREATE TABLE providers (id TEXT, app_type TEXT, settings_config TEXT, is_current INTEGER)",
                  );
                } finally {
                  db.close();
                }
              });
            }
            return {
              stdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(code),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      });
    }),
  ).pipe(Layer.provide(gatewayTestState)),
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const controls = yield* GatewayTestState;
      return HttpClient.make((request) => {
        if (request.url.endsWith("/v1/models"))
          controls.requests.push({
            url: request.url,
            authorization: request.headers.authorization,
          });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              request.url.endsWith("/v1/models")
                ? controls.emptyCatalog
                  ? '{"data":[]}'
                  : '{"data":[{"id":"gpt-smoke"},{"id":"claude-smoke"}]}'
                : "{}",
              { status: request.url.endsWith("/v1/models") ? controls.modelsStatus : 200 },
            ),
          ),
        );
      });
    }),
  ).pipe(Layer.provide(gatewayTestState)),
).pipe(Layer.provideMerge(NodeServices.layer));

const configureLayer = CcSwitch.layer.pipe(Layer.provideMerge(configureDependencies));
const multiSettings = Schema.decodeUnknownSync(CcSwitchSettings)({
  ...settings,
  sites: [
    { id: "default", name: "PackyAPI", baseUrl: settings.baseUrl, models: settings.models },
    { id: "second", name: "Second", baseUrl: "https://second.test", models: settings.models },
    {
      id: "third",
      name: "Third",
      baseUrl: "https://third.test",
      models: [...settings.models, "third-only"],
    },
    { id: "draft", name: "Draft", baseUrl: "https://draft.test", models: [] },
  ],
  claudeSiteId: "default",
  codexSiteId: "second",
  openCodeSiteId: "third",
});
const siteKeys = [
  { siteId: "default", apiKey: upstreamKey },
  { siteId: "second", apiKey: "second-site-key" },
  { siteId: "third", apiKey: "third-site-key" },
];

describe("CC Switch credential ownership", () => {
  it.effect(
    "discovers models on save and exposes each selected engine/site with an isolated catalog and route",
    () =>
      Effect.gen(function* () {
        const service = yield* CcSwitch.CcSwitch;
        const saved = yield* ServerSettings.ServerSettingsService;
        const controls = yield* GatewayTestState;
        const forSite = yield* CcSwitchGateway.factory;
        const multiple = {
          ...multiSettings,
          sites: multiSettings.sites!.slice(0, 3).map((site) => ({ ...site, models: [] })),
          claudeSiteIds: ["default", "second", "third"],
          codexSiteIds: ["default", "second", "third"],
          openCodeSiteIds: ["default", "second", "third"],
          claudeModel: "",
          codexModel: "",
          openCodeModel: "",
        };
        assert.equal(
          (yield* service.configure({ settings: multiple, siteKeys, discoverModels: true })).state,
          "ready",
        );
        const configured = (yield* saved.getSettings).ccSwitch;
        assert.equal(configured.claudeModel, "claude-smoke");
        assert.equal(configured.codexModel, "gpt-smoke");
        assert.equal(configured.openCodeModel, "gpt-smoke");
        assert.equal(controls.requests.length, 3);
        const routed = yield* service.resolve(configured, map);
        for (const engine of [
          { driver: "claudeAgent", primary: "default" },
          { driver: "codex", primary: "second" },
          { driver: "opencode", primary: "third" },
        ]) {
          for (const siteId of ["default", "second", "third"]) {
            const id =
              siteId === engine.primary ? engine.driver : `cc-switch-${engine.driver}-${siteId}`;
            const instance = routed[key(id)]!;
            assert.isTrue(instance.enabled);
            assert.include(
              instance.displayName!,
              siteId === "default" ? "PackyAPI" : siteId === "second" ? "Second" : "Third",
            );
            const env = Object.fromEntries(
              instance.environment!.map((entry) => [entry.name, entry.value]),
            );
            assert.equal(env.T3CODE_CC_SWITCH_SITE, siteId);
            assert.include(
              encode(instance),
              engine.driver === "claudeAgent"
                ? forSite(siteId).paths.claudeUrl
                : engine.driver === "codex"
                  ? encode(forSite(siteId).paths.codexHome)
                  : `${forSite(siteId).paths.codexUrl}/codex/v1`,
            );
            for (const credential of siteKeys)
              assert.notInclude(encode(instance), credential.apiKey);
          }
        }
        yield* service.configure({ settings: { ...configured, codexSiteIds: [] } });
        const disabled = yield* service.resolve((yield* saved.getSettings).ccSwitch, map);
        assert.isFalse(disabled[key("codex")]!.enabled);
        assert.isUndefined(disabled[key("cc-switch-codex-default")]);
        assert.isTrue(disabled[key("cc-switch-claudeAgent-third")]!.enabled);
        yield* service.configure({ settings: multiSettings });
        const restored = (yield* saved.getSettings).ccSwitch;
        assert.deepEqual(restored.claudeSiteIds, ["default"]);
        assert.deepEqual(restored.codexSiteIds, ["second"]);
        assert.deepEqual(restored.openCodeSiteIds, ["third"]);
        assert.equal((yield* service.status).state, "ready");
      }).pipe(Effect.provide(configureLayer)),
  );
  it.effect(
    "leaves saved credentials and routes unchanged when automatic model discovery is rejected or returns an empty catalog",
    () =>
      Effect.gen(function* () {
        const service = yield* CcSwitch.CcSwitch;
        const saved = yield* ServerSettings.ServerSettingsService;
        const controls = yield* GatewayTestState;
        const forSite = yield* CcSwitchGateway.factory;
        yield* service.configure({ settings, apiKey: upstreamKey });
        const before = yield* saved.getSettings;
        const stored = yield* forSite("default").state;
        for (const outcome of [
          { status: 401, empty: false, code: "unauthorized" },
          { status: 200, empty: true, code: "models" },
        ]) {
          controls.modelsStatus = outcome.status;
          controls.emptyCatalog = outcome.empty;
          const error = yield* service
            .configure({ settings: multiSettings, siteKeys, discoverModels: true })
            .pipe(Effect.flip);
          assert.equal(error.code, outcome.code);
          assert.deepEqual(yield* saved.getSettings, before);
          assert.deepEqual((yield* forSite("default").state).ids, stored.ids);
          assert.equal((yield* forSite("second").state).apiKey, "");
          assert.deepEqual([...controls.routes.get("default")!], ["claude", "codex"]);
        }
      }).pipe(Effect.provide(configureLayer)),
  );
  it.effect(
    "keeps three simultaneous sites, identical model IDs, and credential rotation isolated",
    () =>
      Effect.gen(function* () {
        const service = yield* CcSwitch.CcSwitch;
        const controls = yield* GatewayTestState;
        const forSite = yield* CcSwitchGateway.factory;
        const savedSettings = yield* ServerSettings.ServerSettingsService;
        const status = yield* service.configure({ settings: multiSettings, siteKeys });
        assert.equal(status.state, "ready");
        assert.deepEqual(status.sites, [
          { id: "default", apiKeyConfigured: true },
          { id: "second", apiKeyConfigured: true },
          { id: "third", apiKeyConfigured: true },
          { id: "draft", apiKeyConfigured: false },
        ]);
        assert.deepEqual([...controls.routes.get("default")!], ["claude"]);
        assert.deepEqual([...controls.routes.get("second")!], ["codex"]);
        assert.deepEqual([...controls.routes.get("third")!], ["codex"]);
        assert.equal(
          new Set(["default", "second", "third"].map((id) => controls.runtimePaths.get(id))).size,
          3,
        );
        const routed = yield* service.resolve(multiSettings, map);
        assert.include(
          encode(routed[key("claudeAgent")]!.config),
          encode(forSite("default").paths.claudeHome),
        );
        assert.include(
          encode(routed[key("codex")]!.config),
          encode(forSite("second").paths.codexHome),
        );
        assert.include(
          encode(routed[key("opencode")]),
          `${forSite("third").paths.codexUrl}/codex/v1`,
        );
        assert.include(encode(routed[key("opencode")]), "cc-switch/third-only");
        assert.notInclude(encode(routed[key("codex")]), "third-only");
        for (const site of multiSettings.sites!) {
          if (site.id === "draft") continue;
          assert.deepEqual(
            yield* service.models({ siteId: site.id, baseUrl: site.baseUrl }),
            [...settings.models].sort(),
          );
        }
        assert.deepEqual(
          controls.requests.map((r) => r.authorization),
          siteKeys.map((item) => `Bearer ${item.apiKey}`),
        );
        const beforeDefault = yield* forSite("default").state;
        const beforeThird = yield* forSite("third").state;
        yield* service.configure({
          settings: multiSettings,
          siteKeys: [{ siteId: "second", apiKey: "second-rotated-key" }],
        });
        assert.deepEqual((yield* forSite("default").state).ids, beforeDefault.ids);
        assert.deepEqual((yield* forSite("third").state).ids, beforeThird.ids);
        assert.equal((yield* forSite("second").state).apiKey, "second-rotated-key");
        const encodedSettings = encode(yield* savedSettings.getSettings);
        for (const item of siteKeys) assert.notInclude(encodedSettings, item.apiKey);
        assert.notInclude(encodedSettings, "second-rotated-key");
        const moved = { ...multiSettings, codexSiteId: "third" };
        yield* service.configure({ settings: moved });
        assert.equal(controls.routes.get("second")!.size, 0);
        assert.include(
          encode((yield* service.resolve(moved, map))[key("codex")]!.config),
          encode(forSite("third").paths.codexHome),
        );
      }).pipe(Effect.provide(configureLayer)),
  );
  it.effect(
    "removes the original site and individual Keys without deleting other sites, and preserves an empty site list",
    () =>
      Effect.gen(function* () {
        const service = yield* CcSwitch.CcSwitch;
        const forSite = yield* CcSwitchGateway.factory;
        const fs = yield* FileSystem.FileSystem;
        const saved = yield* ServerSettings.ServerSettingsService;
        yield* service.configure({ settings: multiSettings, siteKeys });
        const remaining = {
          ...multiSettings,
          claudeSiteId: "third",
          sites: multiSettings.sites!.filter((site) => site.id !== "default"),
        };
        assert.equal((yield* service.configure({ settings: remaining })).state, "ready");
        assert.equal((yield* forSite("default").state).apiKey, "");
        assert.isFalse(yield* fs.exists(forSite("default").paths.codexHome));
        assert.equal((yield* forSite("second").state).apiKey, "second-site-key");
        assert.equal((yield* forSite("third").state).apiKey, "third-site-key");
        const switched = { ...remaining, codexSiteId: "third" };
        const cleared = yield* service.configure({ settings: switched, clearSiteKeys: ["second"] });
        assert.equal(cleared.state, "ready");
        assert.isFalse(cleared.sites.find((site) => site.id === "second")!.apiKeyConfigured);
        assert.equal((yield* forSite("third").state).apiKey, "third-site-key");
        const blocked = yield* service
          .configure({ settings: switched, clearSiteKeys: ["third"] })
          .pipe(Effect.flip);
        assert.equal(blocked.code, "configuration");
        yield* service.configure({
          settings: { ...switched, enabled: false },
          clearSiteKeys: ["third"],
        });
        assert.equal((yield* forSite("third").state).apiKey, "");
        yield* service.configure({ settings: { ...switched, sites: [], enabled: false } });
        assert.deepEqual((yield* saved.getSettings).ccSwitch.sites, []);
        assert.deepEqual((yield* service.status).sites, []);
      }).pipe(Effect.provide(configureLayer)),
  );
  it.effect(
    "rejects changed URLs, missing selections, duplicate sites and credentials before changing a saved route",
    () =>
      Effect.gen(function* () {
        const service = yield* CcSwitch.CcSwitch;
        const forSite = yield* CcSwitchGateway.factory;
        const saved = yield* ServerSettings.ServerSettingsService;
        yield* service.configure({ settings: multiSettings, siteKeys });
        const before = yield* saved.getSettings;
        const stored = yield* forSite("second").state;
        const changed = {
          ...multiSettings,
          sites: multiSettings.sites!.map((site) =>
            site.id === "second" ? { ...site, baseUrl: "https://new.test" } : site,
          ),
        };
        for (const input of [
          { settings: changed },
          { settings: { ...multiSettings, codexSiteId: "missing" } },
          {
            settings: {
              ...multiSettings,
              sites: [...multiSettings.sites!, multiSettings.sites![0]!],
            },
          },
          { settings: multiSettings, siteKeys: [siteKeys[0]!, siteKeys[0]!] },
        ]) {
          assert.equal((yield* service.configure(input).pipe(Effect.flip)).code, "configuration");
        }
        assert.equal(
          (yield* service
            .models({ siteId: "second", baseUrl: "https://new.test" })
            .pipe(Effect.flip)).code,
          "configuration",
        );
        assert.equal(
          (yield* service
            .models({ siteId: "draft", baseUrl: "https://draft.test" })
            .pipe(Effect.flip)).code,
          "configuration",
        );
        assert.deepEqual(yield* saved.getSettings, before);
        assert.deepEqual((yield* forSite("second").state).ids, stored.ids);
      }).pipe(Effect.provide(configureLayer)),
  );
  it.effect(
    "restores earlier credentials and running routes when a later site's native gateway fails",
    () =>
      Effect.gen(function* () {
        const service = yield* CcSwitch.CcSwitch;
        const saved = yield* ServerSettings.ServerSettingsService;
        const controls = yield* GatewayTestState;
        const forSite = yield* CcSwitchGateway.factory;
        yield* service.configure({ settings, apiKey: upstreamKey });
        const before = yield* saved.getSettings;
        const stored = yield* forSite("default").state;
        controls.failedSite = "second";
        assert.equal(
          (yield* service
            .configure({
              settings: multiSettings,
              siteKeys: [{ siteId: "default", apiKey: "temporary-new-key" }, ...siteKeys.slice(1)],
            })
            .pipe(Effect.flip)).code,
          "gateway",
        );
        assert.deepEqual(yield* saved.getSettings, before);
        assert.deepEqual((yield* forSite("default").state).ids, stored.ids);
        assert.equal((yield* forSite("default").state).apiKey, upstreamKey);
        assert.equal((yield* forSite("second").state).apiKey, "");
        assert.deepEqual([...controls.routes.get("default")!], ["claude", "codex"]);
        assert.equal((yield* service.status).state, "ready");
      }).pipe(Effect.provide(configureLayer)),
  );
  it.effect("refuses a healthy port belonging to the wrong CC Switch worker", () =>
    Effect.gen(function* () {
      const service = yield* CcSwitch.CcSwitch;
      const controls = yield* GatewayTestState;
      yield* service.configure({ settings: multiSettings, siteKeys });
      controls.wrongWorker = true;
      assert.equal((yield* service.status).problem, "gateway");
      const unavailable = yield* service.resolve(multiSettings, map);
      for (const id of ["claudeAgent", "codex", "opencode"])
        assert.isFalse(unavailable[key(id)]!.enabled);
      controls.wrongWorker = false;
      assert.equal((yield* service.status).state, "ready");
    }).pipe(Effect.provide(configureLayer)),
  );
  it.effect(
    "saves both CC Switch profiles, rotates their shared Key, rejects bypassed settings, and restores connections on disable",
    () =>
      Effect.gen(function* () {
        const service = yield* CcSwitch.CcSwitch;
        const savedSettings = yield* ServerSettings.ServerSettingsService;
        const original = yield* savedSettings.getSettings;
        assert.equal((yield* service.configure({ settings, apiKey: upstreamKey })).state, "ready");
        assert.equal(
          (yield* service.configure({ settings, apiKey: "rotated-key" })).state,
          "ready",
        );
        const configured = yield* savedSettings.getSettings;
        assert.notInclude(encode(configured), upstreamKey);
        assert.notInclude(encode(configured), "rotated-key");
        assert.deepEqual(configured.providers, original.providers);
        assert.deepEqual(configured.memory, original.memory);
        yield* savedSettings.updateSettings({
          ccSwitch: {
            ...settings,
            sites: [
              {
                id: "default",
                name: "PackyAPI",
                baseUrl: "https://other.test",
                models: settings.models,
              },
            ],
          },
        });
        assert.equal((yield* service.status).problem, "configuration");
        assert.equal((yield* service.configure({ settings })).state, "ready");
        assert.equal(
          (yield* service.configure({ settings: { ...settings, enabled: false } })).state,
          "disabled",
        );
        assert.equal(
          (yield* service.configure({ settings, apiKey: "ignored-on-delete", clearKey: true }))
            .apiKeyConfigured,
          false,
        );
        assert.equal((yield* savedSettings.getSettings).ccSwitch.enabled, false);
      }).pipe(Effect.provide(configureLayer)),
  );
  it.effect(
    "reads the key from CC Switch for model discovery, keeps it out of errors, and never reuses it at a changed destination",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* CcSwitch.CcSwitch;
        const rejected = yield* service
          .models({ baseUrl: "https://www.packyapi.ai" })
          .pipe(Effect.flip);
        assert.equal(rejected.code, "unauthorized");
        assert.notInclude(rejected.message, upstreamKey);
        const changed = yield* service
          .models({ baseUrl: "https://another.test" })
          .pipe(Effect.flip);
        assert.equal(changed.code, "configuration");
        const saved = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        assert.notInclude(encode(saved), upstreamKey);
        assert.notProperty(saved.ccSwitch, "apiKey");
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect("rejects a malformed configuration before mutating any CLI or T3 settings", () =>
    Effect.gen(function* () {
      const service = yield* CcSwitch.CcSwitch;
      const error = yield* service
        .configure({ settings: { ...settings, baseUrl: "file:///tmp/key" }, apiKey: upstreamKey })
        .pipe(Effect.flip);
      assert.equal(error.code, "configuration");
      const saved = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      assert.isFalse(saved.ccSwitch.enabled);
    }).pipe(Effect.provide(testLayer)),
  );
});
