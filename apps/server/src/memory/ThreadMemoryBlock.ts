import type { ThreadId } from "@t3tools/contracts";

/**
 * The rendered memory block for each live thread.
 *
 * Per-thread and written once when the provider session is prepared, because
 * the block goes into the provider's prompt: a value that changed between two
 * turns would invalidate the prompt cache for everything after it. Agents pull
 * anything newer with `memory_search` instead of having it pushed at them.
 *
 * Module-level state, like `McpProviderSession`, because the adapters that read
 * it run synchronously while building a turn and have no service handle for
 * this.
 */
const blocksByThread = new Map<ThreadId, string>();

export function setThreadMemoryBlock(threadId: ThreadId, block: string): void {
  blocksByThread.set(threadId, block);
}

export function readThreadMemoryBlock(threadId: ThreadId): string | undefined {
  return blocksByThread.get(threadId);
}

export function clearThreadMemoryBlock(threadId: ThreadId): void {
  blocksByThread.delete(threadId);
}

/** Test hook: the map outlives a single test's threads. */
export function clearAllThreadMemoryBlocks(): void {
  blocksByThread.clear();
}
