// The client is transport: it reads and writes JSON over the platform's fetch
// and bounds each call with a timeout signal. Every payload it accepts is
// decoded by a schema before a caller sees it.
// @effect-diagnostics preferSchemaOverJson:off globalFetch:off globalFetchInEffect:off globalTimers:off globalTimersInEffect:off
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MemoryId } from "./base.ts";
import { MemoryEntry, MemoryEvent, type MemorySource } from "./entry.ts";
import { MemoryApiError, MemoryErrorResponse } from "./errors.ts";
import { MEMORY_API_PREFIX, MEMORY_SOURCE_HEADER } from "./protocol.ts";
import { memoryListInputToSearchParams } from "./query.ts";
import type {
  MemoryBatchCreateInput,
  MemoryContextInput,
  MemoryCreateInput,
  MemoryListInput,
  MemorySearchInput,
  MemoryStatusChangeInput,
  MemoryUpdateInput,
} from "./requests.ts";
import {
  MemoryBatchCreateResult,
  MemoryContextResult,
  MemoryCreateResult,
  MemoryDeleteResult,
  MemoryHealthResult,
  MemoryHistoryResult,
  MemoryRebuildIndexResult,
  MemorySearchResult,
} from "./responses.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface MemoryClientOptions {
  /** Origin of the memory service, e.g. `http://127.0.0.1:3211`. */
  readonly baseUrl: string;
  readonly token: string;
  /**
   * Who is calling, recorded on writes as provenance. Sent as a header rather
   * than in each body: it describes the caller, not the payload, and a proxy
   * (T3 Code) knows it without the agent having to.
   */
  readonly source?: MemorySource | undefined;
  /** Budget for reads. A caller waiting on a turn start wants this short. */
  readonly readTimeoutMs?: number | undefined;
  readonly writeTimeoutMs?: number | undefined;
  /** Injection point for tests; defaults to global `fetch`. */
  readonly fetchImplementation?: FetchLike | undefined;
}

export interface MemoryClient {
  readonly health: () => Promise<MemoryHealthResult>;
  readonly create: (input: MemoryCreateInput) => Promise<MemoryCreateResult>;
  readonly createBatch: (input: MemoryBatchCreateInput) => Promise<MemoryBatchCreateResult>;
  readonly get: (id: MemoryId) => Promise<MemoryEntry>;
  readonly update: (id: MemoryId, input: MemoryUpdateInput) => Promise<MemoryEntry>;
  readonly setStatus: (id: MemoryId, input: MemoryStatusChangeInput) => Promise<MemoryDeleteResult>;
  readonly list: (input: MemoryListInput) => Promise<MemorySearchResult>;
  readonly search: (input: MemorySearchInput) => Promise<MemorySearchResult>;
  readonly context: (input: MemoryContextInput) => Promise<MemoryContextResult>;
  readonly history: (id: MemoryId) => Promise<MemoryHistoryResult>;
  readonly rebuildIndex: () => Promise<MemoryRebuildIndexResult>;
}

export const DEFAULT_READ_TIMEOUT_MS = 3_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 5_000;

const decodeHealth = Schema.decodeUnknownSync(MemoryHealthResult);
const decodeEntry = Schema.decodeUnknownSync(MemoryEntry);
const decodeEvent = Schema.decodeUnknownSync(MemoryEvent);
const decodeSearch = Schema.decodeUnknownSync(MemorySearchResult);
const decodeContext = Schema.decodeUnknownSync(MemoryContextResult);
const decodeHistory = Schema.decodeUnknownSync(MemoryHistoryResult);
const decodeCreate = Schema.decodeUnknownSync(MemoryCreateResult);
const decodeBatch = Schema.decodeUnknownSync(MemoryBatchCreateResult);
const decodeDelete = Schema.decodeUnknownSync(MemoryDeleteResult);
const decodeRebuild = Schema.decodeUnknownSync(MemoryRebuildIndexResult);
const decodeErrorResponse = Schema.decodeUnknownOption(MemoryErrorResponse);

const unexpectedPayload = (path: string, cause: unknown): MemoryApiError =>
  new MemoryApiError({
    code: "internal",
    message: `The memory service returned a payload this client cannot read (${path}).`,
    status: 0,
    details: { reason: String(cause).slice(0, 500) },
  });

export const makeMemoryClient = (options: MemoryClientOptions): MemoryClient => {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
  if (baseUrl.length === 0) {
    throw new MemoryApiError({
      code: "invalid_request",
      message: "A memory service URL is required.",
      status: 0,
    });
  }
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const fetchImplementation: FetchLike =
    options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init));

  const request = async (
    path: string,
    init: { readonly method: string; readonly body?: unknown },
    timeoutMs: number,
  ): Promise<unknown> => {
    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(options.source === undefined
            ? {}
            : { [MEMORY_SOURCE_HEADER]: JSON.stringify(options.source) }),
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      throw new MemoryApiError({
        code: "unavailable",
        message: timedOut
          ? `The memory service at ${baseUrl} did not answer within ${timeoutMs} ms.`
          : `Could not reach the memory service at ${baseUrl}.`,
        status: 0,
        details: { reason: String(cause).slice(0, 300) },
      });
    }

    const text = await response.text();
    const raw: unknown = text.length === 0 ? null : safeJson(text);
    if (!response.ok) {
      const decoded = decodeErrorResponse(raw);
      throw Option.isSome(decoded)
        ? new MemoryApiError({
            code: decoded.value.error.code,
            message: decoded.value.error.message,
            status: response.status,
            ...(decoded.value.error.details === undefined
              ? {}
              : { details: decoded.value.error.details }),
          })
        : new MemoryApiError({
            code: "internal",
            message: `The memory service returned HTTP ${response.status}.`,
            status: response.status,
          });
    }
    return raw;
  };

  const decodeOr = <A>(path: string, decoded: (raw: unknown) => A, raw: unknown): A => {
    try {
      return decoded(raw);
    } catch (cause) {
      throw unexpectedPayload(path, cause);
    }
  };

  return {
    health: async () =>
      decodeOr("/health", decodeHealth, await request("/health", { method: "GET" }, readTimeoutMs)),
    create: async (input) =>
      decodeOr(
        `${MEMORY_API_PREFIX}/entries`,
        decodeCreate,
        await request(
          `${MEMORY_API_PREFIX}/entries`,
          { method: "POST", body: input },
          writeTimeoutMs,
        ),
      ),
    createBatch: async (input) =>
      decodeOr(
        `${MEMORY_API_PREFIX}/entries/batch`,
        decodeBatch,
        await request(
          `${MEMORY_API_PREFIX}/entries/batch`,
          { method: "POST", body: input },
          writeTimeoutMs,
        ),
      ),
    get: async (id) =>
      decodeOr(
        `${MEMORY_API_PREFIX}/entries/${encodeURIComponent(id)}`,
        decodeEntry,
        await request(
          `${MEMORY_API_PREFIX}/entries/${encodeURIComponent(id)}`,
          { method: "GET" },
          readTimeoutMs,
        ),
      ),
    update: async (id, input) =>
      decodeOr(
        `${MEMORY_API_PREFIX}/entries/${encodeURIComponent(id)}`,
        decodeEntry,
        await request(
          `${MEMORY_API_PREFIX}/entries/${encodeURIComponent(id)}`,
          { method: "PATCH", body: input },
          writeTimeoutMs,
        ),
      ),
    setStatus: async (id, input) =>
      decodeOr(
        `${MEMORY_API_PREFIX}/entries/${encodeURIComponent(id)}/status`,
        decodeDelete,
        await request(
          `${MEMORY_API_PREFIX}/entries/${encodeURIComponent(id)}/status`,
          { method: "POST", body: input },
          writeTimeoutMs,
        ),
      ),
    list: async (input) => {
      const params = memoryListInputToSearchParams(input).toString();
      const path = `${MEMORY_API_PREFIX}/entries${params.length === 0 ? "" : `?${params}`}`;
      return decodeOr(path, decodeSearch, await request(path, { method: "GET" }, readTimeoutMs));
    },
    search: async (input) =>
      decodeOr(
        `${MEMORY_API_PREFIX}/search`,
        decodeSearch,
        await request(
          `${MEMORY_API_PREFIX}/search`,
          { method: "POST", body: input },
          readTimeoutMs,
        ),
      ),
    context: async (input) =>
      decodeOr(
        `${MEMORY_API_PREFIX}/context`,
        decodeContext,
        await request(
          `${MEMORY_API_PREFIX}/context`,
          { method: "POST", body: input },
          readTimeoutMs,
        ),
      ),
    history: async (id) =>
      decodeOr(
        `${MEMORY_API_PREFIX}/entries/${encodeURIComponent(id)}/history`,
        decodeHistory,
        await request(
          `${MEMORY_API_PREFIX}/entries/${encodeURIComponent(id)}/history`,
          { method: "GET" },
          readTimeoutMs,
        ),
      ),
    rebuildIndex: async () =>
      decodeOr(
        `${MEMORY_API_PREFIX}/index/rebuild`,
        decodeRebuild,
        await request(`${MEMORY_API_PREFIX}/index/rebuild`, { method: "POST" }, writeTimeoutMs),
      ),
  };
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const decodeMemoryEntry = decodeEntry;
export const decodeMemoryEvent = decodeEvent;
