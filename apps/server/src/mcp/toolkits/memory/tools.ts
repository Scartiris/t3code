import { Tool, Toolkit } from "effect/unstable/ai";

import {
  MEMORY_FORGET_DESCRIPTION,
  MEMORY_REMEMBER_DESCRIPTION,
  MEMORY_RESTORE_DESCRIPTION,
  MEMORY_SEARCH_DESCRIPTION,
  MEMORY_TOOL_NAMES,
  MEMORY_UPDATE_DESCRIPTION,
  MemoryBatchCreateResult,
  MemoryDeleteResult,
  MemoryEntry,
  MemoryForgetToolInput,
  MemoryMcpFailure,
  MemoryRememberToolInput,
  MemoryRestoreToolInput,
  MemorySearchResult,
  MemorySearchToolInput,
  MemoryUpdateToolInput,
} from "@t3tools/memory-protocol";

import * as MemoryService from "../../../memory/MemoryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Memory tools, served through `t3-code` rather than as a second MCP server.
 *
 * Every adapter already attaches the `t3-code` server with a per-thread
 * credential, so proxying the memory service's tools through it covers Codex,
 * Claude Code, Cursor, Grok, OpenCode, Antigravity, and any ACP agent at once —
 * and keeps one place where read-only sessions restrict what an agent may call.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  MemoryService.MemoryService,
  // Handlers resolve the calling thread's project through this; the tool
  // dependency list is what the language service checks against.
  ThreadManagementService.ThreadManagementService,
];
const shared = {
  failure: MemoryMcpFailure,
  failureMode: "return" as const,
  dependencies,
};

const MemorySearchTool = Tool.make(MEMORY_TOOL_NAMES.search, {
  ...shared,
  description: MEMORY_SEARCH_DESCRIPTION,
  parameters: MemorySearchToolInput,
  success: MemorySearchResult,
})
  .annotate(Tool.Title, "Search memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MemoryRememberTool = Tool.make(MEMORY_TOOL_NAMES.remember, {
  ...shared,
  description: MEMORY_REMEMBER_DESCRIPTION,
  parameters: MemoryRememberToolInput,
  success: MemoryBatchCreateResult,
})
  .annotate(Tool.Title, "Remember")
  .annotate(Tool.Destructive, true);

const MemoryUpdateTool = Tool.make(MEMORY_TOOL_NAMES.update, {
  ...shared,
  description: MEMORY_UPDATE_DESCRIPTION,
  parameters: MemoryUpdateToolInput,
  success: MemoryEntry,
})
  .annotate(Tool.Title, "Correct a memory")
  .annotate(Tool.Destructive, true);

const MemoryForgetTool = Tool.make(MEMORY_TOOL_NAMES.forget, {
  ...shared,
  description: MEMORY_FORGET_DESCRIPTION,
  parameters: MemoryForgetToolInput,
  success: MemoryDeleteResult,
})
  .annotate(Tool.Title, "Retire a memory")
  .annotate(Tool.Destructive, true);

const MemoryRestoreTool = Tool.make(MEMORY_TOOL_NAMES.restore, {
  ...shared,
  description: MEMORY_RESTORE_DESCRIPTION,
  parameters: MemoryRestoreToolInput,
  success: MemoryDeleteResult,
})
  .annotate(Tool.Title, "Restore a memory")
  .annotate(Tool.Destructive, true);

export const MemoryToolkit = Toolkit.make(
  MemorySearchTool,
  MemoryRememberTool,
  MemoryUpdateTool,
  MemoryForgetTool,
  MemoryRestoreTool,
);
