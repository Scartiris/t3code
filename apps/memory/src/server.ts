// The process bootstrap: an HTTP listener and the clock the service reports it
// started at. Everything below this file is Effect.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as NodeHttp from "node:http";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { readMemoryToken, type MemoryConfig } from "./config.ts";
import { memoryHttpRouteLayer } from "./http/routes.ts";
import { memoryMcpLayer } from "./mcp/http.ts";
import { makeMemoryService } from "./service/MemoryService.ts";
import { layer as memoryStoreLayer, MemoryStore } from "./store/MemoryStore.ts";
import { runMigrations } from "./store/Migrations.ts";

/** How long in-flight requests get before the listener closes on shutdown. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * SQLite plus migrations.
 *
 * `effect_sql_migrations` records what ran, so a restart is a no-op. A failed
 * migration makes the layer fail to build, which surfaces as a failed systemd
 * unit rather than a service running against a half-written schema.
 */
const persistenceLayer = (databasePath: string) =>
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations()),
    NodeSqliteClient.layer({
      filename: databasePath,
      spanAttributes: { "db.name": "memory.sqlite", "service.name": "t3-memory" },
    }),
  );

const storeLayer = (databasePath: string) =>
  memoryStoreLayer.pipe(Layer.provide(persistenceLayer(databasePath)));

/**
 * Build the whole application.
 *
 * The store is built once and the service is made from it, so the two
 * transports receive a value rather than a requirement: what is left for the
 * router to provide is the router itself.
 */
export const makeMemoryServerLayer = (config: MemoryConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const token = readMemoryToken(config.tokenFilePath);
      const store = yield* Effect.provide(MemoryStore, storeLayer(config.databasePath));
      const service = makeMemoryService(store, {
        databasePath: config.databasePath,
        tokenConfigured: token !== undefined,
        startedAt: Date.now(),
      });
      const auth = { token };

      const routes = Layer.mergeAll(
        memoryHttpRouteLayer(auth, service),
        memoryMcpLayer(auth, service),
      );

      return HttpRouter.serve(routes, { disableLogger: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), {
            host: config.host,
            port: config.port,
            gracefulShutdownTimeout: SHUTDOWN_GRACE_MS,
          }),
        ),
      );
    }),
  );

export const runMemoryServer = (config: MemoryConfig) => {
  const token = readMemoryToken(config.tokenFilePath);
  return Layer.launch(makeMemoryServerLayer(config)).pipe(
    Effect.tap(() =>
      Effect.logInfo("Memory service listening").pipe(
        Effect.annotateLogs({
          host: config.host,
          port: config.port,
          databasePath: config.databasePath,
          home: config.homeDir,
        }),
      ),
    ),
    Effect.tap(() =>
      token === undefined
        ? Effect.logWarning(
            "No usable bearer token: every authenticated route will answer 401. Run `t3-memory token`.",
          ).pipe(Effect.annotateLogs({ tokenFilePath: config.tokenFilePath }))
        : Effect.void,
    ),
  );
};
