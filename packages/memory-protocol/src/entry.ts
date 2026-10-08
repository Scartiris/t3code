import * as Schema from "effect/Schema";

import {
  EpochMillis,
  MemoryId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  UnitInterval,
} from "./base.ts";

/**
 * What a memory is, not where it came from.
 *
 * Deliberately four kinds. `progress`- and `experience`-shaped notes belong to
 * the thread that produced them, and both T3 Code and Grok Build already keep
 * that state; duplicating it here is what makes a memory store noisy enough
 * that agents stop trusting it.
 */
export const MEMORY_KINDS = ["fact", "preference", "decision", "reference"] as const;
export const MemoryKind = Schema.Literals(MEMORY_KINDS);
export type MemoryKind = typeof MemoryKind.Type;

/**
 * `global` is visible from every project, `project` only where `projectId`
 * matches. This pair is the whole of the "unified but not leaky" rule.
 */
export const MEMORY_SCOPES = ["global", "project"] as const;
export const MemoryScope = Schema.Literals(MEMORY_SCOPES);
export type MemoryScope = typeof MemoryScope.Type;

/**
 * `superseded` exists so a corrected fact can replace an old one without
 * deleting the history that explains why anyone believed it. Only `active`
 * entries are searched, injected, or returned by `/v1/context`.
 */
export const MEMORY_STATUSES = ["active", "superseded", "archived"] as const;
export const MemoryStatus = Schema.Literals(MEMORY_STATUSES);
export type MemoryStatus = typeof MemoryStatus.Type;

/**
 * `pending` is reserved for the curation pipeline that writes memories on a
 * user's behalf. Explicit writes are always `accepted`; nothing reads `pending`
 * yet, and this field exists now so that pipeline needs no migration.
 */
export const MEMORY_REVIEW_STATES = ["accepted", "pending"] as const;
export const MemoryReviewState = Schema.Literals(MEMORY_REVIEW_STATES);
export type MemoryReviewState = typeof MemoryReviewState.Type;

export const MEMORY_SOURCE_KINDS = ["agent", "human", "import", "system"] as const;
export const MemorySourceKind = Schema.Literals(MEMORY_SOURCE_KINDS);
export type MemorySourceKind = typeof MemorySourceKind.Type;

/**
 * Provenance. A memory store's failure mode is junk that nobody can trace, so
 * every write records who produced it and, for agents, which thread and turn.
 */
export const MemorySource = Schema.Struct({
  kind: MemorySourceKind,
  agent: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  providerInstanceId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  threadId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  turnId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  sessionId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  url: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type MemorySource = typeof MemorySource.Type;

export const MEMORY_TITLE_MAX_CHARS = 120;
export const MEMORY_BODY_MAX_CHARS = 8_000;
export const MEMORY_TAGS_MAX = 16;
export const MEMORY_TAG_MAX_CHARS = 48;
export const MEMORY_DEDUPE_KEY_MAX_CHARS = 200;
export const MEMORY_QUERY_MAX_CHARS = 500;
export const MEMORY_REASON_MAX_CHARS = 500;
export const MEMORY_LIMIT_MAX = 50;
export const MEMORY_LIMIT_DEFAULT = 20;
export const MEMORY_BATCH_MAX = 50;
export const MEMORY_CONTEXT_MAX_CHARS_DEFAULT = 2_000;
export const MEMORY_CONTEXT_MAX_CHARS_LIMIT = 12_000;
export const MEMORY_CONTEXT_LIMIT_MAX = 20;
export const MEMORY_CONTEXT_PINNED_LIMIT = 20;

export const MemoryTag = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MEMORY_TAG_MAX_CHARS),
).annotate({ description: `Lowercase-ish free-form tag, at most ${MEMORY_TAGS_MAX} per entry.` });

/** One stored memory, as every transport reports it. */
export const MemoryEntry = Schema.Struct({
  id: MemoryId,
  /** Bumped on every write; callers pass it back as `expectedVersion` to avoid lost updates. */
  version: PositiveInt,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_TITLE_MAX_CHARS)),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(MEMORY_BODY_MAX_CHARS)),
  kind: MemoryKind,
  scope: MemoryScope,
  projectId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  tags: Schema.Array(MemoryTag),
  /** Pinned entries are injected at the start of a session; everything else is pulled on demand. */
  pinned: Schema.Boolean,
  importance: UnitInterval,
  status: MemoryStatus,
  supersededBy: Schema.NullOr(MemoryId),
  /** A fact with a shelf life ("we are migrating, so keep X in mind") ages out on its own. */
  expiresAt: Schema.NullOr(EpochMillis),
  dedupeKey: Schema.NullOr(TrimmedNonEmptyString),
  reviewState: MemoryReviewState,
  source: MemorySource,
  hitCount: NonNegativeInt,
  lastAccessedAt: Schema.NullOr(EpochMillis),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type MemoryEntry = typeof MemoryEntry.Type;

/**
 * Audit events record *changes*, not reads. Recall traffic is counted on the
 * entry (`hitCount`, `lastAccessedAt`) so that searching does not append a row
 * per query.
 */
export const MEMORY_EVENT_TYPES = ["created", "updated", "status-changed"] as const;
export const MemoryEventType = Schema.Literals(MEMORY_EVENT_TYPES);
export type MemoryEventType = typeof MemoryEventType.Type;

export const MemoryEvent = Schema.Struct({
  id: NonNegativeInt,
  entryId: MemoryId,
  type: MemoryEventType,
  at: EpochMillis,
  actor: MemorySource,
  detail: Schema.NullOr(Schema.String),
});
export type MemoryEvent = typeof MemoryEvent.Type;
