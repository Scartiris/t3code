import * as NodeCrypto from "node:crypto";
import {
  type MemoryDocument,
  type MemoryDocumentSummary,
  type MemoryDocumentsListInput,
  type MemoryDocumentsListResult,
  type MemoryDocumentReadInput,
  type MemoryDocumentSaveInput,
  type MemoryDocumentArchiveInput,
  MemoryManagementError,
} from "@t3tools/contracts";
import {
  MemoryId,
  memoryApiFailure,
  type MemoryApiError,
  type MemoryEntry,
} from "@t3tools/memory-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import type { MemoryConnection } from "./MemoryConnection.ts";
import type { MemoryServiceShape } from "./MemoryService.ts";
import { makeOpenVikingClient } from "./OpenVikingClient.ts";

const KNOWLEDGE_ROOT = "viking://~/resources/t3";
const ARCHIVE_ROOT = "viking://~/resources/t3-archive";
const source = { kind: "human" as const };
const PAGE_SIZE = 20;
const summary = (entry: MemoryEntry): MemoryDocumentSummary => ({
  id: entry.id,
  title: entry.title,
  version: String(entry.version),
  kind: entry.kind,
  scope: entry.scope,
  projectId: entry.projectId,
  pinned: entry.pinned,
  tags: entry.tags,
  status: entry.status,
  updatedAt: entry.updatedAt,
});
const document = (entry: MemoryEntry): MemoryDocument => ({ ...summary(entry), body: entry.body });
const hash = (content: string) => NodeCrypto.createHash("sha256").update(content).digest("hex");
const validKnowledgeId = (id: string) => /^kb_[a-z0-9-]+$/u.test(id);
const root = (status: string) => (status === "archived" ? ARCHIVE_ROOT : KNOWLEDGE_ROOT);
const uri = (id: string, status: string) => `${root(status)}/${id}.md`;
const parseKnowledge = (
  id: string,
  status: "active" | "archived" | "superseded",
  raw: string,
): MemoryDocument => {
  const match = /^# ([^\n]+)\n\n([\s\S]*)$/u.exec(raw);
  return {
    id,
    status,
    title: (match?.[1] ?? id).slice(0, 120),
    body: match?.[2] ?? raw,
    version: hash(raw),
    kind: "reference",
    scope: "global",
    projectId: null,
    pinned: false,
    tags: [],
    updatedAt: 0,
  };
};
const mapError = (error: MemoryApiError | { readonly message: string }) =>
  new MemoryManagementError({
    code: "code" in error ? error.code : "unavailable",
    message: "code" in error ? error.message : "Memory configuration could not be loaded.",
  });

class ManagementConnection extends Context.Service<
  ManagementConnection,
  { readonly connection: MemoryConnection; readonly service: MemoryServiceShape }
>()("t3/memory/MemoryManagement/ManagementConnection") {}

/** Uses the runtime's configuration and write lock so clients and agents share one writer. */
export const makeManagement = (
  current: Effect.Effect<
    {
      readonly connection: MemoryConnection | undefined;
      readonly service: MemoryServiceShape | undefined;
    },
    { readonly message: string }
  >,
  writes: Semaphore.Semaphore,
  http: HttpClient.HttpClient,
) => {
  const configured = current.pipe(
    Effect.flatMap((config) =>
      config.service && config.connection
        ? Effect.succeed({ service: config.service, connection: config.connection })
        : Effect.fail(
            memoryApiFailure("unavailable", "Enable memory and configure its connection first."),
          ),
    ),
  );
  const knowledge = Effect.fnUntraced(function* () {
    const { connection } = yield* ManagementConnection;
    if (connection.backend !== "openviking")
      return yield* memoryApiFailure("invalid_request", "The knowledge base requires OpenViking.");
    return yield* makeOpenVikingClient(
      { baseUrl: connection.baseUrl, apiKey: connection.token },
      { readTimeoutMs: 10_000, writeTimeoutMs: 30_000 },
    );
  });
  const checkId = (id: string) =>
    validKnowledgeId(id)
      ? Effect.void
      : Effect.fail(memoryApiFailure("invalid_request", "Invalid knowledge document id."));
  const read = Effect.fnUntraced(function* (input: MemoryDocumentReadInput) {
    if (input.collection === "memory")
      return document(yield* (yield* ManagementConnection).service.get(MemoryId.make(input.id)));
    if (input.status === "superseded")
      return yield* memoryApiFailure(
        "invalid_request",
        "Knowledge documents cannot be superseded.",
      );
    yield* checkId(input.id);
    const client = yield* knowledge();
    const raw = yield* client.readRaw(uri(input.id, input.status));
    if (raw.length > 110_000)
      return yield* memoryApiFailure(
        "invalid_request",
        "This document is too large for the editor.",
      );
    return parseKnowledge(input.id, input.status, raw);
  });
  const list = Effect.fnUntraced(function* (
    input: MemoryDocumentsListInput,
  ): Effect.fn.Return<
    MemoryDocumentsListResult,
    MemoryApiError | { readonly message: string },
    HttpClient.HttpClient | ManagementConnection
  > {
    if (input.collection === "memory") {
      const result = yield* (yield* ManagementConnection).service.search({
        query: input.query,
        status: input.status,
        includeAllProjects: true,
        includeExpired: true,
        includePending: true,
        limit: PAGE_SIZE,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return {
        items: result.items.map((hit) => summary(hit.entry)),
        nextCursor: result.nextCursor,
      };
    }
    if (input.status === "superseded") return { items: [], nextCursor: null };
    const client = yield* knowledge();
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      return yield* memoryApiFailure("invalid_request", "Invalid page cursor.");
    const files = input.query.trim()
      ? (yield* client.findResources(root(input.status), input.query)).map((hit) => ({
          uri: hit.uri,
          isDir: false,
        }))
      : yield* client.list({ uri: root(input.status), tags: [], limit: PAGE_SIZE + 1, offset });
    const page = input.query.trim() ? files.slice(offset, offset + PAGE_SIZE + 1) : files;
    const items = yield* Effect.forEach(
      page.slice(0, PAGE_SIZE),
      (file) => {
        const id = file.uri.split("/").at(-1)?.replace(/\.md$/u, "") ?? "";
        if (file.isDir || !validKnowledgeId(id)) return Effect.succeed(undefined);
        return read({ collection: "knowledge", id, status: input.status }).pipe(
          Effect.map(({ body: _body, ...value }) => value),
        );
      },
      { concurrency: 4 },
    );
    return {
      items: items.filter((item) => item !== undefined),
      nextCursor: page.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    };
  });
  const save = Effect.fnUntraced(function* (input: MemoryDocumentSaveInput) {
    if (input.id && !input.expectedVersion)
      return yield* memoryApiFailure("invalid_request", "Read the document before editing it.");
    if (input.collection === "memory") {
      const service = (yield* ManagementConnection).service;
      const fields = {
        title: input.title,
        body: input.body,
        kind: input.kind,
        scope: input.scope,
        projectId: input.projectId,
        tags: input.tags,
        pinned: input.pinned,
      };
      if (input.id) {
        const expectedVersion = Number(input.expectedVersion);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
          return yield* memoryApiFailure("invalid_request", "Invalid memory version.");
        return document(
          yield* service.update(
            { ...fields, id: MemoryId.make(input.id), expectedVersion },
            source,
          ),
        );
      }
      const result = (yield* service.remember({ entries: [fields] }, source)).results[0];
      if (!result?.ok || !result.entry)
        return yield* memoryApiFailure(
          result?.error?.code ?? "internal",
          result?.error?.message ?? "Memory was not saved.",
        );
      return document(result.entry);
    }
    if (input.status === "superseded")
      return yield* memoryApiFailure(
        "invalid_request",
        "Knowledge documents cannot be superseded.",
      );
    const id = input.id ?? `kb_${NodeCrypto.randomUUID()}`;
    yield* checkId(id);
    const client = yield* knowledge();
    if (input.id) {
      const previous = yield* read({ collection: "knowledge", id, status: input.status });
      if (previous.version !== input.expectedVersion)
        return yield* memoryApiFailure(
          "conflict",
          "This document changed. Reload it before saving.",
        );
    }
    yield* client.mkdir(root(input.status));
    yield* client.write({
      uri: uri(id, input.status),
      content: `# ${input.title.replace(/\s+/gu, " ")}\n\n${input.body}`,
      mode: input.id ? "replace" : "create",
      tags: [],
    });
    return yield* read({ collection: "knowledge", id, status: input.status });
  });
  const archive = Effect.fnUntraced(function* (input: MemoryDocumentArchiveInput) {
    const previous = yield* read(input);
    if (previous.version !== input.expectedVersion)
      return yield* memoryApiFailure(
        "conflict",
        "This document changed. Reload it before changing its status.",
      );
    if (input.collection === "memory") {
      const service = (yield* ManagementConnection).service;
      if (input.archived)
        yield* service.forget(
          { id: MemoryId.make(input.id), reason: "Archived in settings" },
          source,
        );
      else yield* service.restore(MemoryId.make(input.id), source);
    } else {
      const next = input.archived ? "archived" : "active";
      if (input.status !== next) {
        const client = yield* knowledge();
        yield* client.mkdir(root(next));
        yield* client.move(uri(input.id, input.status), uri(input.id, next));
      }
    }
    return yield* read({ ...input, status: input.archived ? "archived" : "active" });
  });
  const finish = <A>(
    effect: Effect.Effect<
      A,
      MemoryApiError | { readonly message: string },
      HttpClient.HttpClient | ManagementConnection
    >,
  ) =>
    effect.pipe(
      Effect.provideServiceEffect(ManagementConnection, configured),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.mapError(mapError),
    );
  return {
    listDocuments: (input: MemoryDocumentsListInput) => finish(list(input)),
    readDocument: (input: MemoryDocumentReadInput) => finish(read(input)),
    saveDocument: (input: MemoryDocumentSaveInput) => writes.withPermit(finish(save(input))),
    archiveDocument: (input: MemoryDocumentArchiveInput) =>
      writes.withPermit(finish(archive(input))),
  };
};
