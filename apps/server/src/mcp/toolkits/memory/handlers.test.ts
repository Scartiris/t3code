import { assert, describe, it } from "@effect/vitest";

import { MemoryApiError, type MemoryWriteInput } from "@t3tools/memory-protocol";

import { entriesWithProject, toFailure, withProjectDefault } from "./handlers.ts";

const entry = (overrides: Partial<MemoryWriteInput> = {}): MemoryWriteInput => ({
  title: "部署前先跑测试",
  body: "上线之前先在本地跑一遍",
  kind: "preference",
  scope: "global",
  ...overrides,
});

describe("memory tool adaptation", () => {
  it("fills the calling thread's project into a search that omitted one", () => {
    assert.deepStrictEqual(withProjectDefault({ query: "部署" }, "proj-1"), {
      query: "部署",
      projectId: "proj-1",
    });
  });

  it("leaves an explicitly named project alone", () => {
    assert.deepStrictEqual(withProjectDefault({ projectId: "proj-2" }, "proj-1"), {
      projectId: "proj-2",
    });
  });

  it("adds nothing when the thread has no project", () => {
    assert.deepStrictEqual(withProjectDefault({ query: "x" }, null), { query: "x" });
  });

  it("scopes a project-shaped write to the calling thread's project", () => {
    const [scoped, global] = entriesWithProject(
      [entry({ scope: "project" }), entry({ scope: "global" })],
      "proj-1",
    );
    assert.strictEqual(scoped?.projectId, "proj-1");
    assert.strictEqual(global?.projectId, undefined);
  });

  it("does not overwrite a project the agent named", () => {
    const [named] = entriesWithProject(
      [entry({ scope: "project", projectId: "proj-9" })],
      "proj-1",
    );
    assert.strictEqual(named?.projectId, "proj-9");
  });

  it("turns a service failure into a tool result instead of a throw", () => {
    const failure = toFailure(
      new MemoryApiError({ code: "unavailable", message: "service is down", status: 0 }),
    );
    assert.strictEqual(failure._tag, "MemoryMcpFailure");
    assert.strictEqual(failure.code, "unavailable");
    assert.strictEqual(failure.message, "service is down");
  });
});
