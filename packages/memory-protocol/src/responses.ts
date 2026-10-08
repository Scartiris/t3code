import * as Schema from "effect/Schema";

import { MemoryId, NonNegativeInt, TrimmedNonEmptyString } from "./base.ts";
import { MemoryEntry, MemoryEvent, MemorySource } from "./entry.ts";
import { MemoryErrorInfo } from "./errors.ts";

/** A ranked hit. `snippet` is the excerpt a caller can show without loading the body. */
export const MemoryHit = Schema.Struct({
  entry: MemoryEntry,
  score: Schema.Number,
  snippet: Schema.String,
});
export type MemoryHit = typeof MemoryHit.Type;

export const MemorySearchResult = Schema.Struct({
  items: Schema.Array(MemoryHit),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
});
export type MemorySearchResult = typeof MemorySearchResult.Type;

export const MemoryContextResult = Schema.Struct({
  /**
   * Ready to paste into a system prompt. Deterministic: no ids, no timestamps,
   * no hit counts, so the same inputs always produce the same bytes.
   */
  text: Schema.String,
  hits: Schema.Array(MemoryHit),
  pinned: Schema.Array(MemoryEntry),
  truncated: Schema.Boolean,
  chars: NonNegativeInt,
  /** True when nothing was written because no memory matched. */
  empty: Schema.Boolean,
});
export type MemoryContextResult = typeof MemoryContextResult.Type;

export const MemoryCreateResult = Schema.Struct({
  entry: MemoryEntry,
  /** True when `dedupeKey` matched an existing entry and nothing was written. */
  duplicate: Schema.Boolean,
});
export type MemoryCreateResult = typeof MemoryCreateResult.Type;

export const MemoryBatchItemResult = Schema.Struct({
  ok: Schema.Boolean,
  entry: Schema.NullOr(MemoryEntry),
  error: Schema.NullOr(MemoryErrorInfo),
});
export type MemoryBatchItemResult = typeof MemoryBatchItemResult.Type;

export const MemoryBatchCreateResult = Schema.Struct({
  results: Schema.Array(MemoryBatchItemResult),
});
export type MemoryBatchCreateResult = typeof MemoryBatchCreateResult.Type;

export const MemoryDeleteResult = Schema.Struct({
  id: MemoryId,
  status: Schema.Literals(["active", "superseded", "archived"]),
});
export type MemoryDeleteResult = typeof MemoryDeleteResult.Type;

export const MemoryHistoryResult = Schema.Struct({
  entryId: MemoryId,
  events: Schema.Array(MemoryEvent),
});
export type MemoryHistoryResult = typeof MemoryHistoryResult.Type;

export const MemoryRebuildIndexResult = Schema.Struct({
  indexed: NonNegativeInt,
  tookMs: NonNegativeInt,
});
export type MemoryRebuildIndexResult = typeof MemoryRebuildIndexResult.Type;

export const MemoryHealthCounts = Schema.Struct({
  active: NonNegativeInt,
  superseded: NonNegativeInt,
  archived: NonNegativeInt,
  pinned: NonNegativeInt,
});

export const MemoryHealthResult = Schema.Struct({
  ok: Schema.Boolean,
  service: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  protocolVersion: TrimmedNonEmptyString,
  entries: MemoryHealthCounts,
  databasePath: Schema.String,
  databaseBytes: NonNegativeInt,
  /** False means every authenticated route answers 401; the service is not usable yet. */
  tokenConfigured: Schema.Boolean,
  startedAt: NonNegativeInt,
  lastWriteAt: Schema.NullOr(NonNegativeInt),
});
export type MemoryHealthResult = typeof MemoryHealthResult.Type;

export const MemorySourceInput = MemorySource;
