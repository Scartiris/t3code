import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import type { MemoryDocumentSaveInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ServerSettings from "../serverSettings.ts";
import { make } from "./MemoryRuntime.ts";

const deployment = {
  connection: {
    backend: "openviking" as const,
    baseUrl: "http://viking.test",
    token: "a".repeat(40),
  },
};
const decodeKnowledgeWrite = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ content: Schema.String })),
);
const input = (
  collection: "memory" | "knowledge",
  patch: Partial<MemoryDocumentSaveInput> = {},
): MemoryDocumentSaveInput => ({
  collection,
  status: "active",
  title: "部署说明",
  body: "先检查再发布。",
  kind: collection === "memory" ? "decision" : "reference",
  scope: "global",
  projectId: null,
  pinned: false,
  tags: [],
  ...patch,
});
const fixture = () => {
  const files = new Map<string, { content: string; tags: readonly string[] }>();
  const seen: Array<{ path: string; uri: string; body: Record<string, unknown> }> = [];
  const directories = new Set<string>();
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    const body: Record<string, unknown> =
      init?.body == null ? {} : JSON.parse(await new Response(init.body).text());
    const uri = String(body.uri ?? target.searchParams.get("uri") ?? "");
    seen.push({ path: target.pathname, uri, body });
    const ok = (result: unknown) => Response.json({ status: "ok", result });
    const fail = (code: string, status: number) =>
      Response.json({ status: "error", error: { code } }, { status });
    if (target.pathname === "/api/v1/fs/mkdir") {
      if (directories.has(uri)) return fail("ALREADY_EXISTS", 409);
      directories.add(uri);
      return ok({ uri });
    }
    if (target.pathname === "/api/v1/content/read")
      return files.has(uri) ? ok(files.get(uri)!.content) : fail("NOT_FOUND", 404);
    if (target.pathname === "/api/v1/content/write") {
      if (body.mode === "create" && files.has(uri)) return fail("ALREADY_EXISTS", 409);
      assert.equal(body.wait, true);
      assert.equal(body.processing_mode, "vectors_only");
      files.set(uri, { content: String(body.content), tags: body.tags as readonly string[] });
      return ok({ content_updated: true, vector_status: "complete" });
    }
    if (target.pathname === "/api/v1/fs/mv") {
      const from = String(body.from_uri),
        to = String(body.to_uri);
      if (!files.has(from)) return fail("NOT_FOUND", 404);
      if (files.has(to)) return fail("ALREADY_EXISTS", 409);
      files.set(to, files.get(from)!);
      files.delete(from);
      return ok({ from, to });
    }
    if (target.pathname === "/api/v1/fs/ls") {
      const tags = target.searchParams.getAll("tags");
      const matches = [...files].filter(
        ([path, file]) =>
          path.startsWith(uri + "/") && tags.every((tag) => file.tags.includes(tag)),
      );
      const offset = Number(target.searchParams.get("offset")),
        limit = Number(target.searchParams.get("limit"));
      return ok(matches.slice(offset, offset + limit).map(([uri]) => ({ uri, isDir: false })));
    }
    assert.equal(target.pathname, "/api/v1/search/find");
    const tags = (body.tags ?? []) as string[];
    const matches = [...files].filter(
      ([path, file]) =>
        path.startsWith(String(body.target_uri) + "/") &&
        tags.every((tag) => file.tags.includes(tag)),
    );
    const hits = matches.map(([uri]) => ({ uri, score: 0.9, level: 2 }));
    return ok(body.context_type === "resource" ? { resources: hits } : { memories: hits });
  };
  return {
    files,
    seen,
    layer: FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
  };
};

describe("OpenViking document management", () => {
  it.effect("keeps an in-flight edit on one backend when connection settings change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let raw = "# 部署说明\n\n先检查再发布。";
        const version = NodeCrypto.createHash("sha256").update(raw).digest("hex");
        let firstRead = true;
        const urls: string[] = [];
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            urls.push(request.url);
            const path = new URL(request.url).pathname;
            let result: unknown = {};
            if (path === "/api/v1/content/read") {
              if (firstRead) {
                firstRead = false;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              result = raw;
            } else if (path === "/api/v1/content/write") {
              assert.equal(request.body._tag, "Uint8Array");
              if (request.body._tag === "Uint8Array") {
                const body = decodeKnowledgeWrite(new TextDecoder().decode(request.body.body));
                raw = body.content;
              }
              result = { content_updated: true, vector_status: "complete" };
            }
            return HttpClientResponse.fromWeb(request, Response.json({ status: "ok", result }));
          }),
        );
        const runtime = yield* make(deployment).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        const store = yield* ServerSettings.ServerSettingsService;
        const saving = yield* runtime.management
          .saveDocument(
            input("knowledge", { id: "kb_test", expectedVersion: version, body: "保留回退版本。" }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* store.updateSettings({
          memory: { enabled: true, baseUrl: "http://other.test", apiKey: "b".repeat(40) },
        });
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(saving)).body, "保留回退版本。");
        assert.isTrue(urls.every((url) => url.startsWith("http://viking.test/")));
        yield* runtime.management.readDocument({
          collection: "knowledge",
          id: "kb_test",
          status: "active",
        });
        assert.isTrue(urls.at(-1)?.startsWith("http://other.test/"));
      }),
    ).pipe(Effect.provide(ServerSettings.layerTest())),
  );
  it.effect(
    "edits existing agent memories with human provenance, version checks and reversible archive",
    () => {
      const backend = fixture();
      return Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* make(deployment);
          const api = runtime.management;
          const created = yield* api.saveDocument(
            input("memory", { pinned: true, tags: ["发布"] }),
          );
          const page = yield* api.listDocuments({
            collection: "memory",
            query: "",
            status: "active",
          });
          assert.equal(page.items[0]?.title, created.title);
          assert.isFalse("body" in page.items[0]!);
          const read = yield* api.readDocument({
            collection: "memory",
            id: created.id,
            status: "active",
          });
          const updated = yield* api.saveDocument(
            input("memory", {
              id: read.id,
              expectedVersion: read.version,
              body: "保留回退版本。",
              pinned: true,
              tags: ["发布"],
            }),
          );
          assert.equal(updated.version, "2");
          assert.equal(updated.body, "保留回退版本。");
          const conflict = yield* api
            .saveDocument(input("memory", { id: read.id, expectedVersion: read.version }))
            .pipe(Effect.result);
          assert.equal(conflict._tag, "Failure");
          if (conflict._tag === "Failure") assert.equal(conflict.failure.code, "conflict");
          const archived = yield* api.archiveDocument({
            collection: "memory",
            id: updated.id,
            expectedVersion: updated.version,
            status: "active",
            archived: true,
          });
          assert.equal(
            (yield* api.listDocuments({ collection: "memory", query: "", status: "active" })).items
              .length,
            0,
          );
          const restored = yield* api.archiveDocument({
            collection: "memory",
            id: archived.id,
            expectedVersion: archived.version,
            status: "archived",
            archived: false,
          });
          assert.equal(restored.status, "active");
          assert.equal(
            (yield* runtime.service.get(restored.id as Parameters<typeof runtime.service.get>[0]))
              .source.kind,
            "human",
          );
        }),
      ).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest(), backend.layer)));
    },
  );

  it.effect(
    "creates, reads, searches, edits and restores knowledge separately from memories",
    () => {
      const backend = fixture();
      return Effect.scoped(
        Effect.gen(function* () {
          const api = (yield* make(deployment)).management;
          const created = yield* api.saveDocument(input("knowledge"));
          const updated = yield* api.saveDocument(
            input("knowledge", {
              id: created.id,
              expectedVersion: created.version,
              title: "上线流程",
              body: "先验证，再备份，再发布。",
            }),
          );
          assert.notEqual(updated.version, created.version);
          assert.equal(updated.title, "上线流程");
          const writes = backend.seen.filter(
            (request) => request.path === "/api/v1/content/write",
          ).length;
          const conflict = yield* api
            .saveDocument(input("knowledge", { id: created.id, expectedVersion: created.version }))
            .pipe(Effect.result);
          assert.equal(conflict._tag, "Failure");
          if (conflict._tag === "Failure") assert.equal(conflict.failure.code, "conflict");
          assert.equal(
            backend.seen.filter((request) => request.path === "/api/v1/content/write").length,
            writes,
          );
          const search = yield* api.listDocuments({
            collection: "knowledge",
            query: "发布",
            status: "active",
          });
          assert.equal(search.items[0]?.id, created.id);
          assert.equal(
            backend.seen.find((request) => request.path === "/api/v1/search/find")?.body
              .context_type,
            "resource",
          );
          assert.equal(
            (yield* api.listDocuments({ collection: "memory", query: "", status: "active" })).items
              .length,
            0,
          );
          const archived = yield* api.archiveDocument({
            collection: "knowledge",
            id: updated.id,
            expectedVersion: updated.version,
            status: "active",
            archived: true,
          });
          assert.equal(
            (yield* api.listDocuments({ collection: "knowledge", query: "", status: "active" }))
              .items.length,
            0,
          );
          assert.equal(
            (yield* api.listDocuments({ collection: "knowledge", query: "", status: "archived" }))
              .items[0]?.id,
            archived.id,
          );
          const restored = yield* api.archiveDocument({
            collection: "knowledge",
            id: archived.id,
            expectedVersion: archived.version,
            status: "archived",
            archived: false,
          });
          assert.equal(restored.body, updated.body);
          assert.equal(
            (yield* api.listDocuments({ collection: "knowledge", query: "", status: "active" }))
              .items.length,
            1,
          );
        }),
      ).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest(), backend.layer)));
    },
  );

  it.effect("pages knowledge without sending document bodies in list responses", () => {
    const backend = fixture();
    for (let index = 0; index < 23; index++)
      backend.files.set(`viking://~/resources/t3/kb_${index}.md`, {
        content: `# 文档 ${index}\n\n正文`,
        tags: [],
      });
    return Effect.scoped(
      Effect.gen(function* () {
        const api = (yield* make(deployment)).management;
        const first = yield* api.listDocuments({
          collection: "knowledge",
          query: "",
          status: "active",
        });
        assert.equal(first.items.length, 20);
        assert.equal(first.nextCursor, "20");
        const second = yield* api.listDocuments({
          collection: "knowledge",
          query: "",
          status: "active",
          cursor: first.nextCursor!,
        });
        assert.equal(second.items.length, 3);
        assert.isNull(second.nextCursor);
        assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 23);
        assert.isFalse("body" in first.items[0]!);
      }),
    ).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest(), backend.layer)));
  });

  it.effect("rejects outside paths and unversioned updates before making backend requests", () => {
    const backend = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const api = (yield* make(deployment)).management;
        for (const id of ["../memories/t3/file", "viking://user/other/resources/x", "kb_a/../b"]) {
          const result = yield* api
            .readDocument({ collection: "knowledge", id, status: "active" })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure.code, "invalid_request");
        }
        assert.equal(
          (yield* api.saveDocument(input("knowledge", { id: "kb_existing" })).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        assert.equal(backend.seen.length, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest(), backend.layer)));
  });

  it.effect("follows connection settings and stops management requests when disabled", () => {
    const backend = fixture();
    return Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* make(deployment);
        const store = yield* ServerSettings.ServerSettingsService;
        yield* store.updateSettings({ memory: { enabled: false } });
        assert.equal(
          (yield* runtime.management
            .listDocuments({ collection: "knowledge", query: "", status: "active" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(backend.seen.length, 0);
        yield* store.updateSettings({
          memory: {
            enabled: true,
            backend: "protocol",
            baseUrl: "http://viking.test",
            apiKey: "b".repeat(40),
          },
        });
        const result = yield* runtime.management
          .listDocuments({ collection: "knowledge", query: "", status: "active" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "invalid_request");
        assert.equal(backend.seen.length, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(ServerSettings.layerTest(), backend.layer)));
  });
});
