import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { MemoryApiError, MemoryId, type MemoryCreateInput } from "@t3tools/memory-protocol";

import {
  layer as memoryServiceLayer,
  MemoryService,
  type MemoryServiceInfo,
  type MemoryServiceShape,
} from "./MemoryService.ts";
import { layer as memoryStoreLayer } from "../store/MemoryStore.ts";
import { runMigrations } from "../store/Migrations.ts";

const NOW = 1_800_000_000_000;

const storeLayer = memoryStoreLayer.pipe(
  Layer.provide(
    Layer.provideMerge(
      Layer.effectDiscard(runMigrations()),
      NodeSqliteClient.layer({ filename: ":memory:" }),
    ),
  ),
);

const serviceLayer = (overrides: Partial<MemoryServiceInfo> = {}) =>
  memoryServiceLayer({
    databasePath: ":memory:",
    tokenConfigured: true,
    startedAt: NOW,
    ...overrides,
  }).pipe(Layer.provide(storeLayer));

const withService = <A, E>(
  use: (service: MemoryServiceShape) => Effect.Effect<A, E>,
  info: Partial<MemoryServiceInfo> = {},
) =>
  Effect.gen(function* () {
    const service = yield* MemoryService;
    return yield* use(service);
  }).pipe(Effect.provide(serviceLayer(info)));

const write = (overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput => ({
  title: "部署前先跑测试",
  body: "上线 pigeoncore 之前先在本地跑一遍测试。",
  kind: "preference",
  scope: "global",
  ...overrides,
});

const human = { kind: "human" } as const;

const isMemoryApiError = Schema.is(MemoryApiError);

const codeOf = (error: unknown): string =>
  isMemoryApiError(error) ? error.code : `unexpected: ${String(error)}`;

describe("MemoryService validation", () => {
  it.effect("requires a project for a project-scoped memory", () =>
    withService((service) =>
      Effect.gen(function* () {
        const failure = yield* service.create(write({ scope: "project" }), human).pipe(Effect.flip);
        assert.strictEqual(codeOf(failure), "invalid_request");
      }),
    ),
  );

  it.effect("refuses a project on a global memory", () =>
    withService((service) =>
      Effect.gen(function* () {
        const failure = yield* service
          .create(write({ scope: "global", projectId: "proj-1" }), human)
          .pipe(Effect.flip);
        assert.strictEqual(codeOf(failure), "invalid_request");
      }),
    ),
  );

  it.effect("caps the number of tags", () =>
    withService((service) =>
      Effect.gen(function* () {
        const tags = Array.from({ length: 17 }, (_value, index) => `tag-${index}`);
        const failure = yield* service.create(write({ tags }), human).pipe(Effect.flip);
        assert.strictEqual(codeOf(failure), "invalid_request");
      }),
    ),
  );
});

describe("MemoryService reads", () => {
  it.effect("finds what it stored, with a snippet and a score", () =>
    withService((service) =>
      Effect.gen(function* () {
        const created = yield* service.create(write(), human);
        const found = yield* service.search({ query: "部署" });
        assert.strictEqual(found.total, 1);
        assert.strictEqual(found.items[0]?.entry.id, created.entry.id);
        assert.isAbove(found.items[0]?.score ?? 0, 0);
        assert.include(found.items[0]?.snippet ?? "", "部署");
      }),
    ),
  );

  it.effect("counts a search as a recall", () =>
    withService((service) =>
      Effect.gen(function* () {
        const created = yield* service.create(write(), human);
        yield* service.search({ query: "部署" });
        const read = yield* service.get(created.entry.id);
        assert.strictEqual(read.hitCount, 1);
      }),
    ),
  );

  it.effect("reports a missing entry as not_found", () =>
    withService((service) =>
      Effect.gen(function* () {
        const failure = yield* service.get(MemoryId.make("mem_missing")).pipe(Effect.flip);
        assert.strictEqual(codeOf(failure), "not_found");
      }),
    ),
  );

  it.effect("pages a ranked list with a cursor", () =>
    withService((service) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 5 }, (_value, index) => index),
          (index) => service.create(write({ title: `记忆 ${index}` }), human),
          { discard: true },
        );
        const first = yield* service.search({ limit: 2 });
        assert.strictEqual(first.items.length, 2);
        assert.strictEqual(first.total, 5);
        assert.strictEqual(first.nextCursor, "2");
        const second = yield* service.search(
          first.nextCursor === null ? { limit: 2 } : { limit: 2, cursor: first.nextCursor },
        );
        assert.strictEqual(second.items.length, 2);
        assert.notStrictEqual(second.items[0]?.entry.id, first.items[0]?.entry.id);
      }),
    ),
  );

  it.effect("lists archived entries, which search never returns", () =>
    withService((service) =>
      Effect.gen(function* () {
        const created = yield* service.create(write(), human);
        yield* service.setStatus(created.entry.id, { status: "archived" }, human);
        assert.strictEqual((yield* service.search({ query: "部署" })).total, 0);
        const archived = yield* service.list({ status: "archived" });
        assert.strictEqual(archived.total, 1);
      }),
    ),
  );
});

describe("MemoryService status changes", () => {
  it.effect("requires the replacement when superseding", () =>
    withService((service) =>
      Effect.gen(function* () {
        const created = yield* service.create(write(), human);
        const failure = yield* service
          .setStatus(created.entry.id, { status: "superseded" }, human)
          .pipe(Effect.flip);
        assert.strictEqual(codeOf(failure), "invalid_request");
      }),
    ),
  );

  it.effect("refuses a replacement that does not exist", () =>
    withService((service) =>
      Effect.gen(function* () {
        const created = yield* service.create(write(), human);
        const failure = yield* service
          .setStatus(
            created.entry.id,
            { status: "superseded", supersededBy: MemoryId.make("mem_missing") },
            human,
          )
          .pipe(Effect.flip);
        assert.strictEqual(codeOf(failure), "not_found");
      }),
    ),
  );

  it.effect("supersedes, restores, and keeps the history", () =>
    withService((service) =>
      Effect.gen(function* () {
        // Grams must not overlap: CJK query expansion ORs bigrams, so a "新结论"
        // entry would match a query for "旧结论" through the shared "结论".
        // This test is about status visibility, not about what a broad query
        // recalls.
        const old = yield* service.create(write({ title: "旧结论" }), human);
        const next = yield* service.create(write({ title: "新方案" }), human);
        const superseded = yield* service.setStatus(
          old.entry.id,
          { status: "superseded", supersededBy: next.entry.id, reason: "改主意了" },
          human,
        );
        assert.strictEqual(superseded.status, "superseded");
        assert.strictEqual((yield* service.search({ query: "旧结论" })).total, 0);

        const restored = yield* service.setStatus(old.entry.id, { status: "active" }, human);
        assert.strictEqual(restored.status, "active");
        assert.strictEqual((yield* service.search({ query: "旧结论" })).total, 1);

        const history = yield* service.history(old.entry.id);
        assert.deepStrictEqual(
          history.events.map((event) => event.type),
          ["created", "status-changed", "status-changed"],
        );
      }),
    ),
  );
});

describe("MemoryService context", () => {
  it.effect("returns nothing to inject for an empty store", () =>
    withService((service) =>
      Effect.gen(function* () {
        const context = yield* service.context({});
        assert.strictEqual(context.empty, true);
        assert.strictEqual(context.text, "");
      }),
    ),
  );

  it.effect("injects pinned entries and calls the rest recent", () =>
    withService((service) =>
      Effect.gen(function* () {
        yield* service.create(write({ title: "置顶偏好", pinned: true }), human);
        yield* service.create(write({ title: "普通记忆" }), human);
        const context = yield* service.context({});
        assert.isTrue(context.text.startsWith("<t3_memory>"));
        assert.include(context.text, "置顶偏好");
        assert.include(context.text, "Recent:");
        assert.strictEqual(context.pinned.length, 1);
      }),
    ),
  );

  it.effect("labels a queried block as related", () =>
    withService((service) =>
      Effect.gen(function* () {
        yield* service.create(write({ title: "部署前先跑测试" }), human);
        const context = yield* service.context({ query: "部署" });
        assert.include(context.text, "Related:");
        assert.notInclude(context.text, "Recent:");
      }),
    ),
  );

  it.effect("honours includePinned false", () =>
    withService((service) =>
      Effect.gen(function* () {
        yield* service.create(write({ title: "置顶偏好", pinned: true }), human);
        const context = yield* service.context({ includePinned: false });
        assert.strictEqual(context.pinned.length, 0);
      }),
    ),
  );
});

describe("MemoryService batch and health", () => {
  it.effect("keeps one bad item from failing the batch", () =>
    withService((service) =>
      Effect.gen(function* () {
        const result = yield* service.createBatch(
          { entries: [write(), write({ scope: "project" })] },
          human,
        );
        assert.isTrue(result.results[0]?.ok);
        assert.isFalse(result.results[1]?.ok);
        assert.strictEqual(result.results[1]?.error?.code, "invalid_request");
      }),
    ),
  );

  it.effect("reports counts and whether a token is configured", () =>
    withService(
      (service) =>
        Effect.gen(function* () {
          yield* service.create(write({ pinned: true }), human);
          const health = yield* service.health();
          assert.strictEqual(health.entries.active, 1);
          assert.strictEqual(health.entries.pinned, 1);
          assert.isFalse(health.tokenConfigured);
          assert.strictEqual(health.service, "t3-memory");
        }),
      { tokenConfigured: false },
    ),
  );
});
