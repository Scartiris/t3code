// Environment and filesystem plumbing: reading a token file and resolving the
// data directory are process concerns, not Effect ones.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MEMORY_MIN_TOKEN_CHARS } from "@t3tools/memory-protocol";

export const DEFAULT_MEMORY_HOST = "127.0.0.1";
export const DEFAULT_MEMORY_PORT = 3211;

/** Below this the bearer token is a guess, not a secret. */
export const MIN_TOKEN_CHARS = MEMORY_MIN_TOKEN_CHARS;

export interface MemoryConfig {
  readonly homeDir: string;
  readonly databasePath: string;
  readonly tokenFilePath: string;
  readonly host: string;
  readonly port: number;
}

export class MemoryConfigError extends Error {
  override readonly name = "MemoryConfigError";
}

const readEnv = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

export const parseMemoryPort = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_MEMORY_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new MemoryConfigError(
      `MEMORY_PORT must be an integer between 1 and 65535, got "${raw}".`,
    );
  }
  return port;
};

export const loadMemoryConfig = (env: NodeJS.ProcessEnv = process.env): MemoryConfig => {
  const homeDir = NodePath.resolve(
    readEnv(env, "MEMORY_HOME") ?? NodePath.join(NodeOS.homedir(), ".t3-memory"),
  );
  const databasePath = NodePath.resolve(
    readEnv(env, "MEMORY_DB") ?? NodePath.join(homeDir, "memory.sqlite"),
  );
  return {
    homeDir,
    databasePath,
    tokenFilePath: NodePath.resolve(
      readEnv(env, "MEMORY_TOKEN_FILE") ?? NodePath.join(homeDir, "token"),
    ),
    host: readEnv(env, "MEMORY_HOST") ?? DEFAULT_MEMORY_HOST,
    port: parseMemoryPort(readEnv(env, "MEMORY_PORT")),
  };
};

export const ensureMemoryHome = (config: MemoryConfig): void => {
  NodeFS.mkdirSync(NodePath.dirname(config.databasePath), { recursive: true });
  NodeFS.mkdirSync(NodePath.dirname(config.tokenFilePath), { recursive: true });
};

/**
 * Reads the bearer token, or undefined when the file is missing or too short.
 * Callers treat undefined as "this service is not configured yet": it still
 * starts and answers `/health`, and rejects every authenticated route.
 */
export const readMemoryToken = (tokenFilePath: string): string | undefined => {
  try {
    const token = NodeFS.readFileSync(tokenFilePath, "utf8").trim();
    return token.length < MIN_TOKEN_CHARS ? undefined : token;
  } catch {
    return undefined;
  }
};

/** Creates the token file at 0600 if it is missing. Returns the token in use. */
export const ensureMemoryToken = (tokenFilePath: string): string => {
  const existing = readMemoryToken(tokenFilePath);
  if (existing !== undefined) return existing;
  const token = NodeCrypto.randomBytes(36).toString("base64url");
  NodeFS.mkdirSync(NodePath.dirname(tokenFilePath), { recursive: true });
  NodeFS.writeFileSync(tokenFilePath, `${token}\n`, { mode: 0o600 });
  return token;
};

export const memoryUrlForHost = (host: string, port: number): string =>
  `http://${host === "0.0.0.0" || host === "::" ? DEFAULT_MEMORY_HOST : host}:${port}`;
