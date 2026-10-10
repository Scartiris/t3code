import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  type MemoryApiError,
  type MemoryBatchCreateResult,
  type MemoryContextInput,
  type MemoryContextResult,
  type MemoryCreateInput,
  type MemoryDeleteResult,
  type MemoryEntry,
  type MemoryForgetToolInput,
  type MemoryId,
  type MemoryRememberToolInput,
  type MemorySearchInput,
  type MemorySearchResult,
  type MemorySource,
  type MemoryUpdateToolInput,
  type MemoryClient,
  makeMemoryClient,
  memoryErrorFromUnknown,
} from "@t3tools/memory-protocol";

import { readMemoryConnection, type MemoryConnection } from "./MemoryConnection.ts";
import * as OpenVikingMemoryService from "./OpenVikingMemoryService.ts";

/**
 * Read budget for anything on a turn's critical path. The prewarm happens while
 * a provider session is being prepared, and a slow memory service must cost a
 * turn a moment, not the turn itself.
 */
export const MEMORY_READ_TIMEOUT_MS = 2_500;
export const MEMORY_WRITE_TIMEOUT_MS = 5_000;

/**
 * This server's view of the memory service.
 *
 * Thin on purpose: it maps the client's exceptions into the effect error
 * channel and attaches the calling thread's provenance, so handlers and the
 * prompt path never touch HTTP.
 */
export interface MemoryServiceShape {
  readonly get: (id: MemoryId) => Effect.Effect<MemoryEntry, MemoryApiError>;
  readonly context: (
    input: MemoryContextInput,
  ) => Effect.Effect<MemoryContextResult, MemoryApiError>;
  readonly search: (input: MemorySearchInput) => Effect.Effect<MemorySearchResult, MemoryApiError>;
  readonly remember: (
    input: MemoryRememberToolInput,
    source: MemorySource,
  ) => Effect.Effect<MemoryBatchCreateResult, MemoryApiError>;
  readonly update: (
    input: MemoryUpdateToolInput,
    source: MemorySource,
  ) => Effect.Effect<MemoryEntry, MemoryApiError>;
  readonly forget: (
    input: MemoryForgetToolInput,
    source: MemorySource,
  ) => Effect.Effect<MemoryDeleteResult, MemoryApiError>;
  readonly restore: (
    id: MemoryId,
    source: MemorySource,
  ) => Effect.Effect<MemoryDeleteResult, MemoryApiError>;
}

export class MemoryService extends Context.Service<MemoryService, MemoryServiceShape>()(
  "t3/memory/MemoryService",
) {}

export const makeMemoryService = (connection: MemoryConnection): MemoryServiceShape => {
  const base = {
    baseUrl: connection.baseUrl,
    token: connection.token,
    readTimeoutMs: MEMORY_READ_TIMEOUT_MS,
    writeTimeoutMs: MEMORY_WRITE_TIMEOUT_MS,
  };

  // A client is a closure over config, so building one per call is free and
  // keeps `source` a per-call value instead of mutable client state.
  const call = <A>(
    source: MemorySource | undefined,
    run: (client: MemoryClient) => Promise<A>,
  ): Effect.Effect<A, MemoryApiError> =>
    Effect.tryPromise({
      try: () => run(makeMemoryClient(source === undefined ? base : { ...base, source })),
      catch: (cause) => memoryErrorFromUnknown(cause),
    });

  return {
    get: (id) => call(undefined, (client) => client.get(id)),
    context: (input) => call(undefined, (client) => client.context(input)),
    search: (input) => call(undefined, (client) => client.search(input)),
    remember: (input, source) =>
      call(source, (client) =>
        client.createBatch({
          entries: input.entries.map((entry: MemoryCreateInput) =>
            entry.source === undefined ? { ...entry, source } : entry,
          ),
        }),
      ),
    update: (input, source) =>
      call(source, (client) => {
        const { id, ...patch } = input;
        return client.update(id, patch);
      }),
    forget: (input, source) =>
      call(source, (client) => {
        const supersededBy = input.supersededBy ?? null;
        return client.setStatus(input.id, {
          status: supersededBy === null ? "archived" : "superseded",
          supersededBy,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
      }),
    restore: (id, source) => call(source, (client) => client.setStatus(id, { status: "active" })),
  };
};

export const layer = (connection: MemoryConnection): Layer.Layer<MemoryService> =>
  connection.backend === "openviking"
    ? Layer.effect(
        MemoryService,
        OpenVikingMemoryService.make(
          { baseUrl: connection.baseUrl, apiKey: connection.token },
          {
            readTimeoutMs: MEMORY_READ_TIMEOUT_MS,
            writeTimeoutMs: MEMORY_WRITE_TIMEOUT_MS,
          },
        ),
      ).pipe(Layer.provide(FetchHttpClient.layer))
    : Layer.succeed(MemoryService, makeMemoryService(connection));

/** A startup line an operator can act on when memory was configured wrongly. */
export const memoryConnectionProblem = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  readMemoryConnection(env).problem;
