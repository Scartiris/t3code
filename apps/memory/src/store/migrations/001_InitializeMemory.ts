import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The memory schema.
 *
 * `memory_entries` is the record; `memory_fts` is a derived index that can be
 * thrown away and rebuilt from it, which is why the two are written in the same
 * transaction but never read from each other's state.
 *
 * `search_text` is the normalized title/body/tags, kept as a plain column so
 * the substring fallback for one-character CJK queries has something to scan.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_id TEXT,
      tags_json TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      importance REAL NOT NULL,
      status TEXT NOT NULL,
      superseded_by TEXT,
      expires_at INTEGER,
      dedupe_key TEXT,
      review_state TEXT NOT NULL,
      source_json TEXT NOT NULL,
      hit_count INTEGER NOT NULL,
      last_accessed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      search_text TEXT NOT NULL
    )
  `;

  // Visibility is the query every read starts from: active rows, for this
  // project or global ones.
  yield* sql`
    CREATE INDEX IF NOT EXISTS memory_entries_visibility_idx
      ON memory_entries (status, scope, project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS memory_entries_updated_idx
      ON memory_entries (updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS memory_entries_pinned_idx
      ON memory_entries (pinned, created_at)
  `;

  // A `dedupeKey` is unique within its scope and project, so a retried write or
  // two agents learning the same fact collapse onto one row. Partial, because
  // most entries have no key at all.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_dedupe_idx
      ON memory_entries (scope, IFNULL(project_id, ''), dedupe_key)
      WHERE dedupe_key IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL,
      type TEXT NOT NULL,
      at INTEGER NOT NULL,
      actor_json TEXT NOT NULL,
      detail TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS memory_events_entry_idx
      ON memory_events (entry_id, id)
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
      USING fts5 (entry_id UNINDEXED, norm, grams)
  `;
});
