import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { MemoryApiError, type MemoryErrorCode } from "@t3tools/memory-protocol";

/**
 * The slice of OpenViking's REST API the memory adapter uses, and nothing else.
 *
 * Every call authenticates as one OpenViking user, so `viking://~` is that
 * user's own space. Failures are mapped to memory-protocol codes here, once,
 * so the service above speaks one error vocabulary whatever the backend said.
 */
export interface OpenVikingConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
}

const Envelope = Schema.Struct({
  status: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        code: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const isMemoryApiError = Schema.is(MemoryApiError);

const ListEntry = Schema.Struct({
  uri: Schema.String,
  isDir: Schema.Boolean,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
const ListResult = Schema.Array(ListEntry);
const decodeList = Schema.decodeUnknownOption(ListResult);

const MatchedContext = Schema.Struct({
  uri: Schema.String,
  level: Schema.optionalKey(Schema.Number),
  score: Schema.optionalKey(Schema.Number),
});
const FindResult = Schema.Struct({
  memories: Schema.Array(MatchedContext),
});
const decodeFind = Schema.decodeUnknownOption(FindResult);
const decodeResourceFind = Schema.decodeUnknownOption(
  Schema.Struct({ resources: Schema.Array(MatchedContext) }),
);
const decodeWrite = Schema.decodeUnknownOption(
  Schema.Struct({
    content_updated: Schema.Boolean,
    vector_status: Schema.String,
  }),
);

const codeFor = (status: number, backendCode: string | undefined): MemoryErrorCode => {
  if (status === 401 || status === 403 || backendCode === "UNAUTHENTICATED") return "unauthorized";
  if (status === 404 || backendCode === "NOT_FOUND") return "not_found";
  if (status === 409 || backendCode === "ALREADY_EXISTS") return "conflict";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "internal";
};

const unavailable = (baseUrl: string, cause: unknown) =>
  new MemoryApiError({
    code: "unavailable",
    message: `Could not reach OpenViking at ${baseUrl}.`,
    status: 0,
    details: { reason: String(cause).slice(0, 300) },
  });

export const makeOpenVikingClient = (
  connection: OpenVikingConnection,
  options: { readonly readTimeoutMs: number; readonly writeTimeoutMs: number },
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const base = connection.baseUrl.replace(/\/+$/u, "");

    /** One request, decoded down to the envelope's `result`. */
    const call = (
      request: HttpClientRequest.HttpClientRequest,
      timeoutMs: number,
    ): Effect.Effect<unknown, MemoryApiError> =>
      Effect.gen(function* () {
        const response = yield* http.execute(
          request.pipe(
            HttpClientRequest.bearerToken(connection.apiKey),
            HttpClientRequest.acceptJson,
          ),
        );
        const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
        const envelope = decodeEnvelope(body);
        if (response.status >= 200 && response.status < 300 && Option.isSome(envelope)) {
          if (envelope.value.status === "ok") return envelope.value.result;
        }
        const error = Option.isSome(envelope) ? envelope.value.error : undefined;
        return yield* new MemoryApiError({
          code: codeFor(response.status, error?.code),
          message: error?.message ?? `OpenViking returned HTTP ${response.status}.`,
          status: response.status,
        });
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(timeoutMs),
          orElse: () =>
            Effect.fail(
              new MemoryApiError({
                code: "unavailable",
                message: `OpenViking at ${base} did not answer within ${timeoutMs} ms.`,
                status: 0,
              }),
            ),
        }),
        Effect.catchIf(
          (cause) => !isMemoryApiError(cause),
          (cause) => Effect.fail(unavailable(base, cause)),
        ),
      );

    const decodeOr =
      <A>(
        decode: (raw: unknown) => Option.Option<A>,
        what: string,
      ): ((raw: unknown) => Effect.Effect<A, MemoryApiError>) =>
      (raw) =>
        Option.match(decode(raw), {
          onNone: () =>
            Effect.fail(
              new MemoryApiError({
                code: "internal",
                message: `OpenViking returned a ${what} this adapter cannot read.`,
                status: 0,
              }),
            ),
          onSome: Effect.succeed,
        });

    return {
      /** Raw file text, `MEMORY_FIELDS` included. */
      readRaw: (uri: string) =>
        call(
          HttpClientRequest.get(`${base}/api/v1/content/read`).pipe(
            HttpClientRequest.setUrlParams({ uri, raw: "true" }),
          ),
          options.readTimeoutMs,
        ).pipe(Effect.flatMap(decodeOr(Schema.decodeUnknownOption(Schema.String), "file"))),

      /**
       * Writes and waits for the vectors, so a memory is searchable the moment
       * the call returns. `create` refuses an existing path with `conflict`.
       */
      write: (input: {
        readonly uri: string;
        readonly content: string;
        readonly mode: "create" | "replace";
        readonly tags: ReadonlyArray<string>;
      }) =>
        HttpClientRequest.post(`${base}/api/v1/content/write`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            uri: input.uri,
            content: input.content,
            mode: input.mode,
            wait: true,
            timeout: options.writeTimeoutMs / 1000,
            processing_mode: "vectors_only",
            tags: input.tags,
            tag_mode: "replace",
          }),
          (request) => call(request, options.writeTimeoutMs),
          Effect.flatMap(decodeOr(decodeWrite, "write result")),
          Effect.flatMap((result) =>
            result.content_updated && result.vector_status === "complete"
              ? Effect.void
              : Effect.fail(
                  new MemoryApiError({
                    code: "unavailable",
                    status: 0,
                    message:
                      "OpenViking did not finish indexing the memory. The file may already be stored.",
                  }),
                ),
          ),
        ),

      /** Files under `uri` carrying every tag, newest first. */
      list: (input: {
        readonly uri: string;
        readonly tags: ReadonlyArray<string>;
        readonly limit: number;
        readonly offset: number;
        readonly recursive?: boolean;
      }) =>
        call(
          HttpClientRequest.get(`${base}/api/v1/fs/ls`).pipe(
            HttpClientRequest.setUrlParams([
              ["uri", input.uri],
              ["sort_by", "mtime"],
              ["sort_order", "desc"],
              ["limit", String(input.limit)],
              ["offset", String(input.offset)],
              ["include_tags", "true"],
              ["output", "original"],
              ["include_abstract", "false"],
              ["recursive", String(input.recursive ?? false)],
              ...input.tags.map((tag) => ["tags", tag] as const),
            ]),
          ),
          options.readTimeoutMs,
        ).pipe(
          // A user who has never written a memory has no directory yet.
          Effect.catchIf(
            (error) => error.code === "not_found",
            () => Effect.succeed([]),
          ),
          Effect.flatMap(decodeOr(decodeList, "listing")),
        ),

      /** Vector recall inside `uri`, restricted to files carrying every tag. */
      move: (fromUri: string, toUri: string) =>
        HttpClientRequest.post(`${base}/api/v1/fs/mv`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ from_uri: fromUri, to_uri: toUri }),
          (request) => call(request, options.writeTimeoutMs),
          Effect.asVoid,
        ),

      findResources: (uri: string, query: string) =>
        HttpClientRequest.post(`${base}/api/v1/search/find`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            query,
            target_uri: uri,
            context_type: "resource",
            level: 2,
            limit: 200,
          }),
          (request) => call(request, options.readTimeoutMs),
          Effect.catchIf(
            (error) => error.code === "not_found",
            () => Effect.succeed({ resources: [] }),
          ),
          Effect.flatMap(decodeOr(decodeResourceFind, "knowledge search result")),
          Effect.map((result) => result.resources),
        ),

      mkdir: (uri: string) =>
        HttpClientRequest.post(`${base}/api/v1/fs/mkdir`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ uri }),
          (request) => call(request, options.writeTimeoutMs),
          Effect.catchIf(
            (error) => error.code === "conflict",
            () => Effect.void,
          ),
          Effect.asVoid,
        ),

      find: (input: {
        readonly uri: string;
        readonly query: string;
        readonly tags: ReadonlyArray<string>;
        readonly limit: number;
      }) =>
        HttpClientRequest.post(`${base}/api/v1/search/find`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            query: input.query,
            target_uri: input.uri,
            context_type: "memory",
            level: 2,
            tags: input.tags,
            limit: input.limit,
          }),
          (request) => call(request, options.readTimeoutMs),
          Effect.flatMap(decodeOr(decodeFind, "search result")),
          Effect.map((result) => result.memories),
        ),
    };
  });
