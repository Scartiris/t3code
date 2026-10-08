import { assert, describe, it } from "@effect/vitest";

import { ThreadId } from "@t3tools/contracts";

import {
  clearAllThreadMemoryBlocks,
  clearThreadMemoryBlock,
  readThreadMemoryBlock,
  setThreadMemoryBlock,
} from "./ThreadMemoryBlock.ts";

const first = ThreadId.make("thread-memory-1");
const second = ThreadId.make("thread-memory-2");

describe("thread memory blocks", () => {
  it("keeps one block per thread", () => {
    clearAllThreadMemoryBlocks();
    setThreadMemoryBlock(first, "<t3_memory>\none\n</t3_memory>");
    setThreadMemoryBlock(second, "<t3_memory>\ntwo\n</t3_memory>");
    assert.strictEqual(readThreadMemoryBlock(first), "<t3_memory>\none\n</t3_memory>");
    assert.strictEqual(readThreadMemoryBlock(second), "<t3_memory>\ntwo\n</t3_memory>");
    clearAllThreadMemoryBlocks();
  });

  it("treats an empty block as a value, so a failed fetch is not retried per turn", () => {
    clearAllThreadMemoryBlocks();
    setThreadMemoryBlock(first, "");
    assert.strictEqual(readThreadMemoryBlock(first), "");
    clearAllThreadMemoryBlocks();
  });

  it("forgets a thread that has been cleared", () => {
    clearAllThreadMemoryBlocks();
    setThreadMemoryBlock(first, "x");
    clearThreadMemoryBlock(first);
    assert.strictEqual(readThreadMemoryBlock(first), undefined);
  });

  it("has nothing for a thread that never had one", () => {
    clearAllThreadMemoryBlocks();
    assert.strictEqual(readThreadMemoryBlock(second), undefined);
  });
});
