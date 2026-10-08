import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { MEMORY_TOOL_NAMES } from "@t3tools/memory-protocol";

import { MemoryToolkit } from "./tools.ts";

const tools = Object.values(MemoryToolkit.tools);

const toolNamed = (name: string) => {
  const found = tools.find((tool) => tool.name === name);
  assert.isDefined(found);
  return found!;
};

describe("memory tool surface", () => {
  it("exposes exactly the five memory tools", () => {
    assert.deepStrictEqual(
      tools.map((tool) => tool.name).sort(),
      [
        MEMORY_TOOL_NAMES.forget,
        MEMORY_TOOL_NAMES.remember,
        MEMORY_TOOL_NAMES.restore,
        MEMORY_TOOL_NAMES.search,
        MEMORY_TOOL_NAMES.update,
      ].sort(),
    );
  });

  it("marks only search as read-only", () => {
    const readOnly = tools
      .filter((tool) => Context.get(tool.annotations, Tool.Readonly) === true)
      .map((tool) => tool.name);
    assert.deepStrictEqual(readOnly, [MEMORY_TOOL_NAMES.search]);
  });

  it("marks every write as destructive so a client can gate it", () => {
    const destructive = tools
      .filter((tool) => Context.get(tool.annotations, Tool.Destructive) === true)
      .map((tool) => tool.name)
      .sort();
    assert.deepStrictEqual(
      destructive,
      [
        MEMORY_TOOL_NAMES.forget,
        MEMORY_TOOL_NAMES.remember,
        MEMORY_TOOL_NAMES.restore,
        MEMORY_TOOL_NAMES.update,
      ].sort(),
    );
  });

  it("describes when not to write, not just what a tool does", () => {
    const description = String(Tool.getDescription(toolNamed(MEMORY_TOOL_NAMES.remember)) ?? "");
    assert.include(description, "Do NOT record");
    assert.include(description, "secrets");
    assert.include(description, "dedupeKey");
  });

  it("tells the agent that an empty search is not a false fact", () => {
    const description = String(Tool.getDescription(toolNamed(MEMORY_TOOL_NAMES.search)) ?? "");
    assert.include(description, "nothing was ever recorded");
    assert.include(description, "projectId");
  });
});
