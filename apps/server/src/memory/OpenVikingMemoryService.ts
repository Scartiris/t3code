import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  MEMORY_CONTEXT_MAX_CHARS_DEFAULT,
  MEMORY_CONTEXT_PINNED_LIMIT,
  MEMORY_LIMIT_DEFAULT,
  MemoryBatchCreateInput,
  type MemoryApiError,
  MemoryContextInput,
  MemoryForgetToolInput,
  MemoryEntry,
  MemoryId,
  MemorySearchInput,
  MemoryUpdateToolInput,
  memoryApiFailure,
  type MemoryCreateInput,
  type MemorySource,
} from "@t3tools/memory-protocol";

import { makeOpenVikingClient, type OpenVikingConnection } from "./OpenVikingClient.ts";
import {
  OPENVIKING_MEMORY_ROOT,
  dedupeTags,
  isRecallable,
  memoryTags,
  memoryRevisions,
  memoryUri,
  parseMemoryFile,
  rankCandidates,
  recallTagSets,
  renderContextBlock,
  renderMemoryFile,
  scopeProblem,
  type Candidate,
} from "./OpenVikingMemory.ts";
import type { MemoryServiceShape } from "./MemoryService.ts";

/** Adapts the workbench's memory tools and session context to one OpenViking user. */
export const make = (
  connection: OpenVikingConnection,
  options: {
    readonly readTimeoutMs: number;
    readonly writeTimeoutMs: number;
  },
) =>
  Effect.gen(function* () {
    const client = yield* makeOpenVikingClient(connection, options);
    // OpenViking 0.5 has no version-conditional writes. This user namespace has
    // one workbench writer; serialize its read/modify/write operations together.
    const writes = yield* Semaphore.make(1);
    const validate = <A>(schema: Schema.Decoder<A>, input: unknown) =>
      Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.mapError(() => memoryApiFailure("invalid_request", "Invalid memory input.")),
      );

    const read = Effect.fnUntraced(function* (uri: string) {
      const raw = yield* client.readRaw(uri);
      const entry = parseMemoryFile(raw);
      if (entry === undefined || !uri.endsWith(`/${encodeURIComponent(entry.id)}.md`)) {
        return yield* memoryApiFailure("internal", "The memory file is invalid.");
      }
      return entry;
    });

    const listed = Effect.fnUntraced(function* (tags: ReadonlyArray<string>) {
      const files: Array<string> = [];
      let offset = 0;
      while (true) {
        const page = yield* client.list({ uri: OPENVIKING_MEMORY_ROOT, tags, limit: 100, offset });
        files.push(
          ...page.filter((file) => !file.isDir && file.uri.endsWith(".md")).map((file) => file.uri),
        );
        if (page.length < 100) break;
        offset += page.length;
      }
      return files;
    });

    const write = Effect.fnUntraced(function* (
      entry: MemoryEntry,
      mode: "create" | "replace",
      reason?: string,
    ) {
      const previous = mode === "replace" ? yield* client.readRaw(memoryUri(entry.id)) : undefined;
      const old = previous === undefined ? undefined : parseMemoryFile(previous);
      const revisions =
        previous === undefined
          ? []
          : [
              ...memoryRevisions(previous),
              ...(old === undefined
                ? []
                : [
                    {
                      entry: old,
                      actor: entry.source,
                      ...(reason === undefined ? {} : { reason }),
                    },
                  ]),
            ];
      yield* client.write({
        uri: memoryUri(entry.id),
        content: renderMemoryFile(entry, revisions),
        mode,
        tags: memoryTags(entry),
      });
    });

    const duplicate = Effect.fnUntraced(function* (input: MemoryCreateInput) {
      if (input.dedupeKey == null) return undefined;
      const files = yield* listed(
        dedupeTags(input.scope, input.projectId ?? null, input.dedupeKey),
      );
      for (const uri of files) {
        const entry = yield* read(uri);
        if (
          entry.scope === input.scope &&
          entry.projectId === (input.projectId ?? null) &&
          entry.dedupeKey === input.dedupeKey
        )
          return entry;
      }
      return undefined;
    });

    const create = Effect.fnUntraced(function* (input: MemoryCreateInput, source: MemorySource) {
      const problem = scopeProblem(input.scope, input.projectId ?? null);
      if (problem !== undefined) return yield* memoryApiFailure("invalid_request", problem);
      const existing = yield* duplicate(input);
      if (existing !== undefined) return existing;
      const now = yield* Clock.currentTimeMillis;
      const entry: MemoryEntry = {
        ...input,
        id: MemoryId.make(`mem_${NodeCrypto.randomUUID()}`),
        version: 1,
        projectId: input.projectId ?? null,
        tags: [...new Set(input.tags ?? [])],
        pinned: input.pinned ?? false,
        importance: input.importance ?? 0.5,
        status: "active",
        supersededBy: null,
        expiresAt: input.expiresAt ?? null,
        dedupeKey: input.dedupeKey ?? null,
        reviewState: "accepted",
        source: input.source ?? source,
        hitCount: 0,
        lastAccessedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* write(entry, "create");
      return entry;
    });

    const candidates = Effect.fnUntraced(function* (input: MemorySearchInput) {
      const now = yield* Clock.currentTimeMillis;
      const query = input.query?.trim() ?? "";
      const groups = yield* Effect.forEach(
        recallTagSets(input),
        (tags) =>
          query.length === 0
            ? listed(tags).pipe(Effect.map((uris) => uris.map((uri) => ({ uri, score: 0 }))))
            : client
                .find({ uri: OPENVIKING_MEMORY_ROOT, query, tags, limit: 200 })
                .pipe(
                  Effect.map((matches) =>
                    matches.map((match) => ({ uri: match.uri, score: match.score ?? 0 })),
                  ),
                ),
        { concurrency: 2 },
      );
      const scores = new Map<string, number>();
      for (const match of groups.flat())
        scores.set(match.uri, Math.max(scores.get(match.uri) ?? 0, match.score ?? 0));
      const entries = yield* Effect.forEach(
        [...scores],
        ([uri, relevance]) =>
          read(uri).pipe(
            Effect.map((entry): Candidate | undefined =>
              isRecallable(entry, input, now) ? { entry, relevance } : undefined,
            ),
            // A concurrent archive/removal is a stale hit. Corruption and outages stay visible.
            Effect.catchIf(
              (error) => error.code === "not_found",
              () => Effect.succeed(undefined),
            ),
          ),
        { concurrency: 8 },
      );
      return entries.filter((entry): entry is Candidate => entry !== undefined);
    });

    const search = Effect.fnUntraced(function* (raw: MemorySearchInput) {
      const input = yield* validate(MemorySearchInput, raw);
      const offset = input.cursor === undefined ? 0 : Number(input.cursor);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (input.cursor !== undefined && !/^\d+$/u.test(input.cursor))
      ) {
        return yield* memoryApiFailure("invalid_request", "Invalid memory cursor.");
      }
      const matches = yield* candidates(input);
      const now = yield* Clock.currentTimeMillis;
      const ranked = rankCandidates(matches, input.query?.trim() ?? "", now);
      const limit = input.limit ?? MEMORY_LIMIT_DEFAULT;
      return {
        items: ranked.slice(offset, offset + limit),
        total: ranked.length,
        nextCursor: offset + limit < ranked.length ? String(offset + limit) : null,
      };
    });

    const context = Effect.fnUntraced(function* (raw: MemoryContextInput) {
      const input = yield* validate(MemoryContextInput, raw);
      const pinned =
        input.includePinned === false
          ? []
          : (yield* search({
              ...input,
              query: "",
              pinnedOnly: true,
              limit: MEMORY_CONTEXT_PINNED_LIMIT,
            })).items.map((hit) => hit.entry);
      const hits = (yield* search({ ...input, limit: input.limit ?? 8 })).items;
      const rendered = renderContextBlock({
        pinned,
        hits,
        maxChars: input.maxChars ?? MEMORY_CONTEXT_MAX_CHARS_DEFAULT,
        hitsAreQueryMatches: (input.query?.trim().length ?? 0) > 0,
      });
      return { ...rendered, pinned, hits, empty: rendered.text.length === 0 };
    });

    const update = Effect.fnUntraced(function* (
      raw: Parameters<MemoryServiceShape["update"]>[0],
      source: MemorySource,
    ) {
      const input = yield* validate(MemoryUpdateToolInput, raw);
      const current = yield* read(memoryUri(input.id));
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        return yield* memoryApiFailure(
          "conflict",
          "The memory changed. Read it again before retrying.",
          { version: current.version },
        );
      }
      const { id: _id, expectedVersion: _expected, ...patch } = input;
      const entry = yield* validate(MemoryEntry, {
        ...current,
        ...patch,
        source,
        version: current.version + 1,
        updatedAt: yield* Clock.currentTimeMillis,
      });
      const problem = scopeProblem(entry.scope, entry.projectId);
      if (problem !== undefined) return yield* memoryApiFailure("invalid_request", problem);
      const existing = yield* duplicate(entry);
      if (existing !== undefined && existing.id !== entry.id)
        return yield* memoryApiFailure("conflict", "The dedupe key belongs to another memory.");
      yield* write(entry, "replace");
      return entry;
    });

    const status = Effect.fnUntraced(function* (
      id: MemoryId,
      supersededBy: MemoryId | null,
      active: boolean,
      source: MemorySource,
      reason?: string,
    ) {
      const current = yield* read(memoryUri(id));
      if (supersededBy !== null) {
        if (supersededBy === id)
          return yield* memoryApiFailure("invalid_request", "A memory cannot supersede itself.");
        yield* read(memoryUri(supersededBy));
      }
      const entry: MemoryEntry = {
        ...current,
        status: active ? "active" : supersededBy === null ? "archived" : "superseded",
        supersededBy,
        source,
        version: current.version + 1,
        updatedAt: yield* Clock.currentTimeMillis,
      };
      yield* write(entry, "replace", reason);
      return { id, status: entry.status };
    });

    const readBudget = <A>(effect: Effect.Effect<A, MemoryApiError>) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(options.readTimeoutMs),
          orElse: () =>
            Effect.fail(memoryApiFailure("unavailable", "OpenViking memory retrieval timed out.")),
        }),
      );
    return {
      get: (id) =>
        readBudget(validate(MemoryId, id).pipe(Effect.flatMap((id) => read(memoryUri(id))))),
      search: (input) => readBudget(search(input)),
      context: (input) => readBudget(context(input)),
      remember: (input, source) =>
        writes.withPermit(
          Effect.gen(function* () {
            const batch = yield* validate(MemoryBatchCreateInput, input);
            const results = yield* Effect.forEach(batch.entries, (entry) =>
              create(entry, source).pipe(
                Effect.map((value) => ({ ok: true, entry: value, error: null })),
                Effect.catch((error) =>
                  Effect.succeed({
                    ok: false,
                    entry: null,
                    error: { code: error.code, message: error.message },
                  }),
                ),
              ),
            );
            return { results };
          }),
        ),
      update: (input, source) => writes.withPermit(update(input, source)),
      forget: (input, source) =>
        writes.withPermit(
          validate(MemoryForgetToolInput, input).pipe(
            Effect.flatMap((input) =>
              status(input.id, input.supersededBy ?? null, false, source, input.reason),
            ),
          ),
        ),
      restore: (id, source) =>
        writes.withPermit(
          validate(MemoryId, id).pipe(Effect.flatMap((id) => status(id, null, true, source))),
        ),
    } satisfies MemoryServiceShape;
  });
