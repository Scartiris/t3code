// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { MEMORY_ENV, MEMORY_MIN_TOKEN_CHARS } from "@t3tools/memory-protocol";

/**
 * How this server reaches the memory service.
 *
 * Deployment defaults come from environment variables and a token file.
 * MemoryRuntime applies environment-scoped settings and secret-store credentials
 * over these defaults, keeping keys out of client configuration responses.
 */
export interface MemoryConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly backend?: "openviking" | undefined;
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
  const backend = env.T3CODE_MEMORY_BACKEND?.trim() ?? "protocol";
  if (backend !== "protocol" && backend !== "openviking") {
    return { problem: "T3CODE_MEMORY_BACKEND must be protocol or openviking." };
  }
  if (url.length === 0 && tokenFile.length === 0) {
    return backend === "openviking"
      ? {
          problem: `${MEMORY_ENV.url} and ${MEMORY_ENV.clientTokenFile} are required for OpenViking.`,
        }
      : {};
  }
  if (url.length === 0) {
    return { problem: `${MEMORY_ENV.clientTokenFile} is set but ${MEMORY_ENV.url} is not.` };
  }
  if (tokenFile.length === 0) {
    return { problem: `${MEMORY_ENV.url} is set but ${MEMORY_ENV.clientTokenFile} is not.` };
  }
  let token = "";
  try {
    token = NodeFS.readFileSync(tokenFile, "utf8").trim();
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
  try {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Invalid URL");
  } catch {
    return {
      problem: `${MEMORY_ENV.url} must be an HTTP(S) base URL without credentials, query or fragment.`,
    };
  }
  return {
    connection: {
      baseUrl: url.replace(/\/+$/u, ""),
      token,
      ...(backend === "openviking" ? { backend } : {}),
    },
  };
};
