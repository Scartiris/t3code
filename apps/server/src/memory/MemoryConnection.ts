// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";

import { MEMORY_ENV, MEMORY_MIN_TOKEN_CHARS } from "@t3tools/memory-protocol";

/**
 * How this server reaches the memory service.
 *
 * Configuration is deployment-owned (environment variables and a token file)
 * rather than a stored setting: the token is a secret, and the URL is a
 * property of the box, not of the user's preferences. No connection means no
 * memory tools and no injected block — the same shape as a withheld MCP
 * credential, so an unconfigured server cannot half-advertise the feature.
 */
export interface MemoryConnection {
  readonly baseUrl: string;
  readonly token: string;
}

export interface MemoryConnectionAttempt {
  readonly connection?: MemoryConnection | undefined;
  /** Set when the environment asked for memory but the token was unusable. */
  readonly problem?: string | undefined;
}

export const readMemoryConnection = (
  env: NodeJS.ProcessEnv = process.env,
): MemoryConnectionAttempt => {
  const url = env[MEMORY_ENV.url]?.trim() ?? "";
  const tokenFile = env[MEMORY_ENV.clientTokenFile]?.trim() ?? "";
  if (url.length === 0 && tokenFile.length === 0) return {};
  if (url.length === 0) {
    return { problem: `${MEMORY_ENV.clientTokenFile} is set but ${MEMORY_ENV.url} is not.` };
  }
  if (tokenFile.length === 0) {
    return { problem: `${MEMORY_ENV.url} is set but ${MEMORY_ENV.clientTokenFile} is not.` };
  }
  let token = "";
  try {
    token = NodeFs.readFileSync(tokenFile, "utf8").trim();
  } catch (cause) {
    return {
      problem: `Could not read the memory token at ${tokenFile}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (token.length < MEMORY_MIN_TOKEN_CHARS) {
    return {
      problem: `The memory token at ${tokenFile} is shorter than ${MEMORY_MIN_TOKEN_CHARS} characters.`,
    };
  }
  return { connection: { baseUrl: url.replace(/\/+$/u, ""), token } };
};
