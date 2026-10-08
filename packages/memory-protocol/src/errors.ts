import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./base.ts";

/**
 * Failure classes every transport shares, so a caller can branch on the reason
 * without parsing prose.
 *
 * - `unauthorized` — missing or wrong bearer token.
 * - `invalid_request` — the payload was rejected; the message names the field.
 * - `not_found` — no such entry.
 * - `conflict` — `expectedVersion` did not match; reread and retry.
 * - `unavailable` — the memory service could not be reached.
 * - `internal` — the service failed; the message is safe to show.
 */
export const MEMORY_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "not_found",
  "conflict",
  "unavailable",
  "internal",
] as const;

export const MemoryErrorCode = Schema.Literals(MEMORY_ERROR_CODES);
export type MemoryErrorCode = typeof MemoryErrorCode.Type;

export const MemoryErrorInfo = Schema.Struct({
  code: MemoryErrorCode,
  message: TrimmedNonEmptyString,
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type MemoryErrorInfo = typeof MemoryErrorInfo.Type;

export const MemoryErrorResponse = Schema.Struct({ error: MemoryErrorInfo });
export type MemoryErrorResponse = typeof MemoryErrorResponse.Type;

/** Thrown by `MemoryClient` for every non-2xx response and for transport failures. */
export class MemoryApiError extends Schema.TaggedError<MemoryApiError>()("MemoryApiError", {
  code: MemoryErrorCode,
  message: Schema.String,
  /** HTTP status; 0 when the request never reached the service. */
  status: NonNegativeInt,
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

/**
 * The shape an MCP tool returns on failure. Kept separate from
 * `MemoryApiError` because a tool result must describe the failure as data —
 * `failureMode: "return"` never throws — while the client wants an exception it
 * can map.
 */
export class MemoryMcpFailure extends Schema.TaggedError<MemoryMcpFailure>()("MemoryMcpFailure", {
  code: MemoryErrorCode,
  message: Schema.String,
}) {}

export const memoryErrorInfo = (
  code: MemoryErrorCode,
  message: string,
  details?: Record<string, unknown>,
): MemoryErrorInfo => ({ code, message, ...(details === undefined ? {} : { details }) });

/** Builds an error with the status its code implies, so transports agree on 404 vs 409. */
export const memoryApiFailure = (
  code: MemoryErrorCode,
  message: string,
  details?: Record<string, unknown>,
): MemoryApiError =>
  new MemoryApiError({
    code,
    message,
    status: httpStatusForCode(code),
    ...(details === undefined ? {} : { details }),
  });

export const httpStatusForCode = (code: MemoryErrorCode): number => {
  switch (code) {
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "unavailable":
      return 503;
    case "internal":
      return 500;
  }
};

export const memoryErrorFromUnknown = (
  cause: unknown,
  fallbackMessage = "Memory request failed.",
): MemoryApiError => {
  if (Schema.is(MemoryApiError)(cause)) return cause;
  if (cause instanceof Error) {
    const timedOut = cause.name === "TimeoutError" || cause.name === "AbortError";
    return new MemoryApiError({
      code: "unavailable",
      message: timedOut ? "The memory service did not answer in time." : cause.message,
      status: 0,
    });
  }
  return new MemoryApiError({ code: "internal", message: fallbackMessage, status: 0 });
};

export const memoryMcpFailureFromUnknown = (cause: unknown): MemoryMcpFailure => {
  const error = memoryErrorFromUnknown(cause);
  return new MemoryMcpFailure({ code: error.code, message: error.message });
};
