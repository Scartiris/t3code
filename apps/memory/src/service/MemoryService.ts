// The service owns the store's semantics; the clock and the file size are read
// here rather than threaded through as services because both are bookkeeping.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";

import {
  MEMORY_CONTEXT_LIMIT_MAX,
  MEMORY_CONTEXT_MAX_CHARS_DEFAULT,
  MEMORY_CONTEXT_PINNED_LIMIT,
  MEMORY_KINDS,
  MEMORY_LIMIT_DEFAULT,
  MEMORY_LIMIT_MAX,
  MEMORY_PROTOCOL_VERSION,
  MEMORY_SCOPES,
  MEMORY_SERVICE_NAME,
  MEMORY_TAGS_MAX,
  MemoryApiError,
  type MemoryBatchCreateInput,
  type MemoryBatchCreateResult,
  type MemoryContextInput,
  type MemoryContextResult,
  type MemoryCreateInput,
  type MemoryCreateResult,
  type MemoryDeleteResult,
  type MemoryEntry,
  type MemoryHealthResult,
  type MemoryHistoryResult,
  type MemoryHit,
  type MemoryId,
  type MemoryListInput,
  type MemoryRebuildIndexResult,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemorySource,
  type MemoryStatusChangeInput,
  type MemoryUpdateInput,
  memoryApiFailure,
} from "@t3tools/memory-protocol";

import { renderContextBlock } from "../render/contextBlock.ts";
import { rankHits } from "../retrieval/rank.ts";
import { buildSnippet } from "../retrieval/snippet.ts";
import {
  MemoryEntryConflictError,
  MemoryEntryNotFoundError,
  MemoryStoreDecodeError,
  MemoryStoreSqlError,
  memoryErrorCodeForStoreError,
  type MemoryStoreError,
} from "../store/Errors.ts";
import {
  MEMORY_CANDIDATE_LIMIT,
  MemoryStore,
  defaultMemoryFilter,
  plainEntry,
  type MemoryFilter,
  type MemoryStoreShape,
} from "../store/MemoryStore.ts";
import { MEMORY_SERVICE_VERSION } from "../version.ts";
import { nextMemoryId } from "./Ids.ts";

const DEFAULT_IMPORTANCE = 0.5;

export const fail = memoryApiFailure;

const isMemoryStoreError = (cause: unknown): cause is MemoryStoreError =>
  Schema.is(MemoryStoreSqlError)(cause) ||
  Schema.is(MemoryStoreDecodeError)(cause) ||
  Schema.is(MemoryEntryNotFoundError)(cause) ||
  Schema.is(MemoryEntryConflictError)(cause);

export const toApiError = (cause: unknown): MemoryApiError => {
  if (Schema.is(MemoryApiError)(cause)) return cause;
  if (isMemoryStoreError(cause)) {
    return fail(memoryErrorCodeForStoreError(cause), cause.message);
  }
  return fail("internal", "The memory service failed to complete the request.");
};

const parseCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
};

const fileSize = (path: string): number => {
  try {
    return NodeFS.statSync(path).size;
  } catch {
    return 0;
  }
};

const filterFrom = (
  input: {
    readonly kinds?: ReadonlyArray<(typeof MEMORY_KINDS)[number]> | undefined;
    readonly scope?: (typeof MEMORY_SCOPES)[number] | undefined;
    readonly projectId?: string | undefined;
    readonly includeAllProjects?: boolean | undefined;
    readonly tags?: ReadonlyArray<string> | undefined;
    readonly pinnedOnly?: boolean | undefined;
    readonly includeExpired?: boolean | undefined;
    readonly includePending?: boolean | undefined;
  },
  overrides: Partial<MemoryFilter> = {},
): MemoryFilter =>
  defaultMemoryFilter({
    kinds: input.kinds === undefined || input.kinds.length === 0 ? null : input.kinds,
    scope: input.scope ?? null,
    projectId: input.projectId ?? null,
    includeAllProjects: input.includeAllProjects ?? false,
    tags: input.tags === undefined || input.tags.length === 0 ? null : input.tags,
    pinnedOnly: input.pinnedOnly ?? false,
    includeExpired: input.includeExpired ?? false,
    includePending: input.includePending ?? false,
    ...overrides,
  });

/** A project-scoped memory needs a project; a global one must not name one. */
const validateScope = (
  scope: (typeof MEMORY_SCOPES)[number],
  projectId: string | null | undefined,
): Effect.Effect<void, MemoryApiError> => {
  if (scope === "project" && (projectId === undefined || projectId === null)) {
    return Effect.fail(
      fail("invalid_request", 'A memory with scope "project" must carry a projectId.'),
    );
  }
  if (scope === "global" && projectId !== undefined && projectId !== null) {
    return Effect.fail(
      fail("invalid_request", 'A memory with scope "global" must not carry a projectId.'),
    );
  }
  return Effect.void;
};

export interface MemoryServiceInfo {
  readonly databasePath: string;
  /** False when the service has no usable bearer token; every authenticated route then 401s. */
  readonly tokenConfigured: boolean;
  readonly startedAt: number;
}

export interface MemoryServiceShape {
  readonly create: (
    input: MemoryCreateInput,
    actor: MemorySource,
  ) => Effect.Effect<MemoryCreateResult, MemoryApiError>;
  readonly createBatch: (
    input: MemoryBatchCreateInput,
    actor: MemorySource,
  ) => Effect.Effect<MemoryBatchCreateResult, MemoryApiError>;
  readonly get: (id: MemoryId) => Effect.Effect<MemoryEntry, MemoryApiError>;
  readonly update: (
    id: MemoryId,
    input: MemoryUpdateInput,
    actor: MemorySource,
  ) => Effect.Effect<MemoryEntry, MemoryApiError>;
  readonly setStatus: (
    id: MemoryId,
    input: MemoryStatusChangeInput,
    actor: MemorySource,
  ) => Effect.Effect<MemoryDeleteResult, MemoryApiError>;
  readonly list: (input: MemoryListInput) => Effect.Effect<MemorySearchResult, MemoryApiError>;
  readonly search: (input: MemorySearchInput) => Effect.Effect<MemorySearchResult, MemoryApiError>;
  readonly context: (
    input: MemoryContextInput,
  ) => Effect.Effect<MemoryContextResult, MemoryApiError>;
  readonly history: (id: MemoryId) => Effect.Effect<MemoryHistoryResult, MemoryApiError>;
  readonly health: () => Effect.Effect<MemoryHealthResult, MemoryApiError>;
  readonly rebuildIndex: () => Effect.Effect<MemoryRebuildIndexResult, MemoryApiError>;
}

export class MemoryService extends Context.Service<MemoryService, MemoryServiceShape>()(
  "@t3tools/memory/service/MemoryService",
) {}

/**
 * The service is a value over the store, not a service that reads the store out
 * of the environment: a transport that closes over the value needs nothing from
 * its own layer graph, which is what keeps the route and MCP layers free of
 * service requirements.
 */
export const makeMemoryService = (
  store: MemoryStoreShape,
  info: MemoryServiceInfo,
): MemoryServiceShape => {
  const createOne = (
    input: MemoryCreateInput,
    actor: MemorySource,
    now: number,
  ): Effect.Effect<MemoryCreateResult, MemoryApiError | MemoryStoreError> =>
    Effect.gen(function* () {
      const projectId = input.projectId ?? null;
      yield* validateScope(input.scope, projectId);
      const tags = input.tags ?? [];
      if (tags.length > MEMORY_TAGS_MAX) {
        return yield* fail("invalid_request", `At most ${MEMORY_TAGS_MAX} tags are allowed.`);
      }
      const outcome = yield* store.create({
        id: nextMemoryId(now),
        title: input.title,
        body: input.body,
        kind: input.kind,
        scope: input.scope,
        projectId,
        tags,
        pinned: input.pinned ?? false,
        importance: input.importance ?? DEFAULT_IMPORTANCE,
        expiresAt: input.expiresAt ?? null,
        dedupeKey: input.dedupeKey ?? null,
        reviewState: "accepted",
        source: input.source ?? actor,
        now,
      });
      return { entry: outcome.entry, duplicate: outcome.duplicate };
    });

  const searchRanked = (
    input: MemorySearchInput,
    now: number,
  ): Effect.Effect<MemorySearchResult, MemoryApiError | MemoryStoreError> =>
    Effect.gen(function* () {
      const query = input.query?.trim() ?? "";
      const rows = yield* store.findRanked({
        filter: filterFrom(input, { status: "active" }),
        query,
        now,
        limit: MEMORY_CANDIDATE_LIMIT,
      });
      const ranked = rankHits(rows, now);
      const offset = parseCursor(input.cursor);
      const limit = Math.min(input.limit ?? MEMORY_LIMIT_DEFAULT, MEMORY_LIMIT_MAX);
      const page = ranked.slice(offset, offset + limit);
      const items: ReadonlyArray<MemoryHit> = page.map((hit) => ({
        entry: plainEntry(hit.item),
        score: hit.score,
        snippet: buildSnippet(hit.item, query),
      }));
      // Recall is counted, not audited. A failure here must not fail the read:
      // the caller asked for memories, not for bookkeeping.
      yield* store
        .markAccessed(
          items.map((item) => item.entry.id),
          now,
        )
        .pipe(Effect.catch(() => Effect.void));
      const nextOffset = offset + items.length;
      return {
        items,
        total: ranked.length,
        nextCursor: nextOffset < ranked.length ? String(nextOffset) : null,
      };
    });

  const list: MemoryServiceShape["list"] = (input) =>
    Effect.gen(function* () {
      const now = Date.now();
      const offset = parseCursor(input.cursor);
      const limit = Math.min(input.limit ?? MEMORY_LIMIT_DEFAULT, MEMORY_LIMIT_MAX);
      const page = yield* store.listPage({
        // Listing is how an operator audits the store, so it is the one read
        // that is not restricted to active entries unless asked.
        filter: filterFrom(input, { status: input.status ?? null }),
        now,
        limit,
        offset,
      });
      const items: ReadonlyArray<MemoryHit> = page.items.map((entry) => ({
        entry,
        score: 0,
        snippet: buildSnippet(entry, ""),
      }));
      const nextOffset = offset + items.length;
      return {
        items,
        total: page.total,
        nextCursor: nextOffset < page.total ? String(nextOffset) : null,
      };
    }).pipe(Effect.mapError(toApiError));

  return MemoryService.of({
    create: (input, actor) =>
      Effect.gen(function* () {
        return yield* createOne(input, actor, Date.now());
      }).pipe(Effect.mapError(toApiError)),

    createBatch: (input, actor) =>
      Effect.gen(function* () {
        const now = Date.now();
        const results = yield* Effect.forEach(
          input.entries,
          (entry) =>
            createOne(entry, actor, now).pipe(
              Effect.mapError(toApiError),
              Effect.map((result) => ({
                ok: true as const,
                entry: result.entry,
                error: null,
              })),
              Effect.catch((error: MemoryApiError) =>
                Effect.succeed({
                  ok: false as const,
                  entry: null,
                  error: { code: error.code, message: error.message },
                }),
              ),
            ),
          { concurrency: 1 },
        );
        return { results };
      }).pipe(Effect.mapError(toApiError)),

    get: (id) => store.get(id).pipe(Effect.mapError(toApiError)),

    update: (id, input, actor) =>
      Effect.gen(function* () {
        if (input.scope !== undefined) {
          const current = yield* store.get(id);
          yield* validateScope(input.scope, input.projectId ?? current.projectId);
        }
        return yield* store.update({
          id,
          patch: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            ...(input.tags === undefined ? {} : { tags: input.tags }),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
            ...(input.importance === undefined ? {} : { importance: input.importance }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
          },
          expectedVersion: input.expectedVersion ?? null,
          actor,
          now: Date.now(),
        });
      }).pipe(Effect.mapError(toApiError)),

    setStatus: (id, input, actor) =>
      Effect.gen(function* () {
        const supersededBy = input.supersededBy ?? null;
        if (input.status === "superseded") {
          if (supersededBy === null) {
            return yield* fail(
              "invalid_request",
              'Changing a memory to "superseded" requires supersededBy to name the replacement.',
            );
          }
          if (supersededBy === id) {
            return yield* fail("invalid_request", "A memory cannot supersede itself.");
          }
          // Fail here rather than storing a dangling reference.
          yield* store.get(supersededBy);
        } else if (supersededBy !== null) {
          return yield* fail(
            "invalid_request",
            "supersededBy is only meaningful when the new status is superseded.",
          );
        }
        const entry = yield* store.setStatus({
          id,
          status: input.status,
          supersededBy,
          reason: input.reason ?? null,
          actor,
          now: Date.now(),
        });
        return { id: entry.id, status: entry.status };
      }).pipe(Effect.mapError(toApiError)),

    list,

    search: (input) =>
      Effect.gen(function* () {
        return yield* searchRanked(input, Date.now());
      }).pipe(Effect.mapError(toApiError)),

    context: (input) =>
      Effect.gen(function* () {
        const now = Date.now();
        const filter = filterFrom(input, { status: "active" });
        const limit = Math.min(input.limit ?? MEMORY_LIMIT_DEFAULT, MEMORY_CONTEXT_LIMIT_MAX);
        const pinned =
          input.includePinned === false
            ? []
            : yield* store.listPinned({
                filter,
                now,
                limit: MEMORY_CONTEXT_PINNED_LIMIT,
              });
        const query = input.query?.trim() ?? "";
        const rows = yield* store.findRanked({
          filter,
          query,
          now,
          limit: MEMORY_CANDIDATE_LIMIT,
        });
        const hits: ReadonlyArray<MemoryHit> = rankHits(rows, now)
          .slice(0, limit)
          .map((hit) => ({
            entry: plainEntry(hit.item),
            score: hit.score,
            snippet: buildSnippet(hit.item, query),
          }));
        const rendered = renderContextBlock({
          pinned,
          hits,
          maxChars: input.maxChars ?? MEMORY_CONTEXT_MAX_CHARS_DEFAULT,
          hitsAreQueryMatches: query.length > 0,
        });
        return {
          text: rendered.text,
          hits,
          pinned,
          truncated: rendered.truncated,
          chars: rendered.chars,
          empty: rendered.text.length === 0,
        };
      }).pipe(Effect.mapError(toApiError)),

    history: (id) =>
      Effect.gen(function* () {
        const events = yield* store.history(id);
        return { entryId: id, events };
      }).pipe(Effect.mapError(toApiError)),

    health: () =>
      Effect.gen(function* () {
        const counts = yield* store.counts();
        const lastWriteAt = yield* store.lastWriteAt();
        const health: MemoryHealthResult = {
          ok: true,
          service: MEMORY_SERVICE_NAME,
          version: MEMORY_SERVICE_VERSION,
          protocolVersion: MEMORY_PROTOCOL_VERSION,
          entries: counts,
          databasePath: info.databasePath,
          databaseBytes: fileSize(info.databasePath),
          tokenConfigured: info.tokenConfigured,
          startedAt: info.startedAt,
          lastWriteAt,
        };
        return health;
      }).pipe(Effect.mapError(toApiError)),

    rebuildIndex: () => store.rebuildIndex().pipe(Effect.mapError(toApiError)),
  });
};

export const layer = (info: MemoryServiceInfo): Layer.Layer<MemoryService, never, MemoryStore> =>
  Layer.effect(
    MemoryService,
    Effect.map(MemoryStore, (store) => makeMemoryService(store, info)),
  );
