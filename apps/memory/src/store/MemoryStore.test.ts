import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { MemoryId, type MemoryEntry } from "@t3tools/memory-protocol";

import { runMigrations } from "./Migrations.ts";
import {
  layer as memoryStoreLayer,
  MemoryStore,
  defaultMemoryFilter,
  type MemoryFilter,
  type MemoryStoreShape,
  type NewEntryRecord,
  type RankedRow,
} from "./MemoryStore.ts";
import { MemoryEntryConflictError, MemoryEntryNotFoundError } from "./Errors.ts";

const NOW = 1_800_000_000_000;

const storeLayer = memoryStoreLayer.pipe(
  Layer.provide(
    Layer.provideMerge(
      Layer.effectDiscard(runMigrations()),
      NodeSqliteClient.layer({ filename: ":memory:" }),
    ),
  ),
);

let sequence = 0;
const record = (overrides: Partial<NewEntryRecord> = {}): NewEntryRecord => {
  sequence += 1;
  return {
    id: MemoryId.make(`mem_test_${String(sequence).padStart(4, "0")}`),
    title: `title ${sequence}`,
    body: `body ${sequence}`,
    kind: "fact",
    scope: "global",
    projectId: null,
    tags: [],
    pinned: false,
    importance: 0.5,
    expiresAt: null,
    dedupeKey: null,
    reviewState: "accepted",
    source: { kind: "human" },
    now: NOW,
    ...overrides,
  };
};

const withStore = <A, E>(use: (store: MemoryStoreShape) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const store = yield* MemoryStore;
    return yield* use(store);
  }).pipe(Effect.provide(storeLayer));

const ids = (rows: ReadonlyArray<RankedRow>): ReadonlyArray<string> =>
  rows.map((row) => row.id as string);

const search = (store: MemoryStoreShape, query: string, filter: Partial<MemoryFilter> = {}) =>
  store.findRanked({ filter: defaultMemoryFilter(filter), query, now: NOW });

describe("MemoryStore entries", () => {
  it.effect("round-trips an entry", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(record({ title: "部署前先跑测试" }));
        assert.isFalse(created.duplicate);
        assert.strictEqual(created.entry.version, 1);
        const read = yield* store.get(created.entry.id);
        assert.strictEqual(read.title, "部署前先跑测试");
      }),
    ),
  );

  it.effect("reports a missing id rather than an empty entry", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const failure = yield* store.get(MemoryId.make("mem_missing")).pipe(Effect.flip);
        assert.instanceOf(failure, MemoryEntryNotFoundError);
      }),
    ),
  );

  it.effect("keeps an existing entry when the same dedupeKey is written twice", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const first = yield* store.create(record({ dedupeKey: "deploy.run-tests" }));
        const second = yield* store.create(
          record({ dedupeKey: "deploy.run-tests", title: "written again" }),
        );
        assert.isTrue(second.duplicate);
        assert.strictEqual(second.entry.id, first.entry.id);
        assert.strictEqual(second.entry.title, first.entry.title);
      }),
    ),
  );

  it.effect("treats the same dedupeKey in another project as a different memory", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const global = yield* store.create(record({ dedupeKey: "k" }));
        const project = yield* store.create(
          record({ dedupeKey: "k", scope: "project", projectId: "proj-1" }),
        );
        assert.isFalse(project.duplicate);
        assert.notStrictEqual(project.entry.id, global.entry.id);
      }),
    ),
  );

  it.effect("refuses an update built on a stale version", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(record());
        yield* store.update({
          id: created.entry.id,
          patch: { title: "first edit" },
          expectedVersion: created.entry.version,
          actor: { kind: "human" },
          now: NOW,
        });
        const failure = yield* store
          .update({
            id: created.entry.id,
            patch: { title: "second edit" },
            expectedVersion: created.entry.version,
            actor: { kind: "human" },
            now: NOW,
          })
          .pipe(Effect.flip);
        assert.instanceOf(failure, MemoryEntryConflictError);
      }),
    ),
  );

  it.effect("audits creation, edits, and status changes", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(record());
        yield* store.update({
          id: created.entry.id,
          patch: { title: "edited" },
          expectedVersion: null,
          actor: { kind: "agent", threadId: "thread-1" },
          now: NOW + 1,
        });
        yield* store.setStatus({
          id: created.entry.id,
          status: "archived",
          supersededBy: null,
          reason: "过时了",
          actor: { kind: "human" },
          now: NOW + 2,
        });
        const events = yield* store.history(created.entry.id);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["created", "updated", "status-changed"],
        );
        assert.strictEqual(events[1]?.actor.threadId, "thread-1");
        assert.include(events[2]?.detail ?? "", "过时了");
      }),
    ),
  );

  it.effect("counts by status", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(record({ pinned: true }));
        const second = yield* store.create(record());
        yield* store.setStatus({
          id: second.entry.id,
          status: "archived",
          supersededBy: null,
          reason: null,
          actor: { kind: "human" },
          now: NOW,
        });
        const counts = yield* store.counts();
        assert.deepStrictEqual(counts, { active: 1, superseded: 0, archived: 1, pinned: 1 });
      }),
    ),
  );

  it.effect("counts a recall without appending an event", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(record());
        yield* store.markAccessed([created.entry.id], NOW + 5);
        const read = yield* store.get(created.entry.id);
        assert.strictEqual(read.hitCount, 1);
        assert.strictEqual(read.lastAccessedAt, NOW + 5);
        assert.strictEqual((yield* store.history(created.entry.id)).length, 1);
      }),
    ),
  );
});

describe("MemoryStore retrieval", () => {
  it.effect("finds a two-character Chinese query", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(record({ title: "部署前先跑测试", body: "上线之前先在本地跑一遍" }));
        yield* store.create(record({ title: "Caddy 负责 TLS 终结" }));
        assert.strictEqual((yield* search(store, "部署")).length, 1);
        assert.strictEqual((yield* search(store, "测试")).length, 1);
      }),
    ),
  );

  it.effect("still finds a single Chinese character, which the index cannot answer", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(record({ title: "部署前先跑测试" }));
        assert.strictEqual((yield* search(store, "部")).length, 1);
        assert.strictEqual((yield* search(store, "跑")).length, 1);
      }),
    ),
  );

  it.effect("finds ascii words and returns nothing for a miss", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(record({ title: "Caddy terminates TLS" }));
        assert.strictEqual((yield* search(store, "Caddy")).length, 1);
        assert.strictEqual((yield* search(store, "nginx")).length, 0);
      }),
    ),
  );

  it.effect("ranks a title match above a body-only match", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(record({ title: "其他", body: "Caddy 在这里只是顺带提一句" }));
        yield* store.create(record({ title: "Caddy 负责 TLS", body: "无关正文" }));
        const rows = yield* search(store, "Caddy");
        assert.strictEqual(rows[0]?.title, "Caddy 负责 TLS");
      }),
    ),
  );

  it.effect("keeps another project's memories out of a projectless read", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.create(record({ title: "公共事实" }));
        yield* store.create(record({ title: "项目私有", scope: "project", projectId: "proj-1" }));
        assert.strictEqual((yield* search(store, "")).length, 1);
        assert.strictEqual((yield* search(store, "", { projectId: "proj-1" })).length, 2);
        assert.strictEqual((yield* search(store, "", { projectId: "proj-2" })).length, 1);
        assert.strictEqual((yield* search(store, "", { includeAllProjects: true })).length, 2);
      }),
    ),
  );

  it.effect("hides archived, superseded, and expired entries", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const archived = yield* store.create(record({ title: "归档的" }));
        const superseded = yield* store.create(record({ title: "被替代的" }));
        const replacement = yield* store.create(record({ title: "替代者" }));
        yield* store.create(record({ title: "过期的", expiresAt: NOW - 1 }));
        yield* store.setStatus({
          id: archived.entry.id,
          status: "archived",
          supersededBy: null,
          reason: null,
          actor: { kind: "human" },
          now: NOW,
        });
        yield* store.setStatus({
          id: superseded.entry.id,
          status: "superseded",
          supersededBy: replacement.entry.id,
          reason: null,
          actor: { kind: "human" },
          now: NOW,
        });
        const visible = ids(yield* search(store, ""));
        assert.deepStrictEqual(visible, [replacement.entry.id]);
        assert.strictEqual((yield* search(store, "", { includeExpired: true })).length, 2);
      }),
    ),
  );

  it.effect("returns the newest first when there is no query", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const older = yield* store.create(record({ now: NOW - 1_000 }));
        const newer = yield* store.create(record({ now: NOW }));
        assert.deepStrictEqual(ids(yield* search(store, "")), [newer.entry.id, older.entry.id]);
      }),
    ),
  );

  it.effect("rebuilds the index after it has been dropped", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const created = yield* store.create(record({ title: "部署前先跑测试" }));
        const first = yield* store.rebuildIndex();
        assert.strictEqual(first.indexed, 1);
        assert.strictEqual((yield* search(store, "部署")).length, 1);
        assert.strictEqual((yield* store.get(created.entry.id)).title, "部署前先跑测试");
      }),
    ),
  );
});
