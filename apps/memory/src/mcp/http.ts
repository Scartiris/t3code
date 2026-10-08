import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { McpProtocol, McpServer } from "effect/unstable/ai";

import { MEMORY_MCP_PATH } from "@t3tools/memory-protocol";

import { rejectUnauthorized, type MemoryAuthOptions } from "../http/auth.ts";
import type { MemoryServiceShape } from "../service/MemoryService.ts";
import { MEMORY_SERVICE_VERSION } from "../version.ts";
import { makeMemoryToolkitHandlers } from "./handlers.ts";
import { MemoryToolkit } from "./tools.ts";

/**
 * The MCP endpoint carries the same bearer token as the REST API, so a client
 * cannot reach a write path by choosing the other transport.
 */
const memoryMcpAuthMiddleware = (options: MemoryAuthOptions) =>
  HttpRouter.middleware<Record<string, never>>()((httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const rejected = rejectUnauthorized(request, options);
      return rejected ?? (yield* httpEffect);
    }),
  ).layer;

const MemoryMcpTransportLive = (options: MemoryAuthOptions) =>
  McpServer.layerHttp({
    name: "T3 Memory",
    version: MEMORY_SERVICE_VERSION,
    path: MEMORY_MCP_PATH,
    protocols: [McpProtocol.v2025_06_18],
  }).pipe(Layer.provide(memoryMcpAuthMiddleware(options)));

/**
 * Tools plus transport. The service arrives as a value, so this layer needs
 * nothing but the router the server provides around it.
 */
export const memoryMcpLayer = (options: MemoryAuthOptions, service: MemoryServiceShape) =>
  McpServer.toolkit(MemoryToolkit)
    .pipe(Layer.provide(makeMemoryToolkitHandlers(service)))
    .pipe(Layer.provideMerge(MemoryMcpTransportLive(options)));
