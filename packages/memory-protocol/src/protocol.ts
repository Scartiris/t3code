/**
 * The memory wire protocol version.
 *
 * Bumped only for breaking changes to the shapes in this package. Additive
 * changes (a new field, a new tool, a new error code) do not bump it: every
 * decoder here ignores unknown keys, so an older client keeps working against a
 * newer service.
 */
export const MEMORY_PROTOCOL_VERSION = "1";

/** Path prefix every REST route lives under. */
export const MEMORY_API_PREFIX = "/v1";

/** Default route the service mounts its MCP endpoint on. */
export const MEMORY_MCP_PATH = "/mcp";

/**
 * Header carrying the caller's provenance as a JSON `MemorySource`. It is
 * transport metadata rather than payload: a proxy knows which thread and
 * provider instance it is acting for, and the agent it proxies for should not
 * have to say.
 */
export const MEMORY_SOURCE_HEADER = "x-memory-source";

export const MEMORY_SERVICE_NAME = "t3-memory";

/**
 * Below this a bearer token is a guess, not a secret. The service refuses to
 * serve authenticated routes with a shorter one, and a client that finds a
 * shorter token in its token file treats the service as unconfigured rather
 * than sending something that can only fail.
 */
export const MEMORY_MIN_TOKEN_CHARS = 32;

/** Environment variable names the service and its clients agree on. */
export const MEMORY_ENV = {
  home: "MEMORY_HOME",
  host: "MEMORY_HOST",
  port: "MEMORY_PORT",
  tokenFile: "MEMORY_TOKEN_FILE",
  url: "T3CODE_MEMORY_URL",
  clientTokenFile: "T3CODE_MEMORY_TOKEN_FILE",
} as const;
