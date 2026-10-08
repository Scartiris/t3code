import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { MemoryId } from "@t3tools/memory-protocol";

import type { MemoryAuthOptions } from "./auth.ts";
import { memoryHttpHandler } from "./routes.ts";
import { layer as memoryServiceLayer, MemoryService } from "../service/MemoryService.ts";
import { layer as memoryStoreLayer } from "../store/MemoryStore.ts";
import { runMigrations } from "../store/Migrations.ts";

const TOKEN = "t".repeat(40);

const storeLayer = memoryStoreLayer.pipe(
  Layer.provide(
    Layer.provideMerge(
      Layer.effectDiscard(runMigrations()),
      NodeSqliteClient.layer({ filename: ":memory:" }),
    ),
  ),
);

const serviceLayer = memoryServiceLayer({
  databasePath: ":memory:",
  tokenConfigured: true,
  startedAt: 0,
}).pipe(Layer.provide(storeLayer));

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type RequestFn = (request: Request) => Effect.Effect<CallResult>;

/**
 * One service instance per test: the store is an in-memory database, so a
 * layer rebuilt per request would answer every read from an empty store.
 */
const withServer = <A, E>(
  options: MemoryAuthOptions,
  use: (request: RequestFn) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* MemoryService;
    const request: RequestFn = (init) =>
      Effect.gen(function* () {
        const response = yield* memoryHttpHandler(options, service);
        const web = HttpServerResponse.toWeb(response);
        return {
          status: web.status,
          body: (yield* Effect.promise(() => web.json())) as Record<string, unknown>,
        };
      }).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(init)),
      );
    return yield* use(request);
  }).pipe(Effect.provide(serviceLayer));

const authorized = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://memory.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const json = (body: unknown, method: string = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: encodeJson(body),
});

const writeBody = {
  title: "部署前先跑测试",
  body: "上线之前先在本地跑一遍",
  kind: "preference",
  scope: "global",
};

describe("memory HTTP dispatcher", () => {
  it.effect("answers health without a token", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const result = yield* request(new Request("http://memory.test/health"));
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body.service, "t3-memory");
        assert.strictEqual(result.body.tokenConfigured, true);
      }),
    ),
  );

  it.effect("rejects an authenticated route without a token", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const result = yield* request(
          new Request("http://memory.test/v1/entries", json(writeBody)),
        );
        assert.strictEqual(result.status, 401);
        assert.strictEqual((result.body.error as { code: string }).code, "unauthorized");
      }),
    ),
  );

  it.effect("rejects a wrong token", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const result = yield* request(
          new Request("http://memory.test/v1/entries", {
            ...json(writeBody),
            headers: { authorization: `Bearer ${"x".repeat(40)}` },
          }),
        );
        assert.strictEqual(result.status, 401);
      }),
    ),
  );

  it.effect("says how to fix an unconfigured service", () =>
    withServer({ token: undefined }, (request) =>
      Effect.gen(function* () {
        const health = yield* request(new Request("http://memory.test/health"));
        assert.strictEqual(health.body.tokenConfigured, false);

        const denied = yield* request(authorized("/v1/entries", json(writeBody)));
        assert.strictEqual(denied.status, 401);
        assert.include((denied.body.error as { message: string }).message, "t3-memory token");
      }),
    ),
  );

  it.effect("creates, reads, searches, and renders context", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const created = yield* request(authorized("/v1/entries", json(writeBody)));
        assert.strictEqual(created.status, 201);
        const id = (created.body.entry as { id: string }).id;

        const read = yield* request(authorized(`/v1/entries/${id}`));
        assert.strictEqual(read.status, 200);
        assert.strictEqual(read.body.title, "部署前先跑测试");

        const found = yield* request(authorized("/v1/search", json({ query: "部署" })));
        assert.strictEqual(found.status, 200);
        assert.strictEqual((found.body.items as unknown[]).length, 1);

        const context = yield* request(authorized("/v1/context", json({ query: "部署" })));
        assert.include((context.body as { text: string }).text, "部署前先跑测试");
      }),
    ),
  );

  it.effect("treats a repeated dedupeKey as the same memory", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const body = { ...writeBody, dedupeKey: "deploy.run-tests" };
        const first = yield* request(authorized("/v1/entries", json(body)));
        const second = yield* request(authorized("/v1/entries", json(body)));
        assert.strictEqual(first.status, 201);
        assert.strictEqual(second.status, 200);
        assert.strictEqual(second.body.duplicate, true);
        assert.strictEqual(
          (second.body.entry as { id: string }).id,
          (first.body.entry as { id: string }).id,
        );
      }),
    ),
  );

  it.effect("records the caller provenance from the header", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const created = yield* request(
          authorized("/v1/entries", {
            ...json(writeBody),
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
              "x-memory-source": encodeJson({
                kind: "agent",
                threadId: "thread-1",
                providerInstanceId: "claude",
              }),
            },
          }),
        );
        const id = (created.body.entry as { id: string }).id;
        const history = yield* request(authorized(`/v1/entries/${id}/history`));
        const events = history.body.events as ReadonlyArray<{ actor: { threadId?: string } }>;
        assert.strictEqual(events[0]?.actor.threadId, "thread-1");
      }),
    ),
  );

  it.effect("archives through the status route and lists it afterwards", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const created = yield* request(authorized("/v1/entries", json(writeBody)));
        const id = (created.body.entry as { id: string }).id;

        const archived = yield* request(
          authorized(`/v1/entries/${id}/status`, json({ status: "archived", reason: "过时了" })),
        );
        assert.strictEqual(archived.status, 200);
        assert.strictEqual(archived.body.status, "archived");

        const listed = yield* request(authorized("/v1/entries?status=archived"));
        assert.strictEqual((listed.body.items as unknown[]).length, 1);
        assert.strictEqual(listed.body.total, 1);
      }),
    ),
  );

  it.effect("rejects a mismatched version with 409", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const created = yield* request(authorized("/v1/entries", json(writeBody)));
        const id = (created.body.entry as { id: string }).id;
        const conflict = yield* request(
          authorized(`/v1/entries/${id}`, json({ title: "改一下", expectedVersion: 7 }, "PATCH")),
        );
        assert.strictEqual(conflict.status, 409);
        assert.strictEqual((conflict.body.error as { code: string }).code, "conflict");
      }),
    ),
  );

  it.effect("validates the body and the path", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        const badBody = yield* request(
          authorized("/v1/entries", { method: "POST", body: "not json" }),
        );
        assert.strictEqual(badBody.status, 400);

        const badEntry = yield* request(authorized("/v1/entries", json({ title: "" })));
        assert.strictEqual(badEntry.status, 400);

        const unknown = yield* request(authorized("/v1/nope"));
        assert.strictEqual(unknown.status, 404);

        const missing = yield* request(authorized(`/v1/entries/${MemoryId.make("mem_missing")}`));
        assert.strictEqual(missing.status, 404);
      }),
    ),
  );

  it.effect("rebuilds the index over HTTP", () =>
    withServer({ token: TOKEN }, (request) =>
      Effect.gen(function* () {
        yield* request(authorized("/v1/entries", json(writeBody)));
        const rebuilt = yield* request(authorized("/v1/index/rebuild", { method: "POST" }));
        assert.strictEqual(rebuilt.status, 200);
        assert.strictEqual(rebuilt.body.indexed, 1);
      }),
    ),
  );
});
