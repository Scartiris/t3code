import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import { CcSwitchError, type CcSwitchSite, type CcSwitchSettings } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const APPS = ["claude", "codex"] as const;
export type GatewayApp = (typeof APPS)[number];
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      app_type: Schema.String,
      settings_config: Schema.String,
      is_current: Schema.Number,
    }),
  ),
);
const decodeClaudeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ env: Schema.Record(Schema.String, Schema.String) })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const quoteToml = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const fail = (code: CcSwitchError["code"]) => new CcSwitchError({ code });

export function profileId(
  site: CcSwitchSite,
  models: { claude: string; codex: string },
  apiKey: string,
) {
  return (
    "t3-" +
    NodeCrypto.createHash("sha256")
      .update(encodeJson({ baseUrl: site.baseUrl, ...models, apiKey }))
      .digest("hex")
      .slice(0, 20)
  );
}

export function legacyProfileId(settings: CcSwitchSettings, apiKey: string) {
  const { enabled, baseUrl, claudeModel, codexModel, openCodeModel, models } = settings;
  return (
    "t3-" +
    NodeCrypto.createHash("sha256")
      .update(
        encodeJson({ enabled, baseUrl, claudeModel, codexModel, openCodeModel, models, apiKey }),
      )
      .digest("hex")
      .slice(0, 20)
  );
}

function readRows(dbPath: string): unknown {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, app_type, settings_config, is_current FROM providers WHERE app_type IN ('claude', 'codex')",
      )
      .all();
  } finally {
    db.close();
  }
}

/** Each site has its own CC Switch credential store and routes; only selected routes run. */
export const factory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const base = path.join(stateDir, "cc-switch");
  return (siteId: string) => {
    // The original site keeps its paths, credentials and conversation history.
    const root = siteId === "default" ? base : path.join(base, "sites", siteId);
    const configDir = path.join(root, ".cc-switch");
    const claudeHome = path.join(root, ".claude");
    const codexHome = path.join(root, ".codex");
    // CC Switch's daemon uses XDG paths independently of its credential store.
    // Keep its socket path short even when the environment home or site ID is long.
    const runtimeDir = path.join(
      NodeOS.tmpdir(),
      `t3-cc-switch-${NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
    );
    const port =
      16000 +
      (Number.parseInt(NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 4), 16) %
        15000);
    const ports = { claude: port, codex: port + 1 };
    const paths = {
      claudeHome,
      codexHome,
      claudeUrl: `http://127.0.0.1:${port}`,
      codexUrl: `http://127.0.0.1:${port + 1}`,
    };
    const env = {
      ...hostEnvironment,
      HOME: root,
      CC_SWITCH_CONFIG_DIR: configDir,
      NO_COLOR: "1",
      XDG_STATE_HOME: path.join(root, ".state"),
      XDG_RUNTIME_DIR: runtimeDir,
    };
    const command = (args: readonly string[]) =>
      runner
        .run({
          command: "cc-switch",
          args,
          env,
          timeout: "20 seconds",
          maxOutputBytes: 32768,
          outputMode: "truncate",
        })
        .pipe(
          Effect.mapError(() => fail("install")),
          Effect.flatMap((result) =>
            result.code === 0 ? Effect.succeed(result.stdout) : Effect.fail(fail("gateway")),
          ),
        );
    const version = command(["--version"]).pipe(
      Effect.map((output) => output.trim()),
      Effect.filterOrFail(
        () => platform !== "win32",
        () => fail("install"),
      ),
    );
    const state = Effect.gen(function* () {
      const dbPath = path.join(configDir, "cc-switch.db");
      if (!(yield* fs.exists(dbPath)))
        return { rows: [], apiKey: "", baseUrl: "", ids: { claude: "", codex: "" } };
      const raw = yield* Effect.try({ try: () => readRows(dbPath), catch: () => fail("gateway") });
      const rows = yield* decodeRows(raw);
      const current = (app: string) =>
        rows.find((row) => row.app_type === app && row.is_current === 1);
      const claude = current("claude");
      const config = claude ? yield* decodeClaudeConfig(claude.settings_config) : null;
      return {
        rows,
        apiKey: config?.env.ANTHROPIC_AUTH_TOKEN ?? "",
        baseUrl: config?.env.ANTHROPIC_BASE_URL ?? "",
        ids: { claude: claude?.id ?? "", codex: current("codex")?.id ?? "" },
      };
    }).pipe(Effect.mapError(() => fail("gateway")));
    const setup = Effect.gen(function* () {
      for (const directory of [root, configDir, claudeHome, codexHome, runtimeDir]) {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        yield* fs.chmod(directory, 0o700);
      }
      // Preserve CC Switch's device-local pointers while fixing only its managed homes.
      const settingsFile = path.join(configDir, "settings.json");
      const settings = (yield* fs.exists(settingsFile))
        ? yield* fs.readFileString(settingsFile).pipe(
            Effect.flatMap(decodeObject),
            Effect.orElseSucceed(() => ({})),
          )
        : {};
      yield* fs.writeFileString(
        settingsFile,
        encodeJson({ ...settings, claudeConfigDir: claudeHome, codexConfigDir: codexHome }),
        { mode: 0o600 },
      );
      const marker = path.join(root, "ports.json");
      if (!(yield* fs.exists(marker))) {
        for (const app of APPS)
          yield* command([
            "--app",
            app,
            "proxy",
            "config",
            ...(app === "claude" ? ["--listen-address", "127.0.0.1"] : []),
            "--listen-port",
            String(ports[app]),
          ]);
        yield* fs.writeFileString(marker, encodeJson(ports), { mode: 0o600 });
      }
    }).pipe(Effect.mapError(() => fail("gateway")));
    const exists = fs.exists(path.join(configDir, "cc-switch.db"));
    const disable = (apps: readonly GatewayApp[] = APPS) =>
      Effect.gen(function* () {
        if (!(yield* exists)) return;
        for (const app of apps) yield* command(["--app", app, "proxy", "disable"]);
      });
    const setRoutes = (apps: readonly GatewayApp[]) =>
      Effect.gen(function* () {
        if (!(yield* exists)) {
          if (apps.length) return yield* fail("configuration");
          return;
        }
        yield* fs.makeDirectory(runtimeDir, { recursive: true, mode: 0o700 });
        yield* fs.chmod(runtimeDir, 0o700);
        for (const app of APPS) {
          if (!apps.includes(app)) {
            yield* disable([app]);
            continue;
          }
          yield* command(["--app", app, "proxy", "enable"]);
          const response = yield* http
            .execute(
              HttpClientRequest.get(
                `${app === "claude" ? paths.claudeUrl : paths.codexUrl}/health`,
              ),
            )
            .pipe(
              Effect.timeout("3 seconds"),
              Effect.mapError(() => fail("gateway")),
            );
          if (response.status !== 200) return yield* fail("gateway");
        }
        if (apps.length) {
          const daemon = yield* command(["daemon", "status"]);
          for (const app of apps)
            if (
              !new RegExp(
                `worker\\[${app}\\]:\\s+127\\.0\\.0\\.1:${ports[app]}\\s+\\(pid [1-9]\\d*\\)`,
                "u",
              ).test(daemon)
            )
              return yield* fail("gateway");
        }
      });
    const apply = (site: CcSwitchSite, models: { claude: string; codex: string }, apiKey: string) =>
      Effect.gen(function* () {
        yield* setup;
        const stored = yield* state;
        const id = profileId(site, models, apiKey);
        const configs = {
          claude: {
            env: {
              ANTHROPIC_BASE_URL: site.baseUrl,
              ANTHROPIC_AUTH_TOKEN: apiKey,
              ...(models.claude ? { ANTHROPIC_MODEL: models.claude } : {}),
            },
          },
          codex: {
            auth: { OPENAI_API_KEY: apiKey },
            config: `model_provider = "custom"\n${models.codex ? `model = ${quoteToml(models.codex)}\n` : ""}[model_providers.custom]\nname = ${quoteToml(site.name)}\nbase_url = ${quoteToml(site.baseUrl + "/v1")}\nwire_api = "responses"\nexperimental_bearer_token = ${quoteToml(apiKey)}\nrequires_openai_auth = false\n`,
          },
        };
        for (const app of APPS) {
          if (!stored.rows.some((row) => row.app_type === app && row.id === id)) {
            const file = path.join(root, `input-${NodeCrypto.randomUUID()}.json`);
            yield* Effect.acquireUseRelease(
              fs.writeFileString(file, encodeJson(configs[app]), { mode: 0o600 }),
              () =>
                command([
                  "--app",
                  app,
                  "provider",
                  "add",
                  "--id",
                  id,
                  "--name",
                  site.name,
                  "--config-file",
                  file,
                ]),
              () => fs.remove(file, { force: true }).pipe(Effect.ignore),
            ).pipe(Effect.mapError(() => fail("gateway")));
          }
        }
        for (const app of APPS) yield* command(["--app", app, "provider", "switch", id]);
      });
    const restore = (ids: { claude: string; codex: string }) =>
      Effect.gen(function* () {
        for (const app of APPS)
          if (ids[app]) yield* command(["--app", app, "provider", "switch", ids[app]]);
      });
    const remove = Effect.gen(function* () {
      if (!(yield* fs.exists(root))) return;
      yield* disable();
      // The native daemon exits after its last worker stops; a concurrent stop
      // can therefore report a disconnected socket even though shutdown succeeded.
      yield* command(["daemon", "stop"]).pipe(
        Effect.catch(() =>
          command(["daemon", "status"]).pipe(
            Effect.filterOrFail(
              (output) => output.includes("daemon not reachable:"),
              () => fail("gateway"),
            ),
          ),
        ),
      );
      // Retiring CLI probes may still write to their old home until registry
      // reconciliation closes them. Detach first so these writes cannot race
      // recursive deletion or keep the credential store at its active path.
      const detachAndRemove = (target: string) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(target))) return;
          const detached = path.join(base, `.removed-${NodeCrypto.randomUUID()}`);
          yield* fs.rename(target, detached);
          yield* fs.remove(detached, { recursive: true, force: true });
        });
      if (siteId === "default") {
        for (const name of [".claude", ".codex", ".cc-switch", ".state", "ports.json"])
          yield* detachAndRemove(path.join(root, name));
      } else yield* detachAndRemove(root);
      yield* fs.remove(runtimeDir, { recursive: true, force: true });
    }).pipe(Effect.mapError(() => fail("gateway")));
    return {
      paths,
      state,
      version,
      apply: (...args: Parameters<typeof apply>) =>
        apply(...args).pipe(Effect.mapError(() => fail("gateway"))),
      setRoutes: (...args: Parameters<typeof setRoutes>) =>
        setRoutes(...args).pipe(Effect.mapError(() => fail("gateway"))),
      restore,
      remove,
    };
  };
});
