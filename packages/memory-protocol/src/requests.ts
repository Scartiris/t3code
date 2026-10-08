import * as Schema from "effect/Schema";

import { EpochMillis, MemoryId, PositiveInt, TrimmedNonEmptyString, UnitInterval } from "./base.ts";
import {
  MEMORY_BATCH_MAX,
  MEMORY_BODY_MAX_CHARS,
  MEMORY_CONTEXT_LIMIT_MAX,
  MEMORY_CONTEXT_MAX_CHARS_DEFAULT,
  MEMORY_CONTEXT_MAX_CHARS_LIMIT,
  MEMORY_DEDUPE_KEY_MAX_CHARS,
  MEMORY_LIMIT_DEFAULT,
  MEMORY_LIMIT_MAX,
  MEMORY_QUERY_MAX_CHARS,
  MEMORY_REASON_MAX_CHARS,
  MEMORY_TAGS_MAX,
  MEMORY_TITLE_MAX_CHARS,
  MemoryKind,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  MemoryTag,
} from "./entry.ts";

const ProjectKey = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const DedupeKey = TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_DEDUPE_KEY_MAX_CHARS));
const Reason = TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_REASON_MAX_CHARS));

/** Fields a caller supplies when creating a memory. Everything else is server-owned. */
export const MemoryWriteInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_TITLE_MAX_CHARS)).annotate({
    description: "One-line summary. This is what search results and injected context show.",
  }),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_BODY_MAX_CHARS)),
  kind: MemoryKind,
  scope: MemoryScope,
  projectId: Schema.optionalKey(Schema.NullOr(ProjectKey)),
  tags: Schema.optionalKey(Schema.Array(MemoryTag).check(Schema.isMaxLength(MEMORY_TAGS_MAX))),
  pinned: Schema.optionalKey(Schema.Boolean),
  importance: Schema.optionalKey(UnitInterval),
  expiresAt: Schema.optionalKey(Schema.NullOr(EpochMillis)),
  /**
   * Stable identity for "the same fact, written again". A retry, or two agents
   * learning the same thing, collapse onto one entry instead of accumulating
   * near-duplicates.
   */
  dedupeKey: Schema.optionalKey(Schema.NullOr(DedupeKey)),
  source: Schema.optionalKey(MemorySource),
});
export type MemoryWriteInput = typeof MemoryWriteInput.Type;

export const MemoryCreateInput = MemoryWriteInput;
export type MemoryCreateInput = typeof MemoryCreateInput.Type;

export const MemoryBatchCreateInput = Schema.Struct({
  entries: Schema.Array(MemoryWriteInput)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(MEMORY_BATCH_MAX)),
});
export type MemoryBatchCreateInput = typeof MemoryBatchCreateInput.Type;

/** Every field optional; `expectedVersion` turns the write into a compare-and-set. */
export const MemoryUpdateInput = Schema.Struct({
  expectedVersion: Schema.optionalKey(PositiveInt),
  title: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_TITLE_MAX_CHARS)),
  ),
  body: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_BODY_MAX_CHARS))),
  kind: Schema.optionalKey(MemoryKind),
  scope: Schema.optionalKey(MemoryScope),
  projectId: Schema.optionalKey(Schema.NullOr(ProjectKey)),
  tags: Schema.optionalKey(Schema.Array(MemoryTag).check(Schema.isMaxLength(MEMORY_TAGS_MAX))),
  pinned: Schema.optionalKey(Schema.Boolean),
  importance: Schema.optionalKey(UnitInterval),
  expiresAt: Schema.optionalKey(Schema.NullOr(EpochMillis)),
  dedupeKey: Schema.optionalKey(Schema.NullOr(DedupeKey)),
});
export type MemoryUpdateInput = typeof MemoryUpdateInput.Type;

export const MemoryStatusChangeInput = Schema.Struct({
  status: MemoryStatus,
  /** Required when status is `superseded`: the entry that replaces this one. */
  supersededBy: Schema.optionalKey(Schema.NullOr(MemoryId)),
  reason: Schema.optionalKey(Reason),
});
export type MemoryStatusChangeInput = typeof MemoryStatusChangeInput.Type;

const QueryFilter = {
  kinds: Schema.optionalKey(Schema.Array(MemoryKind)),
  scope: Schema.optionalKey(MemoryScope),
  projectId: Schema.optionalKey(ProjectKey),
  /** Escape hatch for cross-project questions; default hides other projects' entries. */
  includeAllProjects: Schema.optionalKey(Schema.Boolean),
  tags: Schema.optionalKey(Schema.Array(MemoryTag)),
  status: Schema.optionalKey(MemoryStatus),
  pinnedOnly: Schema.optionalKey(Schema.Boolean),
  includeExpired: Schema.optionalKey(Schema.Boolean),
  includePending: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEMORY_LIMIT_MAX })),
  ),
  cursor: Schema.optionalKey(Schema.String),
};

/** Opaque pagination cursor: the offset of the next page. */
export const MemoryListInput = Schema.Struct({
  ...QueryFilter,
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEMORY_LIMIT_MAX })),
  ).annotate({ description: `Defaults to ${MEMORY_LIMIT_DEFAULT}.` }),
});
export type MemoryListInput = typeof MemoryListInput.Type;

export const MemorySearchInput = Schema.Struct({
  ...QueryFilter,
  query: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(MEMORY_QUERY_MAX_CHARS)),
  ).annotate({
    description:
      "Full-text query. Absent or empty means 'no ranking': the newest matching entries win.",
  }),
});
export type MemorySearchInput = typeof MemorySearchInput.Type;

/**
 * The one call a host app makes at the start of a session. It returns a
 * rendered block, not a list, because the caller must not re-render it: the
 * text is byte-stable so an unchanged memory set does not invalidate the
 * provider's prompt cache.
 */
export const MemoryContextInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MEMORY_QUERY_MAX_CHARS))),
  projectId: Schema.optionalKey(ProjectKey),
  kinds: Schema.optionalKey(Schema.Array(MemoryKind)),
  includeAllProjects: Schema.optionalKey(Schema.Boolean),
  includePinned: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEMORY_CONTEXT_LIMIT_MAX })),
  ),
  maxChars: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEMORY_CONTEXT_MAX_CHARS_LIMIT })),
  ).annotate({ description: `Defaults to ${MEMORY_CONTEXT_MAX_CHARS_DEFAULT}.` }),
});
export type MemoryContextInput = typeof MemoryContextInput.Type;

export const memoryJson = <S extends Schema.Top>(schema: S) => Schema.fromJsonString(schema);
