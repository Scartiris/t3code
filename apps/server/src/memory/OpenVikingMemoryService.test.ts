import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import {
  MemoryId,
  type MemoryEntry,
  type MemoryCreateInput,
  type MemorySource,
} from "@t3tools/memory-protocol";

import { make } from "./OpenVikingMemoryService.ts";
import * as MemoryService from "./MemoryService.ts";
import {
  memoryRevisions,
  memoryTags,
  memoryUri,
  parseMemoryFile,
  renderMemoryFile,
} from "./OpenVikingMemory.ts";

const source: MemorySource = { kind: "agent", threadId: "thread-1", agent: "codex" };
const connection = { baseUrl: "http://openviking.test", apiKey: "t".repeat(40) };
const input: MemoryCreateInput = {
  title: "部署约定",
  body: "先测试再部署。",
  kind: "decision",
  scope: "global",
};
const entry = (id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...input,
  id: MemoryId.make(id),
  version: 1,
  projectId: null,
  tags: [],
  pinned: false,
  importance: 0.5,
  status: "active",
  supersededBy: null,
  expiresAt: null,
  dedupeKey: null,
  reviewState: "accepted",
  source,
  hitCount: 0,
  lastAccessedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

/** In-memory REST fixture; exercises the real HTTP decoder and adapter together. */
const fixture = (seed: ReadonlyArray<MemoryEntry> = []) => {
  const files = new Map(
    seed.map((entry) => [
      memoryUri(entry.id),
      { content: renderMemoryFile(entry), tags: memoryTags(entry) },
    ]),
  );
  const seen: Array<{ url: URL; body: Record<string, unknown>; headers: Headers }> = [];
  let override: ((url: URL) => Response | undefined) | undefined;
  let findUris: ReadonlyArray<string> | undefined;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const requestUrl = new URL(String(url));
    const body: Record<string, unknown> =
      init?.body == null ? {} : JSON.parse(await new Response(init.body).text());
    seen.push({ url: requestUrl, body, headers: new Headers(init?.headers) });
    const custom = override?.(requestUrl);
    if (custom !== undefined) return custom;
    const ok = (result: unknown) => Response.json({ status: "ok", result });
    const missing = () =>
      Response.json({ status: "error", error: { code: "NOT_FOUND" } }, { status: 404 });
    if (requestUrl.pathname === "/api/v1/content/read") {
      assert.equal(requestUrl.searchParams.get("raw"), "true");
      const file = files.get(requestUrl.searchParams.get("uri") ?? "");
      return file === undefined ? missing() : ok(file.content);
    }
    if (requestUrl.pathname === "/api/v1/content/write") {
      const uri = String(body.uri);
      if (body.mode === "create" && files.has(uri))
        return Response.json(
          { status: "error", error: { code: "ALREADY_EXISTS" } },
          { status: 409 },
        );
      if (body.mode === "replace" && !files.has(uri)) return missing();
      assert.equal(body.processing_mode, "vectors_only");
      assert.equal(body.wait, true);
      assert.equal(body.tag_mode, "replace");
      const requested = String(body.content);
      const pattern = /<!--\s*MEMORY_FIELDS\s*\n([\s\S]*?)\n-->/gu;
      // Native memory writes normalize creates and append preserved metadata on
      // replacement, rather than replacing the whole raw markdown file.
      const metadata = [
        ...(body.mode === "create" ? requested : files.get(uri)!.content).matchAll(pattern),
      ][0]?.[1];
      const visible = body.mode === "create" ? requested.replace(pattern, "").trim() : requested;
      files.set(uri, {
        content: `${visible}\n\n<!-- MEMORY_FIELDS\n${metadata}\n-->`,
        tags: body.tags as Array<string>,
      });
      return ok({ uri, content_updated: true, vector_status: "complete" });
    }
    const tags =
      requestUrl.pathname === "/api/v1/fs/ls"
        ? requestUrl.searchParams.getAll("tags")
        : (body.tags as Array<string>);
    const matches = [...files].filter(([, file]) => tags.every((tag) => file.tags.includes(tag)));
    if (requestUrl.pathname === "/api/v1/fs/ls") {
      const offset = Number(requestUrl.searchParams.get("offset"));
      const limit = Number(requestUrl.searchParams.get("limit"));
      return ok(
        matches
          .slice(offset, offset + limit)
          .map(([uri, file]) => ({ uri, isDir: false, tags: file.tags })),
      );
    }
    assert.equal(requestUrl.pathname, "/api/v1/search/find");
    assert.equal(body.level, 2);
    assert.equal(body.context_type, "memory");
    return ok({
      memories: (findUris ?? matches.map(([uri]) => uri)).map((uri) => ({
        uri,
        score: 0.8,
        level: 2,
      })),
    });
  };
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return {
    files,
    seen,
    layer,
    layerFetch: fetch,
    failWith: (fn: typeof override) => {
      override = fn;
    },
    findOnly: (uris: ReadonlyArray<string>) => {
      findUris = uris;
    },
  };
};

const service = make(connection, { readTimeoutMs: 2500, writeTimeoutMs: 5000 });

describe("OpenViking memory", () => {
  it.effect(
    "selects OpenViking in the shared service layer used by tools and provider sessions",
    () => {
      const env = fixture([entry("mem_existing")]);
      return Effect.gen(function* () {
        const api = yield* MemoryService.MemoryService;
        assert.equal((yield* api.search({})).total, 1);
        assert.equal(env.seen[0]?.url.pathname, "/api/v1/fs/ls");
      }).pipe(
        Effect.provide(
          MemoryService.layer({
            backend: "openviking",
            baseUrl: connection.baseUrl,
            token: connection.apiKey,
          }).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, env.layerFetch))),
        ),
      );
    },
  );
  it.effect(
    "round-trips Unicode, multiline text and metadata without losing migration fields",
    () => {
      const original = entry("mem_中文", {
        title: "标题\n两行",
        body: "中文正文\n\n<!-- MEMORY_FIELDS\n{}\n-->\n结尾 -->",
        hitCount: 23,
        lastAccessedAt: 12,
        reviewState: "pending",
      });
      assert.deepStrictEqual(parseMemoryFile(renderMemoryFile(original)), original);
      const env = fixture([original]);
      return Effect.gen(function* () {
        const api = yield* service;
        const found = yield* api.search({ includePending: true });
        assert.deepStrictEqual(found.items[0]?.entry, original);
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "deduplicates concurrent writes, supports partial batches and keeps archived duplicates",
    () => {
      const env = fixture();
      return Effect.gen(function* () {
        const api = yield* service;
        const batch = { entries: [{ ...input, dedupeKey: "deploy" }] };
        const results = yield* Effect.all(
          [api.remember(batch, source), api.remember(batch, source)],
          { concurrency: 2 },
        );
        const id = results[0].results[0]?.entry?.id;
        assert.isDefined(id);
        assert.equal(results[1].results[0]?.entry?.id, id);
        assert.equal(env.files.size, 1);
        yield* api.forget({ id: id! }, source);
        const retry = yield* api.remember(batch, source);
        assert.equal(retry.results[0]?.entry?.status, "archived");
        const partial = yield* api.remember(
          { entries: [input, { ...input, scope: "project" }] },
          source,
        );
        assert.equal(partial.results[0]?.ok, true);
        assert.equal(partial.results[1]?.error?.code, "invalid_request");
        assert.isTrue(
          env.seen.every(
            (call) => call.headers.get("authorization") === `Bearer ${connection.apiKey}`,
          ),
        );
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "serializes version checks and preserves archive, supersession and restore history",
    () => {
      const original = entry("mem_original", { dedupeKey: "a" });
      const replacement = entry("mem_replacement", { dedupeKey: "b" });
      const env = fixture([original, replacement]);
      return Effect.gen(function* () {
        const api = yield* service;
        const results = yield* Effect.all(
          ["first", "second"].map((title) =>
            api.update({ id: original.id, expectedVersion: 1, title }, source).pipe(Effect.result),
          ),
          { concurrency: 2 },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(
          results.filter(
            (result) => result._tag === "Failure" && result.failure.code === "conflict",
          ).length,
          1,
        );
        const collision = yield* api
          .update({ id: original.id, dedupeKey: "b" }, source)
          .pipe(Effect.flip);
        assert.equal(collision.code, "conflict");
        const scope = yield* api
          .update({ id: original.id, scope: "project" }, source)
          .pipe(Effect.flip);
        assert.equal(scope.code, "invalid_request");
        const self = yield* api
          .forget({ id: original.id, supersededBy: original.id }, source)
          .pipe(Effect.flip);
        assert.equal(self.code, "invalid_request");
        yield* api.forget(
          { id: original.id, supersededBy: replacement.id, reason: "纠正" },
          source,
        );
        assert.equal((yield* api.search({})).total, 1);
        yield* api.restore(original.id, source);
        const restored = (yield* api.search({})).items.find(
          (hit) => hit.entry.id === original.id,
        )?.entry;
        assert.equal(restored?.version, 4);
        assert.isNull(restored?.supersededBy);
        const revisions = memoryRevisions(env.files.get(memoryUri(original.id))!.content);
        assert.deepStrictEqual(
          revisions.map((revision) => revision.entry.version),
          [1, 2, 3],
        );
        assert.equal(revisions[1]?.reason, "纠正");
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "checks raw-file visibility despite stale search tags and filters expiry, pending, kind and tags",
    () => {
      const all = [
        entry("mem_global"),
        entry("mem_a", { scope: "project", projectId: "A", tags: ["部署"], kind: "fact" }),
        entry("mem_b", { scope: "project", projectId: "B" }),
        entry("mem_expired", { expiresAt: 0 }),
        entry("mem_pending", { reviewState: "pending" }),
        entry("mem_archived", { status: "archived" }),
      ];
      const env = fixture(all);
      env.findOnly(all.map((entry) => memoryUri(entry.id)));
      return Effect.gen(function* () {
        const api = yield* service;
        assert.deepStrictEqual(
          (yield* api.search({ query: "部署" })).items.map((hit) => hit.entry.id),
          ["mem_global"],
        );
        assert.equal((yield* api.search({ query: "部署", projectId: "A" })).total, 2);
        assert.deepStrictEqual(
          (yield* api.search({
            query: "部署",
            projectId: "A",
            kinds: ["fact"],
            tags: ["不存在", "部署"],
          })).items.map((hit) => hit.entry.id),
          ["mem_a"],
        );
        assert.equal(
          (yield* api.search({
            query: "部署",
            includeAllProjects: true,
            includeExpired: true,
            includePending: true,
          })).total,
          5,
        );
        assert.equal((yield* api.search({ status: "archived" })).total, 1);
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "pages listings beyond 100 files and sorts recent results independently of importance",
    () => {
      const all = Array.from({ length: 105 }, (_, i) =>
        entry(`mem_${String(i).padStart(3, "0")}`, { updatedAt: i, importance: i === 0 ? 1 : 0 }),
      );
      const env = fixture(all);
      return Effect.gen(function* () {
        const api = yield* service;
        const page = yield* api.search({ limit: 2 });
        assert.equal(page.total, 105);
        assert.deepStrictEqual(
          page.items.map((hit) => hit.entry.id),
          ["mem_104", "mem_103"],
        );
        assert.equal(page.nextCursor, "2");
        const next = yield* api.search({ limit: 2, cursor: page.nextCursor! });
        assert.equal(next.items[0]?.entry.id, "mem_102");
        assert.equal(
          (yield* api.search({ cursor: "-1" }).pipe(Effect.flip)).code,
          "invalid_request",
        );
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect(
    "injects pinned memories independently of vector hits and honors small context budgets",
    () => {
      const pinned = entry("mem_pinned", { pinned: true, body: "固定偏好" });
      const related = entry("mem_related", { body: "当前问题相关" });
      const env = fixture([pinned, related]);
      env.findOnly([memoryUri(related.id)]);
      return Effect.gen(function* () {
        const api = yield* service;
        const first = yield* api.context({ query: "部署" });
        assert.include(first.text, "固定偏好");
        assert.include(first.text, "当前问题相关");
        assert.equal(first.text, (yield* api.context({ query: "部署" })).text);
        for (const maxChars of [1, 35, 100, 2000]) {
          const context = yield* api.context({ query: "部署", maxChars });
          assert.isAtMost(context.chars, maxChars);
          assert.equal(context.chars, context.text.length);
          if (!context.empty) assert.match(context.text, /- \[.*\n<\/t3_memory>$/u);
        }
        const unpinned = yield* api.context({ query: "部署", includePinned: false });
        assert.notInclude(unpinned.text, "固定偏好");
      }).pipe(Effect.provide(env.layer));
    },
  );

  it.effect("maps non-JSON HTTP failures and corrupt files to actionable errors", () => {
    const env = fixture([entry("mem_broken")]);
    return Effect.gen(function* () {
      const api = yield* service;
      env.failWith(() => new Response("Unauthorized", { status: 401 }));
      assert.equal((yield* api.search({}).pipe(Effect.flip)).code, "unauthorized");
      env.failWith(() => new Response("Unavailable", { status: 503 }));
      assert.equal((yield* api.search({}).pipe(Effect.flip)).code, "unavailable");
      env.failWith((url) =>
        url.pathname === "/api/v1/content/write"
          ? Response.json({
              status: "ok",
              result: { content_updated: true, vector_status: "failed" },
            })
          : undefined,
      );
      assert.equal(
        (yield* api.remember({ entries: [input] }, source)).results[0]?.error?.code,
        "unavailable",
      );
      env.failWith(undefined);
      env.files.get(memoryUri(MemoryId.make("mem_broken")))!.content = "invalid";
      assert.equal((yield* api.search({}).pipe(Effect.flip)).code, "internal");
    }).pipe(Effect.provide(env.layer));
  });

  it.effect("bounds retrieval time even when the backend never responds", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const layer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      const api = yield* service.pipe(Effect.provide(layer));
      const pending = yield* api.context({}).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("2501 millis");
      assert.equal((yield* Fiber.join(pending)).code, "unavailable");
    }),
  );
});
