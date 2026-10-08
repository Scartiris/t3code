// The dispatcher parses a request body once, before handing the value to a
// schema, and reads one header as JSON. Both are transport concerns.
// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  MEMORY_API_PREFIX,
  MEMORY_MCP_PATH,
  MEMORY_SOURCE_HEADER,
  type MemoryApiError,
  MemoryBatchCreateInput,
  MemoryContextInput,
  MemoryId,
  MemoryListInput,
  MemorySearchInput,
  MemorySource,
  MemoryStatusChangeInput,
  MemoryUpdateInput,
  MemoryWriteInput,
  memoryApiFailure,
  memoryListInputFromSearchParams,
} from "@t3tools/memory-protocol";

import { type MemoryServiceShape, toApiError } from "../service/MemoryService.ts";
import { bearerOf, rejectUnauthorized, type MemoryAuthOptions } from "./auth.ts";

/**
 * One catch-all route with an internal dispatcher.
 *
 * The service is small, and every path shares two rules — `/health` is open,
 * everything else needs the bearer token — so a per-route table would spread
 * that rule across a dozen registrations and still need the same manual tail
 * parsing for `/entries/<id>/status`. Routes here are exact paths, not patterns.
 */
const MAX_BODY_BYTES = 256 * 1024;

const jsonResponse = (value: unknown, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(value, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorResponse = (error: MemoryApiError): HttpServerResponse.HttpServerResponse =>
  jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    error.status === 0 ? 500 : error.status,
  );

const decodeId = Schema.decodeUnknownOption(MemoryId);
const decodeWrite = Schema.decodeUnknownOption(MemoryWriteInput);
const decodeBatch = Schema.decodeUnknownOption(MemoryBatchCreateInput);
const decodeUpdate = Schema.decodeUnknownOption(MemoryUpdateInput);
const decodeStatusChange = Schema.decodeUnknownOption(MemoryStatusChangeInput);
const decodeList = Schema.decodeUnknownOption(MemoryListInput);
const decodeSearch = Schema.decodeUnknownOption(MemorySearchInput);
const decodeContext = Schema.decodeUnknownOption(MemoryContextInput);

const invalidBody = (what: string, cause: unknown): MemoryApiError =>
  memoryApiFailure("invalid_request", `The ${what} payload was rejected.`, {
    reason: String(cause).slice(0, 400),
  });

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Reads and size-caps a JSON body, then decodes it with the protocol schema. */
const readJson = <A>(
  request: HttpServerRequest.HttpServerRequest,
  decoded: (value: unknown) => Option.Option<A>,
  what: string,
): Effect.Effect<A, MemoryApiError> =>
  Effect.gen(function* () {
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    if (text.length > MAX_BODY_BYTES) {
      return yield* memoryApiFailure(
        "invalid_request",
        `The ${what} payload exceeds ${MAX_BODY_BYTES} bytes.`,
      );
    }
    const raw: unknown = text.trim().length === 0 ? null : safeJson(text);
    if (raw === null) {
      return yield* memoryApiFailure("invalid_request", `The ${what} payload must be JSON.`);
    }
    const parsed = decoded(raw);
    if (Option.isNone(parsed)) return yield* invalidBody(what, "schema mismatch");
    return parsed.value;
  });

const tailAfter = (path: string, prefix: string): string | undefined =>
  path.startsWith(prefix) ? path.slice(prefix.length) : undefined;

const decodeSource = Schema.decodeUnknownOption(MemorySource);

/**
 * Provenance for a write, from the caller's header.
 *
 * A malformed header is ignored rather than rejected: provenance improves the
 * audit trail, and refusing a legitimate write over it would trade a real
 * capability for a metadata nicety.
 */
const actorOf = (request: HttpServerRequest.HttpServerRequest): MemorySource => {
  const raw = request.headers[MEMORY_SOURCE_HEADER];
  if (typeof raw !== "string" || raw.length === 0) return { kind: "agent" };
  const parsed = safeJson(raw);
  if (parsed === null) return { kind: "agent" };
  const decoded = decodeSource(parsed);
  return Option.isSome(decoded) ? decoded.value : { kind: "agent" };
};

/**
 * The dispatcher.
 *
 * Returns a response for every input: a failure inside a service call becomes
 * the same error envelope, so a caller never has to parse two shapes.
 */
export const memoryHttpHandler = (
  options: MemoryAuthOptions,
  service: MemoryServiceShape,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return errorResponse(
        memoryApiFailure("invalid_request", "The request URL is not parseable."),
      );
    }
    const path = url.value.pathname.replace(/\/+$/u, "") || "/";
    const method = request.method.toUpperCase();

    const run = <A>(
      effect: Effect.Effect<A, MemoryApiError>,
      respond: (value: A) => HttpServerResponse.HttpServerResponse,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
      effect.pipe(
        Effect.map(respond),
        Effect.catch((error) => Effect.succeed(errorResponse(error))),
      );

    // Open on purpose: an operator diagnosing a dead service must be able to ask
    // whether it is up, and the answer carries counts and paths, not content.
    if (method === "GET" && path === "/health") {
      // tokenConfigured is reported from the auth options, not the startup
      // snapshot: it predicts what rejectUnauthorized below will do, and health
      // must not lie about the half of the service that actually answers 401.
      return yield* run(service.health(), (health) =>
        jsonResponse({ ...health, tokenConfigured: options.token !== undefined }),
      );
    }

    const rejected = rejectUnauthorized(request, options);
    if (rejected !== undefined) {
      yield* Effect.logWarning("rejected memory request", {
        path,
        reason: bearerOf(request).length === 0 ? "missing_bearer_token" : "wrong_token",
      });
      return rejected;
    }

    const actor = actorOf(request);

    const body = <A>(
      decoded: (value: unknown) => Option.Option<A>,
      what: string,
    ): Effect.Effect<A, MemoryApiError> => readJson(request, decoded, what);

    if (method === "POST" && path === `${MEMORY_API_PREFIX}/entries`) {
      return yield* body(decodeWrite, "memory").pipe(
        Effect.flatMap((input) =>
          run(service.create(input, actor), (result) =>
            jsonResponse(result, result.duplicate ? 200 : 201),
          ),
        ),
        Effect.catch((error) => Effect.succeed(errorResponse(error))),
      );
    }

    if (method === "POST" && path === `${MEMORY_API_PREFIX}/entries/batch`) {
      return yield* body(decodeBatch, "memory batch").pipe(
        Effect.flatMap((input) =>
          run(service.createBatch(input, actor), (result) => jsonResponse(result)),
        ),
        Effect.catch((error) => Effect.succeed(errorResponse(error))),
      );
    }

    if (method === "POST" && path === `${MEMORY_API_PREFIX}/search`) {
      return yield* body(decodeSearch, "search").pipe(
        Effect.flatMap((input) => run(service.search(input), (result) => jsonResponse(result))),
        Effect.catch((error) => Effect.succeed(errorResponse(error))),
      );
    }

    if (method === "POST" && path === `${MEMORY_API_PREFIX}/context`) {
      return yield* body(decodeContext, "context").pipe(
        Effect.flatMap((input) => run(service.context(input), (result) => jsonResponse(result))),
        Effect.catch((error) => Effect.succeed(errorResponse(error))),
      );
    }

    if (method === "POST" && path === `${MEMORY_API_PREFIX}/index/rebuild`) {
      return yield* run(service.rebuildIndex(), (result) => jsonResponse(result));
    }

    if (method === "GET" && path === `${MEMORY_API_PREFIX}/entries`) {
      const decoded = decodeList(memoryListInputFromSearchParams(url.value.searchParams));
      if (Option.isNone(decoded)) {
        return errorResponse(invalidBody("list filter", "schema mismatch"));
      }
      return yield* run(service.list(decoded.value), (result) => jsonResponse(result));
    }

    const tail = tailAfter(path, `${MEMORY_API_PREFIX}/entries/`);
    if (tail !== undefined && tail.length > 0) {
      const isHistory = tail.endsWith("/history");
      const isStatus = tail.endsWith("/status");
      const rawId = isHistory
        ? tail.slice(0, -"/history".length)
        : isStatus
          ? tail.slice(0, -"/status".length)
          : tail;
      const id = decodeId(decodeURIComponent(rawId));
      if (Option.isNone(id)) {
        return errorResponse(memoryApiFailure("invalid_request", `"${rawId}" is not a memory id.`));
      }

      if (method === "GET" && !isHistory && !isStatus) {
        return yield* run(service.get(id.value), (entry) => jsonResponse(entry));
      }
      if (method === "GET" && isHistory) {
        return yield* run(service.history(id.value), (result) => jsonResponse(result));
      }
      if (method === "PATCH" && !isHistory && !isStatus) {
        return yield* body(decodeUpdate, "update").pipe(
          Effect.flatMap((input) =>
            run(service.update(id.value, input, actor), (entry) => jsonResponse(entry)),
          ),
          Effect.catch((error) => Effect.succeed(errorResponse(error))),
        );
      }
      if (method === "POST" && isStatus) {
        return yield* body(decodeStatusChange, "status change").pipe(
          Effect.flatMap((input) =>
            run(service.setStatus(id.value, input, actor), (result) => jsonResponse(result)),
          ),
          Effect.catch((error) => Effect.succeed(errorResponse(error))),
        );
      }
    }

    return errorResponse(
      memoryApiFailure("not_found", `No memory route matches ${method} ${path}.`, {
        mcp: MEMORY_MCP_PATH,
      }),
    );
  }).pipe(Effect.catch((cause) => Effect.succeed(errorResponse(toApiError(cause)))));

export const memoryHttpRouteLayer = (options: MemoryAuthOptions, service: MemoryServiceShape) =>
  HttpRouter.add("*", "/*", memoryHttpHandler(options, service));
