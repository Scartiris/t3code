import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { MemoryId } from "./base.ts";
import { makeMemoryClient } from "./client.ts";
import { MemoryApiError, memoryErrorFromUnknown } from "./errors.ts";
import { memoryListInputFromSearchParams, memoryListInputToSearchParams } from "./query.ts";
import { MemoryWriteInput } from "./requests.ts";
import { MemoryCreateResult, MemoryHealthResult } from "./responses.ts";

const decodeWrite = Schema.decodeUnknownOption(MemoryWriteInput);

const entryJson = {
  id: "mem_test_0001",
  version: 1,
  title: "部署前先跑测试",
  body: "正文",
  kind: "preference",
  scope: "global",
  projectId: null,
  tags: [],
  pinned: true,
  importance: 0.5,
  status: "active",
  supersededBy: null,
  expiresAt: null,
  dedupeKey: null,
  reviewState: "accepted",
  source: { kind: "human" },
  hitCount: 0,
  lastAccessedAt: null,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
};

describe("write input", () => {
  it("accepts a minimal memory", () => {
    expect(
      Option.isSome(decodeWrite({ title: "t", body: "b", kind: "fact", scope: "global" })),
    ).toBe(true);
  });

  it("rejects an empty title and an over-long body", () => {
    expect(
      Option.isNone(decodeWrite({ title: "  ", body: "b", kind: "fact", scope: "global" })),
    ).toBe(true);
    expect(
      Option.isNone(
        decodeWrite({ title: "t", body: "x".repeat(9_000), kind: "fact", scope: "global" }),
      ),
    ).toBe(true);
  });

  it("rejects an unknown kind rather than storing it", () => {
    expect(
      Option.isNone(decodeWrite({ title: "t", body: "b", kind: "musing", scope: "global" })),
    ).toBe(true);
  });
});

describe("list filter query encoding", () => {
  it("round-trips every field the client can send", () => {
    const input = {
      kinds: ["fact", "decision"],
      tags: ["deploy", "ops"],
      scope: "global",
      status: "archived",
      projectId: "proj-1",
      limit: 5,
      cursor: "20",
      includeAllProjects: true,
      includeExpired: true,
      includePending: true,
      pinnedOnly: true,
    } as const;
    expect(memoryListInputFromSearchParams(memoryListInputToSearchParams(input))).toEqual(input);
  });

  it("omits absent fields instead of sending false", () => {
    expect(memoryListInputToSearchParams({}).toString()).toBe("");
    expect(memoryListInputFromSearchParams(new URLSearchParams(""))).toEqual({});
  });

  it("repeats keys for arrays because a tag may contain a comma", () => {
    const encoded = memoryListInputToSearchParams({ tags: ["a,b", "c"] });
    expect(encoded.getAll("tag")).toEqual(["a,b", "c"]);
  });
});

describe("client", () => {
  const client = (
    respond: (url: string, init: RequestInit) => Response,
    source?: { readonly kind: "agent" },
  ) =>
    makeMemoryClient({
      baseUrl: "http://memory.test",
      token: "t".repeat(40),
      ...(source === undefined ? {} : { source }),
      fetchImplementation: async (url, init) => respond(url, init),
    });

  it("reads health without a token requirement of its own", async () => {
    const health = {
      ok: true,
      service: "t3-memory",
      version: "0.1.0",
      protocolVersion: "1",
      entries: { active: 0, superseded: 0, archived: 0, pinned: 0 },
      databasePath: "/tmp/memory.sqlite",
      databaseBytes: 0,
      tokenConfigured: true,
      startedAt: 1,
      lastWriteAt: null,
    };
    const result = await client(() => Response.json(health)).health();
    expect(Schema.decodeUnknownSync(MemoryHealthResult)(result).service).toBe("t3-memory");
  });

  it("sends the bearer token and the caller provenance", async () => {
    let seen: RequestInit | undefined;
    await client(
      (_url, init) => {
        seen = init;
        return Response.json({ entry: entryJson, duplicate: false }, { status: 201 });
      },
      { kind: "agent" },
    ).create({ title: "t", body: "b", kind: "fact", scope: "global" });

    const headers = seen?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${"t".repeat(40)}`);
    expect(headers["x-memory-source"]).toBe(JSON.stringify({ kind: "agent" }));
  });

  it("decodes a created entry", async () => {
    const result = await client(() =>
      Response.json({ entry: entryJson, duplicate: false }, { status: 201 }),
    ).create({ title: "t", body: "b", kind: "fact", scope: "global" });
    expect(Schema.decodeUnknownSync(MemoryCreateResult)(result).entry.title).toBe("部署前先跑测试");
  });

  it("maps an error envelope to its code and status", async () => {
    const failure = await client(() =>
      Response.json({ error: { code: "conflict", message: "version mismatch" } }, { status: 409 }),
    )
      .update(MemoryId.make("mem_test_0001"), { title: "t" })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(MemoryApiError);
    expect((failure as MemoryApiError).code).toBe("conflict");
    expect((failure as MemoryApiError).status).toBe(409);
  });

  it("reports a non-JSON failure body as an internal error", async () => {
    const failure = await client(() => new Response("<html>nope</html>", { status: 502 }))
      .search({ query: "x" })
      .catch((cause: unknown) => cause);
    expect((failure as MemoryApiError).code).toBe("internal");
  });

  it("reports an unreachable service as unavailable", async () => {
    const failure = await client(() => {
      throw new Error("connect ECONNREFUSED");
    })
      .search({ query: "x" })
      .catch((cause: unknown) => cause);
    expect((failure as MemoryApiError).code).toBe("unavailable");
    expect((failure as MemoryApiError).status).toBe(0);
  });

  it("reports a payload it cannot read instead of returning junk", async () => {
    const failure = await client(() => Response.json({ nope: true }))
      .search({ query: "x" })
      .catch((cause: unknown) => cause);
    expect((failure as MemoryApiError).code).toBe("internal");
  });
});

describe("error mapping", () => {
  it("treats a timeout as unavailable", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(memoryErrorFromUnknown(timeout).code).toBe("unavailable");
  });

  it("passes an existing api error through", () => {
    const original = new MemoryApiError({ code: "not_found", message: "x", status: 404 });
    expect(memoryErrorFromUnknown(original)).toBe(original);
  });
});
