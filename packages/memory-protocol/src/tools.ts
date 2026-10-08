import * as Schema from "effect/Schema";

import { MemoryId } from "./base.ts";
import { MEMORY_BATCH_MAX, MEMORY_LIMIT_DEFAULT, MEMORY_LIMIT_MAX } from "./entry.ts";
import {
  MemorySearchInput,
  MemoryStatusChangeInput,
  MemoryUpdateInput,
  MemoryWriteInput,
} from "./requests.ts";

/**
 * Tool names, descriptions, and parameter shapes, defined once.
 *
 * Two servers expose these tools: the memory service's own MCP endpoint, and
 * the `t3-code` MCP server, which proxies to the service so a session does not
 * have to carry a second MCP connection. Both must present an identical
 * surface, or an agent's habits stop transferring between them.
 */
export const MEMORY_TOOL_NAMES = {
  search: "memory_search",
  remember: "memory_remember",
  update: "memory_update",
  forget: "memory_forget",
  restore: "memory_restore",
} as const;

export const MEMORY_SEARCH_DESCRIPTION = `Search long-term memory for facts, preferences, and decisions recorded earlier — including by other agents, in other threads, and in other projects.

Use it before asking the user something they have probably already answered, before re-deriving a decision someone already made, and when a task mentions a system, host, or convention this conversation has not covered.

Returns ranked entries with a snippet. An empty result means nothing was ever recorded — it does not mean the fact is false. Project-scoped memories are only returned when projectId is passed; global ones always are.`;

export const MEMORY_REMEMBER_DESCRIPTION = `Record durable facts worth keeping beyond this conversation: user preferences, decisions and the reason for them, environment quirks, how a system is operated, where something lives.

Do NOT record: secrets, tokens, credentials, or anything already stated in the repository (AGENTS.md, README, code comments); transient state of the task in front of you; a restatement of the current request; or a guess — memory that turns out to be wrong is worse than no memory, because later sessions act on it.

At most ${MEMORY_BATCH_MAX} entries per call. Give each one a stable dedupeKey (for example "deploy.run-tests-first") so a retry, or another agent learning the same thing, collapses onto one entry instead of a near-duplicate. Prefer a few precise entries over many broad ones.`;

export const MEMORY_UPDATE_DESCRIPTION = `Correct or extend an existing memory. Pass expectedVersion from the entry you read: a mismatch returns a conflict and you must read it again before retrying. Use this instead of writing a second entry that contradicts the first.`;

export const MEMORY_FORGET_DESCRIPTION = `Retire a memory that is no longer true or no longer wanted. Archiving is reversible: history is kept and memory_restore brings it back. When a newer entry replaces this one, pass supersededBy with that entry's id instead of a bare archive, so the correction stays traceable.`;

export const MEMORY_RESTORE_DESCRIPTION = `Bring back an archived or superseded memory. The undo of memory_forget.`;

/** Tool inputs reuse the request schemas field by field, so the surfaces cannot drift. */
export const MemorySearchToolInput = Schema.Struct({
  query: MemorySearchInput.fields.query,
  projectId: MemorySearchInput.fields.projectId,
  kinds: MemorySearchInput.fields.kinds,
  scope: MemorySearchInput.fields.scope,
  tags: MemorySearchInput.fields.tags,
  includeAllProjects: MemorySearchInput.fields.includeAllProjects,
  limit: MemorySearchInput.fields.limit,
}).annotate({
  description: `Ranked memory search. limit defaults to ${MEMORY_LIMIT_DEFAULT} and is capped at ${MEMORY_LIMIT_MAX}.`,
});
export type MemorySearchToolInput = typeof MemorySearchToolInput.Type;

export const MemoryRememberToolInput = Schema.Struct({
  entries: Schema.Array(MemoryWriteInput)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(MEMORY_BATCH_MAX)),
});
export type MemoryRememberToolInput = typeof MemoryRememberToolInput.Type;

export const MemoryUpdateToolInput = Schema.Struct({
  id: MemoryId,
  ...MemoryUpdateInput.fields,
});
export type MemoryUpdateToolInput = typeof MemoryUpdateToolInput.Type;

export const MemoryForgetToolInput = Schema.Struct({
  id: MemoryId,
  reason: MemoryStatusChangeInput.fields.reason,
  supersededBy: MemoryStatusChangeInput.fields.supersededBy,
}).annotate({
  description:
    "Archive a memory, or mark it superseded by another entry when this is a correction.",
});
export type MemoryForgetToolInput = typeof MemoryForgetToolInput.Type;

export const MemoryRestoreToolInput = Schema.Struct({ id: MemoryId });
export type MemoryRestoreToolInput = typeof MemoryRestoreToolInput.Type;
