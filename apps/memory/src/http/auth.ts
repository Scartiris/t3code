// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/**
 * Bearer auth, shared by the REST dispatcher and the MCP transport so both
 * answer with the same body and the same timing behaviour.
 */
export interface MemoryAuthOptions {
  /** undefined when no token file exists yet: every authenticated route answers 401. */
  readonly token: string | undefined;
}

export const bearerOf = (request: HttpServerRequest.HttpServerRequest): string =>
  request.headers.authorization?.replace(/^Bearer\s+/iu, "").trim() ?? "";

export const tokensMatch = (supplied: string, expected: string): boolean => {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

export const unauthorizedResponse = (reason: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        code: "unauthorized",
        message:
          reason === "not_configured"
            ? "This memory service has no bearer token yet. Run `t3-memory token` on the host first."
            : "A valid bearer token is required.",
      },
    },
    { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
  );

/** Returns the 401 response to send, or undefined when the request may proceed. */
export const rejectUnauthorized = (
  request: HttpServerRequest.HttpServerRequest,
  options: MemoryAuthOptions,
): HttpServerResponse.HttpServerResponse | undefined => {
  if (options.token === undefined) return unauthorizedResponse("not_configured");
  return tokensMatch(bearerOf(request), options.token)
    ? undefined
    : unauthorizedResponse("wrong_token");
};
