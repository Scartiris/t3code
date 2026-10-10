import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MemoryConnectionStatus,
  type MemorySettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import { make, resolveMemoryConfiguration } from "./MemoryRuntime.ts";

const token = "deployment-key-".padEnd(40, "a");
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(MemoryConnectionStatus));
const otherToken = "settings-key-".padEnd(40, "b");
const deployment = {
  connection: { backend: "openviking" as const, baseUrl: "http://memory.test", token },
};
const settings = (patch: Partial<MemorySettings> = {}): MemorySettings => ({
  ...DEFAULT_SERVER_SETTINGS.memory,
  ...patch,
});

describe("memory configuration", () => {
  it("inherits deployment defaults until explicitly overridden and can restore them", () => {
    assert.deepEqual(
      resolveMemoryConfiguration(settings(), deployment).connection,
      deployment.connection,
    );
    assert.equal(resolveMemoryConfiguration(settings(), {}).status.state, "disabled");
    assert.equal(
      resolveMemoryConfiguration(settings(), { problem: "bad token file" }).status.problem,
      "configuration",
    );
    assert.isUndefined(
      resolveMemoryConfiguration(settings({ enabled: false }), deployment).connection,
    );
    assert.deepEqual(
      resolveMemoryConfiguration(
        settings({ enabled: null, baseUrl: "http://other.test", apiKey: otherToken }),
        deployment,
      ).connection,
      deployment.connection,
    );
  });

  it("reuses a deployment key only for the same backend and destination", () => {
    assert.deepEqual(
      resolveMemoryConfiguration(
        settings({ enabled: true, baseUrl: "http://memory.test/" }),
        deployment,
      ).connection,
      deployment.connection,
    );
    for (const patch of [{ baseUrl: "http://other.test" }, { backend: "protocol" as const }]) {
      assert.isUndefined(
        resolveMemoryConfiguration(
          settings({ enabled: true, baseUrl: "http://memory.test", ...patch }),
          deployment,
        ).connection,
      );
    }
    assert.equal(
      resolveMemoryConfiguration(
        settings({ enabled: true, baseUrl: "http://other.test", apiKey: otherToken }),
        deployment,
      ).connection?.token,
      otherToken,
    );
  });

  it("rejects malformed destinations and short keys without exposing credentials in status", () => {
    for (const baseUrl of [
      "",
      "file:///tmp/memory",
      "http://user:key@memory.test",
      "http://memory.test?token=key",
      "http://memory.test#key",
    ]) {
      assert.isUndefined(
        resolveMemoryConfiguration(settings({ enabled: true, baseUrl, apiKey: otherToken }), {})
          .connection,
      );
    }
    const result = resolveMemoryConfiguration(
      settings({ enabled: true, baseUrl: "http://memory.test", apiKey: "short" }),
      {},
    );
    assert.equal(result.status.problem, "configuration");
    assert.notInclude(encodeStatus(result.status), "short");
    assert.notInclude(
      encodeStatus(resolveMemoryConfiguration(settings(), deployment).status),
      token,
    );
  });
});

describe("live memory runtime", () => {
  it.effect(
    "switches credentials and destinations without a restart, and disables reads and tools",
    () => {
      const seen: Array<{ url: string; authorization: string | undefined }> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          seen.push({ url: request.url, authorization: request.headers.authorization });
          return HttpClientResponse.fromWeb(request, Response.json({ status: "ok", result: [] }));
        }),
      );
      return Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* make(deployment);
          const store = yield* ServerSettings.ServerSettingsService;
          assert.equal((yield* runtime.checkConnection).state, "ready");
          assert.equal(seen[0]?.authorization, `Bearer ${token}`);
          yield* store.updateSettings({
            memory: { enabled: true, baseUrl: "http://other.test", apiKey: otherToken },
          });
          assert.equal((yield* runtime.service.search({ query: "" })).total, 0);
          assert.equal(seen.at(-1)?.authorization, `Bearer ${otherToken}`);
          assert.include(seen.at(-1)?.url ?? "", "http://other.test/");
          yield* store.updateSettings({ memory: { enabled: false } });
          const count = seen.length;
          assert.equal((yield* runtime.checkConnection).state, "disabled");
          assert.isFalse(runtime.isEnabled());
          assert.isTrue((yield* runtime.service.context({ query: "test" })).empty);
          assert.equal((yield* runtime.service.search({}).pipe(Effect.result))._tag, "Failure");
          assert.equal(seen.length, count);
          yield* store.updateSettings({ memory: { enabled: null, apiKey: "" } });
          assert.equal((yield* runtime.checkConnection).source, "deployment");
          assert.isTrue(runtime.isEnabled());
          assert.equal(seen.at(-1)?.authorization, `Bearer ${token}`);
        }),
      ).pipe(
        Effect.provide(ServerSettings.layerTest()),
        Effect.provideService(HttpClient.HttpClient, http),
      );
    },
  );

  it.effect.each([
    [401, "unauthorized"],
    [503, "unavailable"],
    [500, "backend"],
  ] as const)("reports HTTP %s without returning backend error text", ([status, problem]) => {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ status: "error", error: { message: `secret=${token}` } }, { status }),
        ),
      ),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* make(deployment);
        const checked = yield* runtime.checkConnection;
        assert.equal(checked.state, "error");
        assert.equal(checked.problem, problem);
        assert.notInclude(encodeStatus(checked), token);
      }),
    ).pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  });

  it.effect("serializes writes across a configuration change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondAttempted = yield* Deferred.make<void>();
        const writes: string[] = [];
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            writes.push(request.url);
            if (writes.length === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                status: "ok",
                result: { content_updated: true, vector_status: "complete" },
              }),
            );
          }),
        );
        const runtime = yield* make(deployment).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        const store = yield* ServerSettings.ServerSettingsService;
        const input = {
          entries: [
            {
              title: "Fact",
              body: "Persistent fact",
              kind: "fact" as const,
              scope: "global" as const,
            },
          ],
        };
        const source = { kind: "agent" as const, threadId: "test-thread" };
        const first = yield* runtime.service.remember(input, source).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* store.updateSettings({
          memory: { enabled: true, baseUrl: "http://other.test", apiKey: otherToken },
        });
        const second = yield* Deferred.succeed(secondAttempted, undefined).pipe(
          Effect.andThen(runtime.service.remember(input, source)),
          Effect.forkChild,
        );
        yield* Deferred.await(secondAttempted);
        assert.equal(writes.length, 1);
        yield* Deferred.succeed(releaseFirst, undefined);
        assert.isTrue((yield* Fiber.join(first)).results[0]?.ok);
        assert.isTrue((yield* Fiber.join(second)).results[0]?.ok);
        assert.equal(writes.length, 2);
        assert.include(writes[1] ?? "", "http://other.test/");
      }),
    ).pipe(Effect.provide(ServerSettings.layerTest())),
  );
});
