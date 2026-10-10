// @effect-diagnostics nodeBuiltinImport:off
// Standalone snapshot/export operations use synchronous Node APIs before any remote writes.
// Bundle with Vite+ Pack before running on the host; see the deployment runbook.
import * as NodeUtil from "node:util";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { MemoryEntry } from "../../../packages/memory-protocol/src/index.ts";
import { makeOpenVikingClient } from "../src/memory/OpenVikingClient.ts";
import {
  memoryTags,
  memoryUri,
  parseMemoryFile,
  renderMemoryFile,
} from "../src/memory/OpenVikingMemory.ts";

const [database, backupDir, keyFile, baseUrl = "http://127.0.0.1:1933"] = process.argv.slice(2);
if (!database || !backupDir || !keyFile)
  throw new Error(
    "Usage: migrate-openviking <legacy.sqlite> <new-backup-dir> <user-key-file> [OpenViking URL]",
  );

// A fresh snapshot and export precede every write, including retries. Never open
// the live database read-write or silently replace a newer OpenViking entry.
NodeFS.mkdirSync(backupDir, { mode: 0o700 });
const snapshot = NodePath.join(backupDir, "memory.sqlite");
const live = new NodeSqlite.DatabaseSync(database, { readOnly: true });
try {
  live.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
} finally {
  live.close();
}
NodeFS.chmodSync(snapshot, 0o600);
const db = new NodeSqlite.DatabaseSync(snapshot, { readOnly: true });
const decode = Schema.decodeUnknownSync(MemoryEntry);
const entries = db
  .prepare("SELECT * FROM memory_entries ORDER BY id")
  .all()
  .map((row) =>
    decode({
      id: row.id,
      version: row.version,
      title: row.title,
      body: row.body,
      kind: row.kind,
      scope: row.scope,
      projectId: row.project_id,
      tags: JSON.parse(String(row.tags_json)),
      pinned: Boolean(row.pinned),
      importance: row.importance,
      status: row.status,
      supersededBy: row.superseded_by,
      expiresAt: row.expires_at,
      dedupeKey: row.dedupe_key,
      reviewState: row.review_state,
      source: JSON.parse(String(row.source_json)),
      hitCount: row.hit_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
const events = db.prepare("SELECT * FROM memory_events ORDER BY id").all();
db.close();
NodeFS.writeFileSync(
  NodePath.join(backupDir, "export.json"),
  JSON.stringify({ entries, events }, null, 2),
  {
    mode: 0o600,
  },
);

await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* makeOpenVikingClient(
      { baseUrl, apiKey: NodeFS.readFileSync(keyFile, "utf8").trim() },
      { readTimeoutMs: 10_000, writeTimeoutMs: 30_000 },
    );
    for (const entry of entries) {
      const uri = memoryUri(entry.id);
      const existing = yield* client.readRaw(uri).pipe(
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => Effect.succeed(undefined),
        ),
      );
      if (existing !== undefined && !NodeUtil.isDeepStrictEqual(parseMemoryFile(existing), entry)) {
        throw new Error(`Refusing to overwrite different OpenViking memory ${entry.id}`);
      }
      if (existing === undefined)
        yield* client.write({
          uri,
          content: renderMemoryFile(entry),
          mode: "create",
          tags: memoryTags(entry),
        });
      const imported = parseMemoryFile(yield* client.readRaw(uri));
      if (!NodeUtil.isDeepStrictEqual(imported, entry))
        throw new Error(`Round-trip verification failed for ${entry.id}`);
    }
    yield* Effect.log(
      `Verified ${entries.length} memories; ${events.length} legacy audit events saved in ${backupDir}.`,
    );
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
