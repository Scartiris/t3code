// The service's own client is exercised by swapping the global fetch.
// @effect-diagnostics globalFetch:off globalFetchInEffect:off
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MemoryId, type MemorySource } from "@t3tools/memory-protocol";

import { makeMemoryService } from "./MemoryService.ts";

const connection = { baseUrl: "http://memory.test", token: "t".repeat(40) };

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Swaps the global fetch for one call, so the service's own client is exercised. */
const withFetch = <A, E>(
  respond: (seen: Seen) => Response,
  seen: Array<Seen>,
  use: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        seen.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: (init?.headers ?? {}) as Record<string, string>,
          body,
        });
        return respond(seen[seen.length - 1] as Seen);
      }) as typeof fetch;
      return original;
    }),
    () => use,
    (original) =>
      Effect.sync(() => {
        globalThis.fetch = original;
      }),
  );

const searchResult = { items: [], total: 0, nextCursor: null };
const contextResult = {
  text: "<t3_memory>\nx\n</t3_memory>",
  hits: [],
  pinned: [],
  truncated: false,
  chars: 20,
  empty: false,
};

describe("memory service client", () => {
  it.effect("searches through the protocol route with a bearer token", () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = [];
      const service = makeMemoryService(connection);
      const result = yield* withFetch(
        () => Response.json(searchResult),
        seen,
        service.search({ query: "部署", projectId: "proj-1" }),
      );
      assert.strictEqual(seen[0]?.url, "http://memory.test/v1/search");
      assert.strictEqual(seen[0]?.method, "POST");
      assert.strictEqual(seen[0]?.headers.authorization, `Bearer ${connection.token}`);
      assert.deepStrictEqual(seen[0]?.body, { query: "部署", projectId: "proj-1" });
      assert.strictEqual(result.total, 0);
    }),
  );

  it.effect("asks for the rendered context block", () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = [];
      const service = makeMemoryService(connection);
      const result = yield* withFetch(
        () => Response.json(contextResult),
        seen,
        service.context({ projectId: "proj-1" }),
      );
      assert.strictEqual(seen[0]?.url, "http://memory.test/v1/context");
      assert.include(result.text, "t3_memory");
    }),
  );

  it.effect("attributes writes to the calling thread", () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = [];
      const service = makeMemoryService(connection);
      const source: MemorySource = {
        kind: "agent",
        threadId: "thread-1",
        providerInstanceId: "claude",
      };
      yield* withFetch(
        () => Response.json({ results: [] }),
        seen,
        service.remember(
          { entries: [{ title: "t", body: "b", kind: "fact", scope: "global" }] },
          source,
        ),
      );
      assert.strictEqual(seen[0]?.headers["x-memory-source"], encodeJson(source));
      assert.deepStrictEqual(
        (seen[0]?.body as { entries: ReadonlyArray<{ source?: MemorySource }> }).entries[0]?.source,
        source,
      );
    }),
  );

  it.effect("reports an unauthorized service as unauthorized", () =>
    Effect.gen(function* () {
      const service = makeMemoryService(connection);
      const failure = yield* withFetch(
        () =>
          Response.json(
            { error: { code: "unauthorized", message: "A valid bearer token is required." } },
            { status: 401 },
          ),
        [],
        service.search({ query: "x" }).pipe(Effect.flip),
      );
      assert.strictEqual(failure.code, "unauthorized");
      assert.strictEqual(failure.status, 401);
    }),
  );

  it.effect("reports an unreachable service as unavailable rather than failing the turn", () =>
    Effect.gen(function* () {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3211");
      }) as typeof fetch;
      const service = makeMemoryService(connection);
      const failure = yield* service.search({ query: "x" }).pipe(
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = original;
          }),
        ),
      );
      assert.strictEqual(failure.code, "unavailable");
      assert.strictEqual(failure.status, 0);
    }),
  );

  it.effect("sends a version-checked update", () =>
    Effect.gen(function* () {
      const seen: Array<Seen> = [];
      const service = makeMemoryService(connection);
      yield* withFetch(
        () =>
          Response.json({
            id: "mem_1",
            version: 2,
            title: "t",
            body: "b",
            kind: "fact",
            scope: "global",
            projectId: null,
            tags: [],
            pinned: false,
            importance: 0.5,
            status: "active",
            supersededBy: null,
            expiresAt: null,
            dedupeKey: null,
            reviewState: "accepted",
            source: { kind: "agent" },
            hitCount: 0,
            lastAccessedAt: null,
            createdAt: 1,
            updatedAt: 2,
          }),
        seen,
        service.update(
          { id: MemoryId.make("mem_1"), title: "改", expectedVersion: 1 },
          { kind: "agent" },
        ),
      );
      assert.strictEqual(seen[0]?.method, "PATCH");
      assert.deepStrictEqual(seen[0]?.body, { title: "改", expectedVersion: 1 });
    }),
  );
});
