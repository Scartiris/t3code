import * as Effect from "effect/Effect";

import {
  MEMORY_TOOL_NAMES,
  type MemoryMcpFailure,
  memoryMcpFailureFromUnknown,
} from "@t3tools/memory-protocol";

import type { MemoryServiceShape } from "../service/MemoryService.ts";
import { MemoryToolkit } from "./tools.ts";

/**
 * The actor recorded on writes that arrive through this server's own MCP
 * endpoint. A host app that proxies (T3 Code) records itself instead, with the
 * thread and provider instance that produced the memory.
 */
const mcpActor = { kind: "agent" } as const;

/** Runs a service call and turns any failure into the tool-result failure shape. */
const withService = <A, E>(
  service: MemoryServiceShape,
  use: (service: MemoryServiceShape) => Effect.Effect<A, E>,
): Effect.Effect<A, MemoryMcpFailure> =>
  use(service).pipe(Effect.mapError(memoryMcpFailureFromUnknown));

/**
 * Handlers built from a resolved service value: a toolkit handler has to run
 * with nothing left in its environment, and closing over the value is what
 * makes the registration layer require only the router.
 */
export const makeMemoryToolkitHandlers = (service: MemoryServiceShape) =>
  MemoryToolkit.toLayer({
    [MEMORY_TOOL_NAMES.search]: (input) => withService(service, (s) => s.search(input)),

    [MEMORY_TOOL_NAMES.remember]: (input) =>
      withService(service, (s) => s.createBatch({ entries: input.entries }, mcpActor)),

    [MEMORY_TOOL_NAMES.update]: (input) =>
      withService(service, (s) => {
        const { id, ...patch } = input;
        return s.update(id, patch, mcpActor);
      }),

    [MEMORY_TOOL_NAMES.forget]: (input) =>
      withService(service, (s) => {
        const supersededBy = input.supersededBy ?? null;
        return s.setStatus(
          input.id,
          {
            status: supersededBy === null ? "archived" : "superseded",
            supersededBy,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
          mcpActor,
        );
      }),

    [MEMORY_TOOL_NAMES.restore]: (input) =>
      withService(service, (s) => s.setStatus(input.id, { status: "active" }, mcpActor)),
  });
