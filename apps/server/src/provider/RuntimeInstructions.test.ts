import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("carries the memory block verbatim when there is one", () => {
    const block = "<t3_memory>\n- [preference] 部署前先跑测试: 上线之前先跑一遍\n</t3_memory>";
    const instructions = buildRuntimeInstructions({ harness: "Claude Code" }, block);
    expect(instructions).toContain(block);
    expect(instructions.endsWith("</t3_memory>")).toBe(true);
  });

  it("explains the memory tools exactly when a block is present", () => {
    const block = "<t3_memory>\n- [preference] x\n</t3_memory>";
    expect(buildRuntimeInstructions({ harness: "Codex" }, block)).toContain("memory_search");
    // The guidance and the tools are attached by the same configuration, so one
    // without the other is always a bug.
    expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain("memory_search");
  });

  it("adds nothing at all without memory", () => {
    expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain("t3_memory");
    expect(buildRuntimeInstructions({ harness: "Codex" }, "")).not.toContain("t3_memory");
    expect(buildRuntimeInstructions({ harness: "Codex" }, "   \n  ")).not.toContain("t3_memory");
  });
});
