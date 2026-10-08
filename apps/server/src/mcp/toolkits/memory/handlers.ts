import * as Effect from "effect/Effect";

import {
  MEMORY_TOOL_NAMES,
  type MemoryApiError,
  type MemoryMcpFailure,
  type MemorySearchInput,
  type MemorySearchToolInput,
  type MemorySource,
  type MemoryWriteInput,
  memoryMcpFailureFromUnknown,
} from "@t3tools/memory-protocol";

import * as MemoryService from "../../../memory/MemoryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MemoryToolkit } from "./tools.ts";

/** A tool result must carry the failure as data; `failureMode: "return"` never throws. */
export const toFailure = (error: MemoryApiError): MemoryMcpFailure =>
  memoryMcpFailureFromUnknown(error);

/**
 * Fill in the calling thread's project when the agent did not name one.
 *
 * A project-scoped memory is invisible without it, so an agent that omits the
 * field would silently get a smaller answer than the one it asked for. Naming
 * a different project still wins: that is how a cross-project question is asked.
 */
export const withProjectDefault = (
  input: MemorySearchToolInput,
  projectId: string | null,
): MemorySearchInput =>
  input.projectId === undefined && projectId !== null ? { ...input, projectId } : input;

/** The same default for writes, applied only to entries that asked to be project-scoped. */
export const entriesWithProject = (
  entries: ReadonlyArray<MemoryWriteInput>,
  projectId: string | null,
): ReadonlyArray<MemoryWriteInput> =>
  entries.map((entry) =>
    entry.scope === "project" && entry.projectId === undefined && projectId !== null
      ? { ...entry, projectId }
      : entry,
  );

/**
 * Who the calling thread is, and what its writes should be attributed to.
 *
 * A thread whose shell cannot be read degrades to "no project", which hides
 * other projects' memories rather than exposing them.
 */
const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(scope.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  const source: MemorySource = {
    kind: "agent",
    providerInstanceId: scope.providerInstanceId,
    threadId: scope.threadId,
  };
  return { projectId: shell?.projectId ?? null, source };
});

export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer({
  [MEMORY_TOOL_NAMES.search]: (input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const { projectId } = yield* caller;
      return yield* memory
        .search(withProjectDefault(input, projectId))
        .pipe(Effect.mapError(toFailure));
    }),

  [MEMORY_TOOL_NAMES.remember]: (input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const { projectId, source } = yield* caller;
      return yield* memory
        .remember({ entries: entriesWithProject(input.entries, projectId) }, source)
        .pipe(Effect.mapError(toFailure));
    }),

  [MEMORY_TOOL_NAMES.update]: (input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const { source } = yield* caller;
      return yield* memory.update(input, source).pipe(Effect.mapError(toFailure));
    }),

  [MEMORY_TOOL_NAMES.forget]: (input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const { source } = yield* caller;
      return yield* memory.forget(input, source).pipe(Effect.mapError(toFailure));
    }),

  [MEMORY_TOOL_NAMES.restore]: (input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const { source } = yield* caller;
      return yield* memory.restore(input.id, source).pipe(Effect.mapError(toFailure));
    }),
});
