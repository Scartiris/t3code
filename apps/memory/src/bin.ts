#!/usr/bin/env node
// The CLI entry: argument parsing and printing are process concerns, and the
// JSON it prints is the raw protocol response.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeUtil from "node:util";

import * as Effect from "effect/Effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  MEMORY_CONTEXT_MAX_CHARS_DEFAULT,
  MEMORY_PROTOCOL_VERSION,
  MemoryContextResult,
  MemoryId,
  MemorySearchResult,
  MemoryWriteInput,
  makeMemoryClient,
  type MemoryClient,
} from "@t3tools/memory-protocol";

import {
  ensureMemoryHome,
  ensureMemoryToken,
  loadMemoryConfig,
  memoryUrlForHost,
  MIN_TOKEN_CHARS,
  readMemoryToken,
  type MemoryConfig,
} from "./config.ts";
import { runMemoryMcpStdioBridge } from "./mcp/stdio.ts";
import { runMemoryServer } from "./server.ts";
import { MEMORY_SERVICE_VERSION } from "./version.ts";

const USAGE = `t3-memory ${MEMORY_SERVICE_VERSION} (protocol ${MEMORY_PROTOCOL_VERSION})

Usage: t3-memory <command> [options]

Commands
  serve                 Run the HTTP + MCP service (systemd unit runs this).
  mcp-stdio             Speak MCP on stdin/stdout, forwarding to a running service.
  token                 Create the bearer token file if missing, and report its path.
  health                Ask a running service for its health.
  context               Render the block a host app would inject for a session.
  remember              Write one memory.
  search                Ranked search.
  list                  Newest first, with filters.
  get <id>              Read one entry.
  history <id>          Audit events for one entry.
  forget <id>           Archive (or supersede) one entry.
  restore <id>          Undo a forget.
  index-rebuild         Rebuild the full-text index from the entries table.

Global options
  --url <url>           Service URL. Defaults to MEMORY_HOST/MEMORY_PORT.
  --json                Print the raw protocol JSON instead of a summary.
  -h, --help            This text.

Environment: ${"MEMORY_HOME"} MEMORY_DB MEMORY_HOST MEMORY_PORT MEMORY_TOKEN_FILE
`;

const OPTIONS = {
  url: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  host: { type: "string" },
  port: { type: "string" },
  print: { type: "boolean" },
  title: { type: "string" },
  body: { type: "string" },
  kind: { type: "string" },
  scope: { type: "string" },
  project: { type: "string" },
  tags: { type: "string" },
  pinned: { type: "boolean" },
  importance: { type: "string" },
  "dedupe-key": { type: "string" },
  query: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  status: { type: "string" },
  reason: { type: "string" },
  "superseded-by": { type: "string" },
  "max-chars": { type: "string" },
  "all-projects": { type: "boolean" },
} as const;

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const fail = (message: string): number => {
  process.stderr.write(`${message}\n`);
  return 1;
};

const decodeWrite = Schema.decodeUnknownOption(MemoryWriteInput);

const clientFor = (
  config: MemoryConfig,
  values: { readonly url?: string | undefined },
): MemoryClient => {
  const token = readMemoryToken(config.tokenFilePath);
  if (token === undefined) {
    throw new Error(
      `No usable bearer token at ${config.tokenFilePath} (needs ${MIN_TOKEN_CHARS}+ characters). Run \`t3-memory token\` first.`,
    );
  }
  return makeMemoryClient({
    baseUrl: values.url ?? memoryUrlForHost(config.host, config.port),
    token,
  });
};

const printHits = (
  result: {
    items: ReadonlyArray<{
      entry: { id: string; kind: string; scope: string; title: string; status: string };
      score: number;
      snippet: string;
    }>;
    total: number;
    nextCursor: string | null;
  },
  json: boolean,
): void => {
  if (json) return printJson(result);
  if (result.items.length === 0) {
    process.stdout.write("No memories matched.\n");
    return;
  }
  for (const hit of result.items) {
    process.stdout.write(
      `${hit.entry.id}  [${hit.entry.kind}/${hit.entry.scope}/${hit.entry.status}] ${hit.entry.title}\n    ${hit.snippet}\n`,
    );
  }
  process.stdout.write(
    `${result.items.length} of ${result.total} shown${result.nextCursor === null ? "" : ` (next: --cursor ${result.nextCursor})`}\n`,
  );
};

const numberFlag = (raw: string, what: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${what} must be a number, got "${raw}".`);
  return value;
};

const main = async (): Promise<number> => {
  const parsed = NodeUtil.parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const command = parsed.positionals[0] ?? (values.help === true ? "help" : "");
  const positionals = parsed.positionals.slice(1);

  const config = loadMemoryConfig(
    values.host === undefined && values.port === undefined
      ? process.env
      : {
          ...process.env,
          ...(values.host === undefined ? {} : { MEMORY_HOST: String(values.host) }),
          ...(values.port === undefined ? {} : { MEMORY_PORT: String(values.port) }),
        },
  );
  ensureMemoryHome(config);

  switch (command) {
    case "help":
    case "": {
      process.stdout.write(USAGE);
      return command === "" ? 1 : 0;
    }

    case "serve": {
      const token = readMemoryToken(config.tokenFilePath);
      if (token === undefined) {
        process.stderr.write(
          `warning: no usable token at ${config.tokenFilePath}; authenticated routes will answer 401.\n`,
        );
      }
      NodeRuntime.runMain(runMemoryServer(config));
      return 0;
    }

    case "token": {
      const created = readMemoryToken(config.tokenFilePath) === undefined;
      const token = ensureMemoryToken(config.tokenFilePath);
      process.stdout.write(
        `${created ? "created" : "existing"} token file: ${config.tokenFilePath}\n`,
      );
      if (values.print === true) process.stdout.write(`${token}\n`);
      return 0;
    }

    case "mcp-stdio": {
      const token = readMemoryToken(config.tokenFilePath);
      if (token === undefined) {
        return fail(`No usable bearer token at ${config.tokenFilePath}. Run \`t3-memory token\`.`);
      }
      const url = values.url ?? memoryUrlForHost(config.host, config.port);
      await Effect.runPromise(
        runMemoryMcpStdioBridge({
          endpoint: `${url}/mcp`,
          authorization: `Bearer ${token}`,
        }),
      );
      return 0;
    }

    default:
      break;
  }

  const client = clientFor(config, {
    url: typeof values.url === "string" && values.url.length > 0 ? values.url : undefined,
  });

  switch (command) {
    case "health": {
      const health = await client.health();
      if (values.json === true) printJson(health);
      else {
        process.stdout.write(
          `${health.service} ${health.version} (protocol ${health.protocolVersion}) ${health.ok ? "ok" : "degraded"}\n` +
            `  entries: ${health.entries.active} active, ${health.entries.pinned} pinned, ${health.entries.archived} archived, ${health.entries.superseded} superseded\n` +
            `  database: ${health.databasePath} (${health.databaseBytes} bytes)\n` +
            `  token configured: ${health.tokenConfigured}\n`,
        );
      }
      return health.tokenConfigured ? 0 : 2;
    }

    case "remember": {
      if (values.title === undefined || values.body === undefined) {
        return fail("remember needs --title and --body.");
      }
      const projectId = values.project === undefined ? undefined : String(values.project);
      const decoded = decodeWrite({
        title: String(values.title),
        body: String(values.body),
        kind: values.kind ?? "fact",
        scope: values.scope ?? (projectId === undefined ? "global" : "project"),
        ...(projectId === undefined ? {} : { projectId }),
        ...(values.tags === undefined
          ? {}
          : {
              tags: String(values.tags)
                .split(",")
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0),
            }),
        ...(values.pinned === true ? { pinned: true } : {}),
        ...(values.importance === undefined
          ? {}
          : { importance: numberFlag(String(values.importance), "importance") }),
        ...(values["dedupe-key"] === undefined ? {} : { dedupeKey: String(values["dedupe-key"]) }),
        source: { kind: "human" },
      });
      if (Option.isNone(decoded)) {
        return fail(
          "That memory does not fit the protocol: check the title length, the body length, the kind, and the tags.",
        );
      }
      const result = await client.create(decoded.value);
      if (values.json === true) printJson(result);
      else {
        process.stdout.write(
          `${result.duplicate ? "already recorded" : "remembered"}: ${result.entry.id} (v${result.entry.version})\n`,
        );
      }
      return 0;
    }

    case "search": {
      const query = typeof values.query === "string" ? values.query : positionals.join(" ");
      const result = await client.search({
        ...(query.length === 0 ? {} : { query }),
        ...(values.project === undefined ? {} : { projectId: String(values.project) }),
        ...(values.limit === undefined ? {} : { limit: numberFlag(String(values.limit), "limit") }),
        ...(values.cursor === undefined ? {} : { cursor: String(values.cursor) }),
        ...(values["all-projects"] === true ? { includeAllProjects: true } : {}),
      });
      printHits(Schema.decodeUnknownSync(MemorySearchResult)(result), values.json === true);
      return 0;
    }

    case "list": {
      const result = await client.list({
        ...(values.project === undefined ? {} : { projectId: String(values.project) }),
        ...(values.limit === undefined ? {} : { limit: numberFlag(String(values.limit), "limit") }),
        ...(values.cursor === undefined ? {} : { cursor: String(values.cursor) }),
        ...(values.status === undefined
          ? {}
          : { status: values.status as "active" | "superseded" | "archived" }),
        ...(values["all-projects"] === true ? { includeAllProjects: true } : {}),
      });
      printHits(Schema.decodeUnknownSync(MemorySearchResult)(result), values.json === true);
      return 0;
    }

    case "context": {
      const result = await client.context({
        ...(typeof values.query === "string" ? { query: values.query } : {}),
        ...(values.project === undefined ? {} : { projectId: String(values.project) }),
        ...(values.limit === undefined ? {} : { limit: numberFlag(String(values.limit), "limit") }),
        maxChars:
          values["max-chars"] === undefined
            ? MEMORY_CONTEXT_MAX_CHARS_DEFAULT
            : numberFlag(String(values["max-chars"]), "max-chars"),
      });
      const decoded = Schema.decodeUnknownSync(MemoryContextResult)(result);
      if (values.json === true) printJson(decoded);
      else if (decoded.empty) process.stdout.write("(no memory to inject)\n");
      else process.stdout.write(`${decoded.text}\n`);
      return 0;
    }

    case "get": {
      const id = positionals[0];
      if (id === undefined) return fail("get needs an entry id.");
      printJson(await client.get(MemoryId.make(id)));
      return 0;
    }

    case "history": {
      const id = positionals[0];
      if (id === undefined) return fail("history needs an entry id.");
      printJson(await client.history(MemoryId.make(id)));
      return 0;
    }

    case "forget": {
      const id = positionals[0];
      if (id === undefined) return fail("forget needs an entry id.");
      const supersededBy = values["superseded-by"];
      const result = await client.setStatus(MemoryId.make(id), {
        status: supersededBy === undefined ? "archived" : "superseded",
        ...(supersededBy === undefined
          ? {}
          : { supersededBy: MemoryId.make(String(supersededBy)) }),
        ...(values.reason === undefined ? {} : { reason: String(values.reason) }),
      });
      if (values.json === true) printJson(result);
      else process.stdout.write(`${result.id} is now ${result.status}\n`);
      return 0;
    }

    case "restore": {
      const id = positionals[0];
      if (id === undefined) return fail("restore needs an entry id.");
      const result = await client.setStatus(MemoryId.make(id), { status: "active" });
      if (values.json === true) printJson(result);
      else process.stdout.write(`${result.id} is now ${result.status}\n`);
      return 0;
    }

    case "index-rebuild": {
      printJson(await client.rebuildIndex());
      return 0;
    }

    default:
      return fail(`Unknown command "${command}".\n\n${USAGE}`);
  }
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    process.exitCode = fail(cause instanceof Error ? cause.message : String(cause));
  });
