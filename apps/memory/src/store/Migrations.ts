import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0001 from "./migrations/001_InitializeMemory.ts";

/**
 * Migration ids are part of the database, not of this file: a database records
 * `{id}_{name}` and skips anything at or below its high-water mark. Never
 * renumber or rename a migration that has shipped.
 */
export const migrationEntries = [[1, "InitializeMemory", Migration0001]] as const;

const run = Migrator.make({});

export const runMigrations = Effect.fn("runMigrations")(function* () {
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.logInfo("Memory migrations applied").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
  // The service and the CLI can point at the same file; wait rather than fail.
  yield* sql`PRAGMA busy_timeout = 5000;`;
});
