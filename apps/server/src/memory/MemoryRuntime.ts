import {
  type MemoryConnectionStatus,
  type MemorySettings,
  ServerSettingsError,
} from "@t3tools/contracts";
import { MemoryApiError, MEMORY_MIN_TOKEN_CHARS } from "@t3tools/memory-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import {
  readMemoryConnection,
  type MemoryConnectionAttempt,
  type MemoryConnection,
} from "./MemoryConnection.ts";
import * as MemoryService from "./MemoryService.ts";
import * as OpenVikingMemoryService from "./OpenVikingMemoryService.ts";
import { makeOpenVikingClient } from "./OpenVikingClient.ts";
import { OPENVIKING_MEMORY_ROOT } from "./OpenVikingMemory.ts";
import { makeManagement } from "./MemoryManagement.ts";

/** Deployment credentials may be reused only for the exact same destination. */
export function resolveMemoryConfiguration(
  settings: MemorySettings,
  deployment: MemoryConnectionAttempt,
) {
  const inherited = settings.enabled === null;
  const baseUrl = inherited
    ? (deployment.connection?.baseUrl ?? "")
    : settings.baseUrl.replace(/\/+$/u, "");
  const backend = inherited ? (deployment.connection?.backend ?? "protocol") : settings.backend;
  const enabled = inherited
    ? deployment.connection !== undefined || deployment.problem !== undefined
    : settings.enabled;
  const token = inherited
    ? (deployment.connection?.token ?? "")
    : settings.apiKey ||
      (deployment.connection?.baseUrl === baseUrl &&
      (deployment.connection.backend ?? "protocol") === backend
        ? deployment.connection.token
        : "");
  let validUrl = false;
  try {
    const parsed = new URL(baseUrl);
    validUrl =
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash;
  } catch {
    /* An empty or invalid destination stays unconfigured. */
  }
  const connection: MemoryConnection | undefined =
    enabled && validUrl && token.length >= MEMORY_MIN_TOKEN_CHARS
      ? { baseUrl, token, ...(backend === "openviking" ? { backend } : {}) }
      : undefined;
  return {
    connection,
    status: {
      source: inherited ? ("deployment" as const) : ("settings" as const),
      enabled,
      backend,
      baseUrl,
      apiKeyConfigured: token.length >= MEMORY_MIN_TOKEN_CHARS,
      state: !enabled ? ("disabled" as const) : ("error" as const),
      problem: enabled ? ("configuration" as const) : null,
    } satisfies MemoryConnectionStatus,
  };
}

export class MemoryRuntime extends Context.Service<
  MemoryRuntime,
  {
    readonly service: MemoryService.MemoryServiceShape;
    readonly isEnabled: () => boolean;
    readonly isKnowledgeEnabled: () => boolean;
    readonly subscribeAvailabilityChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
    readonly checkConnection: Effect.Effect<MemoryConnectionStatus, ServerSettingsError>;
    readonly management: ReturnType<typeof makeManagement>;
  }
>()("t3/memory/MemoryRuntime") {}

const unavailable = new MemoryApiError({
  code: "unavailable",
  status: 0,
  message: "Memory is disabled or its connection is not configured.",
});
const options = {
  readTimeoutMs: MemoryService.MEMORY_READ_TIMEOUT_MS,
  writeTimeoutMs: MemoryService.MEMORY_WRITE_TIMEOUT_MS,
};

export const make = (deployment: MemoryConnectionAttempt) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const http = yield* HttpClient.HttpClient;
    const changes = yield* settings.subscribeChanges;
    const initial = resolveMemoryConfiguration(
      (yield* settings.getSettings.pipe(Effect.orDie)).memory,
      deployment,
    );
    let enabled = initial.connection !== undefined;
    let knowledgeEnabled = initial.connection?.backend === "openviking";
    const availability = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
    const setEnabled = (next: boolean, nextKnowledge: boolean) =>
      Effect.suspend(() => {
        if (enabled === next && knowledgeEnabled === nextKnowledge) return Effect.void;
        enabled = next;
        knowledgeEnabled = nextKnowledge;
        return PubSub.publish(availability, undefined).pipe(Effect.asVoid);
      });
    yield* changes.pipe(
      Stream.runForEach((next) => {
        const connection = resolveMemoryConfiguration(next.memory, deployment).connection;
        return setEnabled(connection !== undefined, connection?.backend === "openviking");
      }),
      Effect.forkScoped,
    );
    const builds = yield* Semaphore.make(1);
    // Keep writes serialized even when a key or URL changes during an in-flight write.
    const writes = yield* Semaphore.make(1);
    let cached:
      | { connection: MemoryConnection; service: MemoryService.MemoryServiceShape }
      | undefined;
    const current = builds
      .withPermit(
        Effect.gen(function* () {
          const config = resolveMemoryConfiguration(
            (yield* settings.getSettings).memory,
            deployment,
          );
          const connection = config.connection;
          yield* setEnabled(connection !== undefined, connection?.backend === "openviking");
          if (connection === undefined) return { ...config, service: undefined };
          if (
            cached === undefined ||
            cached.connection.baseUrl !== connection.baseUrl ||
            cached.connection.token !== connection.token ||
            cached.connection.backend !== connection.backend
          ) {
            const service =
              connection.backend === "openviking"
                ? yield* OpenVikingMemoryService.make(
                    { baseUrl: connection.baseUrl, apiKey: connection.token },
                    options,
                  )
                : MemoryService.makeMemoryService(connection);
            cached = { connection, service };
          }
          return { ...config, service: cached.service };
        }),
      )
      .pipe(Effect.provideService(HttpClient.HttpClient, http));
    const call = <A>(
      run: (service: MemoryService.MemoryServiceShape) => Effect.Effect<A, MemoryApiError>,
    ) =>
      current.pipe(
        Effect.mapError(() => unavailable),
        Effect.flatMap(({ service }) =>
          service === undefined ? Effect.fail(unavailable) : run(service),
        ),
      );
    const service: MemoryService.MemoryServiceShape = {
      get: (id) => call((service) => service.get(id)),
      context: (input) =>
        current.pipe(
          Effect.mapError(() => unavailable),
          Effect.flatMap(({ service }) =>
            service === undefined
              ? Effect.succeed({
                  text: "",
                  hits: [],
                  pinned: [],
                  truncated: false,
                  chars: 0,
                  empty: true,
                })
              : service.context(input),
          ),
        ),
      search: (input) => call((service) => service.search(input)),
      remember: (input, source) =>
        writes.withPermit(call((service) => service.remember(input, source))),
      update: (input, source) =>
        writes.withPermit(call((service) => service.update(input, source))),
      forget: (input, source) =>
        writes.withPermit(call((service) => service.forget(input, source))),
      restore: (id, source) => writes.withPermit(call((service) => service.restore(id, source))),
    };
    const checkConnection = Effect.gen(function* () {
      const { status, connection, service } = yield* current;
      if (connection === undefined || service === undefined) return status;
      const check =
        connection.backend === "openviking"
          ? makeOpenVikingClient(
              { baseUrl: connection.baseUrl, apiKey: connection.token },
              options,
            ).pipe(
              Effect.flatMap((client) =>
                client.list({ uri: OPENVIKING_MEMORY_ROOT, tags: [], limit: 1, offset: 0 }),
              ),
              Effect.asVoid,
              Effect.provideService(HttpClient.HttpClient, http),
            )
          : service.search({ query: "", limit: 1 }).pipe(Effect.asVoid);
      return yield* check.pipe(
        Effect.as({ ...status, state: "ready" as const, problem: null }),
        Effect.catch((error: MemoryApiError) =>
          Effect.succeed({
            ...status,
            state: "error" as const,
            problem:
              error.code === "unauthorized"
                ? ("unauthorized" as const)
                : error.code === "unavailable"
                  ? ("unavailable" as const)
                  : ("backend" as const),
          }),
        ),
      );
    });
    return MemoryRuntime.of({
      management: makeManagement(current, writes, http),
      service,
      isEnabled: () => enabled,
      isKnowledgeEnabled: () => knowledgeEnabled,
      checkConnection,
      subscribeAvailabilityChanges: PubSub.subscribe(availability).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    });
  });

const runtimeLayer = Layer.effect(
  MemoryRuntime,
  Effect.suspend(() => make(readMemoryConnection())),
).pipe(Layer.provide(FetchHttpClient.layer));

/** Share one runtime between prompt preparation, MCP tools and configuration checks. */
export const layer = Layer.effect(
  MemoryService.MemoryService,
  MemoryRuntime.pipe(Effect.map((runtime) => runtime.service)),
).pipe(Layer.provideMerge(runtimeLayer));
