// Tag and provenance columns hold JSON written by this module alone, and the
// store reads the wall clock for recency. Both are deliberate here: the tags
// are a list of short strings, not a schema boundary.
// @effect-diagnostics preferSchemaOverJson:off globalDate:off globalDateInEffect:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MemoryEntry,
  MemoryEvent,
  MemoryId,
  MemoryKind,
  MemoryReviewState,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  MemoryTag,
} from "@t3tools/memory-protocol";

import {
  buildBigramText,
  buildIndexText,
  buildLikePattern,
  buildMatchExpression,
  isIndexableQuery,
} from "../retrieval/normalize.ts";
import { relevanceFromBm25 } from "../retrieval/rank.ts";
import {
  MemoryEntryConflictError,
  MemoryEntryNotFoundError,
  MemoryStoreDecodeError,
  MemoryStoreSqlError,
  type MemoryStoreError,
} from "./Errors.ts";

/**
 * How many rows a ranked query considers before the caller ranks and pages.
 * Ranking happens in JavaScript so the weights stay one testable function; this
 * bounds what that costs. Well past what any single query returns.
 */
export const MEMORY_CANDIDATE_LIMIT = 200;

/** Used when a query has no indexable terms: a substring scan instead of the index. */
export const SUBSTRING_FALLBACK_RELEVANCE = 0.7;
export const SUBSTRING_TITLE_RELEVANCE = 1;

export interface MemoryFilter {
  /** `null` means any status. Every read path defaults it to `active` except listing. */
  readonly status: MemoryStatus | null;
  readonly kinds: ReadonlyArray<MemoryKind> | null;
  readonly scope: MemoryScope | null;
  readonly projectId: string | null;
  readonly includeAllProjects: boolean;
  readonly tags: ReadonlyArray<string> | null;
  readonly pinnedOnly: boolean;
  readonly includeExpired: boolean;
  readonly includePending: boolean;
}

export const defaultMemoryFilter = (overrides: Partial<MemoryFilter> = {}): MemoryFilter => ({
  status: "active",
  kinds: null,
  scope: null,
  projectId: null,
  includeAllProjects: false,
  tags: null,
  pinnedOnly: false,
  includeExpired: false,
  includePending: false,
  ...overrides,
});

export interface NewEntryRecord {
  readonly id: MemoryId;
  readonly title: string;
  readonly body: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly projectId: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly pinned: boolean;
  readonly importance: number;
  readonly expiresAt: number | null;
  readonly dedupeKey: string | null;
  readonly reviewState: MemoryReviewState;
  readonly source: MemorySource;
  readonly now: number;
}

export interface EntryPatch {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly kind?: MemoryKind | undefined;
  readonly scope?: MemoryScope | undefined;
  readonly projectId?: string | null | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly pinned?: boolean | undefined;
  readonly importance?: number | undefined;
  readonly expiresAt?: number | null | undefined;
  readonly dedupeKey?: string | null | undefined;
}

export interface MemoryCounts {
  readonly active: number;
  readonly superseded: number;
  readonly archived: number;
  readonly pinned: number;
}

/** A decoded entry plus the relevance the store derived from the index. */
export type RankedRow = MemoryEntry & { readonly relevance: number };

export interface CreateOutcome {
  readonly entry: MemoryEntry;
  readonly duplicate: boolean;
}

export interface MemoryStoreShape {
  readonly create: (record: NewEntryRecord) => Effect.Effect<CreateOutcome, MemoryStoreError>;
  readonly get: (id: MemoryId) => Effect.Effect<MemoryEntry, MemoryStoreError>;
  readonly update: (input: {
    readonly id: MemoryId;
    readonly patch: EntryPatch;
    readonly expectedVersion: number | null;
    readonly actor: MemorySource;
    readonly now: number;
  }) => Effect.Effect<MemoryEntry, MemoryStoreError>;
  readonly setStatus: (input: {
    readonly id: MemoryId;
    readonly status: MemoryStatus;
    readonly supersededBy: MemoryId | null;
    readonly reason: string | null;
    readonly actor: MemorySource;
    readonly now: number;
  }) => Effect.Effect<MemoryEntry, MemoryStoreError>;
  /** Ranked candidates for a query, or the newest entries when the query is empty. */
  readonly findRanked: (input: {
    readonly filter: MemoryFilter;
    readonly query: string;
    readonly now: number;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<RankedRow>, MemoryStoreError>;
  readonly listPage: (input: {
    readonly filter: MemoryFilter;
    readonly now: number;
    readonly limit: number;
    readonly offset: number;
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<MemoryEntry>; readonly total: number },
    MemoryStoreError
  >;
  readonly listPinned: (input: {
    readonly filter: MemoryFilter;
    readonly now: number;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<MemoryEntry>, MemoryStoreError>;
  readonly history: (id: MemoryId) => Effect.Effect<ReadonlyArray<MemoryEvent>, MemoryStoreError>;
  readonly counts: () => Effect.Effect<MemoryCounts, MemoryStoreError>;
  readonly markAccessed: (
    ids: ReadonlyArray<MemoryId>,
    now: number,
  ) => Effect.Effect<void, MemoryStoreError>;
  readonly rebuildIndex: () => Effect.Effect<
    { readonly indexed: number; readonly tookMs: number },
    MemoryStoreError
  >;
  readonly lastWriteAt: () => Effect.Effect<number | null, MemoryStoreError>;
}

export class MemoryStore extends Context.Service<MemoryStore, MemoryStoreShape>()(
  "@t3tools/memory/store/MemoryStore",
) {}

const RawEntryRow = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
  title: Schema.String,
  body: Schema.String,
  kind: Schema.String,
  scope: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  tags_json: Schema.String,
  pinned: Schema.Number,
  importance: Schema.Number,
  status: Schema.String,
  superseded_by: Schema.NullOr(Schema.String),
  expires_at: Schema.NullOr(Schema.Number),
  dedupe_key: Schema.NullOr(Schema.String),
  review_state: Schema.String,
  source_json: Schema.String,
  hit_count: Schema.Number,
  last_accessed_at: Schema.NullOr(Schema.Number),
  created_at: Schema.Number,
  updated_at: Schema.Number,
  search_text: Schema.String,
  bm25: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
type RawEntryRow = typeof RawEntryRow.Type;

const RawEventRow = Schema.Struct({
  id: Schema.Number,
  entry_id: Schema.String,
  type: Schema.String,
  at: Schema.Number,
  actor_json: Schema.String,
  detail: Schema.NullOr(Schema.String),
});

const decodeRawEntryRow = Schema.decodeUnknownEffect(RawEntryRow);
const decodeRawEventRow = Schema.decodeUnknownEffect(RawEventRow);
const decodeTags = Schema.decodeUnknownEffect(Schema.Array(MemoryTag));
const decodeSource = Schema.decodeUnknownEffect(MemorySource);
const decodeKind = Schema.decodeUnknownEffect(MemoryKind);
const decodeScope = Schema.decodeUnknownEffect(MemoryScope);
const decodeStatus = Schema.decodeUnknownEffect(MemoryStatus);
const decodeReviewState = Schema.decodeUnknownEffect(MemoryReviewState);
const decodeEventType = Schema.decodeUnknownEffect(MemoryEvent.fields.type);

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const isMemoryStoreError = (cause: unknown): cause is MemoryStoreError =>
  Schema.is(MemoryEntryNotFoundError)(cause) ||
  Schema.is(MemoryEntryConflictError)(cause) ||
  Schema.is(MemoryStoreDecodeError)(cause) ||
  Schema.is(MemoryStoreSqlError)(cause);

const sqlError =
  (operation: string) =>
  (cause: unknown): MemoryStoreError =>
    isMemoryStoreError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? new MemoryStoreDecodeError({ operation, cause })
        : new MemoryStoreSqlError({ operation, cause });

const toEntry = (
  row: RawEntryRow,
  relevance: number,
): Effect.Effect<RankedRow, MemoryStoreDecodeError> =>
  Effect.gen(function* () {
    const tags = yield* decodeTags(parseJson(row.tags_json) ?? []);
    const source = yield* decodeSource(parseJson(row.source_json) ?? { kind: "system" });
    const kind = yield* decodeKind(row.kind);
    const scope = yield* decodeScope(row.scope);
    const status = yield* decodeStatus(row.status);
    const reviewState = yield* decodeReviewState(row.review_state);
    return {
      id: MemoryId.make(row.id),
      version: row.version,
      title: row.title,
      body: row.body,
      kind,
      scope,
      projectId: row.project_id,
      tags,
      pinned: row.pinned === 1,
      importance: row.importance,
      status,
      supersededBy: row.superseded_by === null ? null : MemoryId.make(row.superseded_by),
      expiresAt: row.expires_at,
      dedupeKey: row.dedupe_key,
      reviewState,
      source,
      hitCount: row.hit_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      relevance,
    };
  }).pipe(
    Effect.mapError((cause) => new MemoryStoreDecodeError({ operation: "decodeEntry", cause })),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const visibility = (filter: MemoryFilter, now: number) =>
    sql.and([
      filter.status === null ? sql`1` : sql`e.status = ${filter.status}`,
      filter.kinds === null
        ? sql`1`
        : sql`e.kind IN (SELECT value FROM json_each(${JSON.stringify(filter.kinds)}))`,
      filter.scope === null ? sql`1` : sql`e.scope = ${filter.scope}`,
      filter.tags === null
        ? sql`1`
        : sql`EXISTS (
            SELECT 1 FROM json_each(e.tags_json) AS tag
            WHERE tag.value IN (SELECT value FROM json_each(${JSON.stringify(filter.tags)}))
          )`,
      filter.pinnedOnly ? sql`e.pinned = 1` : sql`1`,
      filter.includeExpired ? sql`1` : sql`(e.expires_at IS NULL OR e.expires_at > ${now})`,
      filter.includePending ? sql`1` : sql`e.review_state = 'accepted'`,
      filter.includeAllProjects
        ? sql`1`
        : sql`(e.scope = 'global' OR (${filter.projectId} IS NOT NULL AND e.project_id = ${filter.projectId}))`,
    ]);

  const indexEntry = (row: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly tags_json: string;
  }) =>
    Effect.gen(function* () {
      const tags = yield* decodeTags(parseJson(row.tags_json) ?? []).pipe(
        Effect.mapError((cause) => new MemoryStoreDecodeError({ operation: "indexTags", cause })),
      );
      const norm = buildIndexText([row.title, row.body, tags.join(" ")]);
      const grams = buildBigramText([row.title, row.body, tags.join(" ")]);
      yield* sql`DELETE FROM memory_fts WHERE entry_id = ${row.id}`;
      yield* sql`INSERT INTO memory_fts (entry_id, norm, grams) VALUES (${row.id}, ${norm}, ${grams})`;
    });

  const insertEvent = (input: {
    readonly entryId: string;
    readonly type: string;
    readonly at: number;
    readonly actor: MemorySource;
    readonly detail: string | null;
  }) =>
    sql`
      INSERT INTO memory_events (entry_id, type, at, actor_json, detail)
      VALUES (${input.entryId}, ${input.type}, ${input.at}, ${JSON.stringify(input.actor)}, ${input.detail})
    `;

  const selectById = (id: string) =>
    sql<RawEntryRow>`SELECT e.* FROM memory_entries AS e WHERE e.id = ${id}`;

  const decodeRow = (
    row: RawEntryRow,
    relevance: number,
  ): Effect.Effect<RankedRow, MemoryStoreDecodeError> =>
    decodeRawEntryRow(row).pipe(
      Effect.mapError((cause) => new MemoryStoreDecodeError({ operation: "decodeEntry", cause })),
      Effect.flatMap((decoded) => toEntry(decoded, relevance)),
    );

  const requireEntry = (id: MemoryId): Effect.Effect<RankedRow, MemoryStoreError> =>
    Effect.gen(function* () {
      const rows = yield* selectById(id).pipe(Effect.mapError(sqlError("readEntry")));
      const row = rows[0];
      if (row === undefined) return yield* new MemoryEntryNotFoundError({ id });
      return yield* decodeRow(row, 0);
    });

  const findByDedupeKey = (input: {
    readonly scope: MemoryScope;
    readonly projectId: string | null;
    readonly dedupeKey: string;
  }): Effect.Effect<MemoryEntry | undefined, MemoryStoreError> =>
    sql<RawEntryRow>`
      SELECT e.* FROM memory_entries AS e
      WHERE e.scope = ${input.scope}
        AND IFNULL(e.project_id, '') = ${input.projectId ?? ""}
        AND e.dedupe_key = ${input.dedupeKey}
      LIMIT 1
    `.pipe(
      Effect.mapError(sqlError("findByDedupeKey")),
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(undefined) : decodeRow(rows[0], 0),
      ),
    );

  const create: MemoryStoreShape["create"] = (record) =>
    Effect.gen(function* () {
      if (record.dedupeKey !== null) {
        const existing = yield* findByDedupeKey({
          scope: record.scope,
          projectId: record.projectId,
          dedupeKey: record.dedupeKey,
        });
        if (existing !== undefined) return { entry: existing, duplicate: true };
      }

      const searchText = buildIndexText([record.title, record.body, record.tags.join(" ")]);
      const inserted = yield* sql`
        INSERT INTO memory_entries (
          id, version, title, body, kind, scope, project_id, tags_json, pinned, importance,
          status, superseded_by, expires_at, dedupe_key, review_state, source_json,
          hit_count, last_accessed_at, created_at, updated_at, search_text
        ) VALUES (
          ${record.id}, 1, ${record.title}, ${record.body}, ${record.kind}, ${record.scope},
          ${record.projectId}, ${JSON.stringify(record.tags)}, ${record.pinned ? 1 : 0},
          ${record.importance}, 'active', NULL, ${record.expiresAt}, ${record.dedupeKey},
          ${record.reviewState}, ${JSON.stringify(record.source)}, 0, NULL, ${record.now},
          ${record.now}, ${searchText}
        )
      `.pipe(
        Effect.as(true),
        // A concurrent writer can win the dedupe race between the read above and
        // this insert. Single process plus serialized writes makes that
        // unlikely; a caller that supplied a key still wants the entry that won
        // rather than an error, so re-read before failing.
        Effect.catch(() => Effect.succeed(false)),
      );

      if (!inserted) {
        if (record.dedupeKey !== null) {
          const existing = yield* findByDedupeKey({
            scope: record.scope,
            projectId: record.projectId,
            dedupeKey: record.dedupeKey,
          });
          if (existing !== undefined) return { entry: existing, duplicate: true };
        }
        return yield* new MemoryStoreSqlError({
          operation: "createEntry",
          cause: new Error(`Insert for memory entry "${record.id}" was rejected.`),
        });
      }

      yield* indexEntry({
        id: record.id,
        title: record.title,
        body: record.body,
        tags_json: JSON.stringify(record.tags),
      }).pipe(Effect.mapError(sqlError("indexEntry")));
      yield* insertEvent({
        entryId: record.id,
        type: "created",
        at: record.now,
        actor: record.source,
        detail: null,
      }).pipe(Effect.mapError(sqlError("insertEvent")));
      return { entry: yield* requireEntry(record.id), duplicate: false };
    });

  const update: MemoryStoreShape["update"] = (input) =>
    Effect.gen(function* () {
      const current = yield* requireEntry(input.id);
      if (input.expectedVersion !== null && current.version !== input.expectedVersion) {
        return yield* new MemoryEntryConflictError({
          id: input.id,
          expectedVersion: input.expectedVersion,
          actualVersion: current.version,
        });
      }
      const patch = input.patch;
      const next = {
        title: patch.title ?? current.title,
        body: patch.body ?? current.body,
        kind: patch.kind ?? current.kind,
        scope: patch.scope ?? current.scope,
        projectId: patch.projectId === undefined ? current.projectId : patch.projectId,
        tags: patch.tags ?? current.tags,
        pinned: patch.pinned ?? current.pinned,
        importance: patch.importance ?? current.importance,
        expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
        dedupeKey: patch.dedupeKey === undefined ? current.dedupeKey : patch.dedupeKey,
      };
      const searchText = buildIndexText([next.title, next.body, next.tags.join(" ")]);
      yield* sql`
        UPDATE memory_entries
        SET title = ${next.title},
            body = ${next.body},
            kind = ${next.kind},
            scope = ${next.scope},
            project_id = ${next.projectId},
            tags_json = ${JSON.stringify(next.tags)},
            pinned = ${next.pinned ? 1 : 0},
            importance = ${next.importance},
            expires_at = ${next.expiresAt},
            dedupe_key = ${next.dedupeKey},
            version = version + 1,
            updated_at = ${input.now},
            search_text = ${searchText}
        WHERE id = ${input.id}
      `;
      yield* indexEntry({
        id: input.id,
        title: next.title,
        body: next.body,
        tags_json: JSON.stringify(next.tags),
      });
      yield* insertEvent({
        entryId: input.id,
        type: "updated",
        at: input.now,
        actor: input.actor,
        detail: null,
      });
      return yield* requireEntry(input.id);
    }).pipe(Effect.mapError(sqlError("updateEntry")));

  const setStatus: MemoryStoreShape["setStatus"] = (input) =>
    Effect.gen(function* () {
      yield* requireEntry(input.id);
      yield* sql`
        UPDATE memory_entries
        SET status = ${input.status},
            superseded_by = ${input.supersededBy},
            version = version + 1,
            updated_at = ${input.now}
        WHERE id = ${input.id}
      `;
      yield* insertEvent({
        entryId: input.id,
        type: "status-changed",
        at: input.now,
        actor: input.actor,
        detail: JSON.stringify({
          status: input.status,
          ...(input.supersededBy === null ? {} : { supersededBy: input.supersededBy }),
          ...(input.reason === null ? {} : { reason: input.reason }),
        }),
      });
      return yield* requireEntry(input.id);
    }).pipe(Effect.mapError(sqlError("setStatusEntry")));

  const findRanked: MemoryStoreShape["findRanked"] = (input) => {
    const limit = input.limit ?? MEMORY_CANDIDATE_LIMIT;
    const query = input.query.trim();
    // A query the index cannot answer — one CJK character, or punctuation —
    // takes the substring path rather than a MATCH that can only return nothing.
    const match =
      query.length === 0 || !isIndexableQuery(query) ? null : buildMatchExpression(query);
    const where = visibility(input.filter, input.now);

    // Three shapes: ranked by the index, a substring scan when the query has no
    // indexable terms (a single CJK character produces no bigram), and newest
    // first when there is no query at all.
    const rows =
      match === null
        ? sql<RawEntryRow>`
            SELECT e.* FROM memory_entries AS e
            WHERE ${query.length === 0 ? where : sql.and([where, sql`e.search_text LIKE ${buildLikePattern(query)} ESCAPE '!'`])}
            ORDER BY e.updated_at DESC, e.id ASC
            LIMIT ${limit}
          `
        : sql<RawEntryRow>`
            SELECT e.*, bm25(memory_fts) AS bm25
            FROM memory_fts
            INNER JOIN memory_entries AS e ON e.id = memory_fts.entry_id
            WHERE memory_fts MATCH ${match} AND ${where}
            ORDER BY bm25(memory_fts) ASC, e.id ASC
            LIMIT ${limit}
          `;

    const relevanceOf = (decoded: RawEntryRow): number =>
      match === null
        ? query.length === 0
          ? 0
          : decoded.title.toLowerCase().includes(query.toLowerCase())
            ? SUBSTRING_TITLE_RELEVANCE
            : SUBSTRING_FALLBACK_RELEVANCE
        : relevanceFromBm25(decoded.bm25 ?? 0);

    return rows.pipe(
      Effect.flatMap((candidates) =>
        Effect.forEach(candidates, (row) =>
          decodeRawEntryRow(row).pipe(
            Effect.flatMap((decoded) => toEntry(decoded, relevanceOf(decoded))),
          ),
        ),
      ),
      Effect.mapError(sqlError("findRanked")),
    );
  };

  const listPage: MemoryStoreShape["listPage"] = (input) =>
    Effect.gen(function* () {
      const where = visibility(input.filter, input.now);
      const totalRows = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS total FROM memory_entries AS e WHERE ${where}
      `;
      const rows = yield* sql<RawEntryRow>`
        SELECT e.* FROM memory_entries AS e
        WHERE ${where}
        ORDER BY e.updated_at DESC, e.id ASC
        LIMIT ${input.limit} OFFSET ${input.offset}
      `;
      const entries = yield* Effect.forEach(rows, (row) =>
        decodeRawEntryRow(row).pipe(Effect.flatMap((decoded) => toEntry(decoded, 0))),
      );
      return {
        items: entries.map((entry) => plainEntry(entry)),
        total: totalRows[0]?.total ?? 0,
      };
    }).pipe(Effect.mapError(sqlError("listEntries")));

  const listPinned: MemoryStoreShape["listPinned"] = (input) =>
    Effect.gen(function* () {
      const where = visibility({ ...input.filter, pinnedOnly: true }, input.now);
      const rows = yield* sql<RawEntryRow>`
        SELECT e.* FROM memory_entries AS e
        WHERE ${where}
        ORDER BY e.created_at ASC, e.id ASC
        LIMIT ${input.limit}
      `;
      const entries = yield* Effect.forEach(rows, (row) =>
        decodeRawEntryRow(row).pipe(Effect.flatMap((decoded) => toEntry(decoded, 0))),
      );
      return entries.map((entry) => plainEntry(entry));
    }).pipe(Effect.mapError(sqlError("listPinned")));

  const history: MemoryStoreShape["history"] = (id) =>
    Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT id, entry_id, type, at, actor_json, detail
        FROM memory_events
        WHERE entry_id = ${id}
        ORDER BY id ASC
      `;
      return yield* Effect.forEach(rows, (row) =>
        decodeRawEventRow(row).pipe(
          Effect.flatMap((decoded) =>
            Effect.gen(function* () {
              const actor = yield* decodeSource(
                parseJson(decoded.actor_json) ?? { kind: "system" },
              );
              const type = yield* decodeEventType(decoded.type);
              return {
                id: decoded.id,
                entryId: MemoryId.make(decoded.entry_id),
                type,
                at: decoded.at,
                actor,
                detail: decoded.detail,
              } satisfies MemoryEvent;
            }),
          ),
        ),
      );
    }).pipe(Effect.mapError(sqlError("listEvents")));

  const counts: MemoryStoreShape["counts"] = () =>
    sql<{
      readonly active: number | null;
      readonly superseded: number | null;
      readonly archived: number | null;
      readonly pinned: number | null;
    }>`
      SELECT
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
        SUM(CASE WHEN pinned = 1 AND status = 'active' THEN 1 ELSE 0 END) AS pinned
      FROM memory_entries
    `.pipe(
      Effect.map((rows) => ({
        active: rows[0]?.active ?? 0,
        superseded: rows[0]?.superseded ?? 0,
        archived: rows[0]?.archived ?? 0,
        pinned: rows[0]?.pinned ?? 0,
      })),
      Effect.mapError(sqlError("countEntries")),
    );

  const markAccessed: MemoryStoreShape["markAccessed"] = (ids, now) =>
    ids.length === 0
      ? Effect.void
      : sql`
          UPDATE memory_entries
          SET hit_count = hit_count + 1, last_accessed_at = ${now}
          WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        `.pipe(Effect.asVoid, Effect.mapError(sqlError("markAccessed")));

  const rebuildIndex: MemoryStoreShape["rebuildIndex"] = () =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      const rows = yield* sql<{
        readonly id: string;
        readonly title: string;
        readonly body: string;
        readonly tags_json: string;
      }>`SELECT id, title, body, tags_json FROM memory_entries`;
      yield* sql`DELETE FROM memory_fts`;
      yield* Effect.forEach(rows, (row) => indexEntry(row), { discard: true });
      return { indexed: rows.length, tookMs: Math.max(0, Date.now() - startedAt) };
    }).pipe(Effect.mapError(sqlError("rebuildIndex")));

  const lastWriteAt: MemoryStoreShape["lastWriteAt"] = () =>
    sql<{ readonly at: number | null }>`
      SELECT MAX(updated_at) AS at FROM memory_entries
    `.pipe(
      Effect.map((rows) => rows[0]?.at ?? null),
      Effect.mapError(sqlError("lastWriteAt")),
    );

  return MemoryStore.of({
    create,
    get: requireEntry,
    update,
    setStatus,
    findRanked,
    listPage,
    listPinned,
    history,
    counts,
    markAccessed,
    rebuildIndex,
    lastWriteAt,
  });
});

/**
 * Drops the ranking field. `RankedRow` is a `MemoryEntry` plus relevance so the
 * scorer can take rows directly; responses carry the entry alone.
 */
export const plainEntry = (entry: RankedRow): MemoryEntry => {
  const { relevance: _relevance, ...rest } = entry;
  return rest;
};

export const layer = Layer.effect(MemoryStore, make);
