// Black-box conformance for the memory protocol over REST. Everything here
// goes through the shared client or the wire shapes the protocol package
// defines, so a green run means the backend is decode-compatible with the
// ecosystem's client - not that it is the reference implementation.
// The skip notice and per-run marker are test-harness globals, not product
// code: Effect's logging and Random services need a runtime to run in.
// @effect-diagnostics preferSchemaOverJson:off globalFetch:off globalFetchInEffect:off globalConsole:off globalRandom:off
import * as Schema from "effect/Schema";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  makeMemoryClient,
  MemoryApiError,
  MEMORY_MCP_PATH,
  MEMORY_PROTOCOL_VERSION,
  MEMORY_TOOL_NAMES,
  type MemoryId,
} from "@t3tools/memory-protocol";

const BASE_URL = (process.env.MEMORY_CONFORMANCE_URL ?? "").replace(/\/+$/u, "");
const TOKEN = process.env.MEMORY_CONFORMANCE_TOKEN ?? "";
const ENABLED = BASE_URL.length > 0 && TOKEN.length > 0;
if (!ENABLED) {
  console.warn(
    "[memory-conformance] skipped: set MEMORY_CONFORMANCE_URL and MEMORY_CONFORMANCE_TOKEN (see README).",
  );
}

// One token per run so probes never collide with each other or with real
// memories. Single ASCII token on purpose: ranking and tokenization are the
// backend's freedom, so this suite never depends on CJK behaviour.
const MARK = `confrest${Math.random().toString(36).slice(2, 10)}`;

const client = ENABLED
  ? makeMemoryClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      source: { kind: "agent", threadId: MARK, providerInstanceId: "memory-conformance" },
    })
  : null;
const api = () => {
  if (client === null) throw new Error("conformance client used while disabled");
  return client;
};

const created: Array<MemoryId> = [];
const track = <T extends MemoryId>(id: T): T => {
  created.push(id);
  return id;
};

const probe = (label: string) => ({
  title: `${label} ${MARK}`,
  body: `Conformance probe ${label} (${MARK}); not a real preference.`,
  kind: "fact" as const,
  scope: "global" as const,
});

const raw = (path: string, opts: { readonly token?: string | null } = {}) => {
  const token = "token" in opts ? opts.token : TOKEN;
  return fetch(`${BASE_URL}${path}`, {
    headers: {
      accept: "application/json",
      ...(token === null || token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
};

interface Envelope {
  readonly error?: { readonly code?: string; readonly message?: string };
}

const isMemoryApiError = Schema.is(MemoryApiError);

async function expectFailure(run: () => Promise<unknown>, code: string, status?: number) {
  try {
    await run();
  } catch (cause) {
    if (isMemoryApiError(cause)) {
      expect(cause.code).toBe(code);
      if (status !== undefined) expect(cause.status).toBe(status);
      return;
    }
    throw cause;
  }
  throw new Error(`expected a ${code} failure; the call succeeded`);
}

const searchIds = async (input: Parameters<ReturnType<typeof api>["search"]>[0]) =>
  (await api().search(input)).items.map((item) => item.entry.id);

afterAll(async () => {
  if (client === null) return;
  for (const id of created) {
    // Forget is archive; a conformance run stays auditable, never destructive.
    await client
      .setStatus(id, { status: "archived", reason: "conformance cleanup" })
      .catch(() => undefined);
  }
});

describe("memory protocol conformance", () => {
  it.skipIf(!ENABLED)("answers /health open, and reports a usable bearer config", async () => {
    const open = await raw("/health", { token: null });
    expect(open.status).toBe(200);
    const health = await api().health();
    expect(health.ok).toBe(true);
    expect(health.service.length).toBeGreaterThan(0);
    expect(health.protocolVersion).toBe(MEMORY_PROTOCOL_VERSION);
    expect(health.tokenConfigured).toBe(true);
  });

  it.skipIf(!ENABLED)(
    "rejects unauthenticated and wrong-token reads with the unauthorized envelope",
    async () => {
      for (const token of [null, "wrong-token-not-a-real-one"]) {
        const denied = await raw("/v1/entries", { token });
        expect(denied.status).toBe(401);
        const body = (await denied.json()) as Envelope;
        expect(body.error?.code).toBe("unauthorized");
      }
    },
  );

  it.skipIf(!ENABLED)("answers unknown routes with the same 404 envelope", async () => {
    const miss = await raw("/v1/not-a-route");
    expect(miss.status).toBe(404);
    const body = (await miss.json()) as Envelope;
    expect(body.error?.code).toBe("not_found");
  });

  it.skipIf(!ENABLED)("creates, stamps server-owned fields, and reads the entry back", async () => {
    const made = await api().create(probe("basic"));
    track(made.entry.id);
    expect(made.duplicate).toBe(false);
    expect(made.entry.version).toBe(1);
    expect(made.entry.status).toBe("active");
    expect(made.entry.reviewState).toBe("accepted");
    expect(made.entry.pinned).toBe(false);
    expect(made.entry.scope).toBe("global");
    expect(made.entry.projectId).toBeNull();
    const read = await api().get(made.entry.id);
    expect(read.id).toBe(made.entry.id);
    const events = await api().history(made.entry.id);
    expect(events.entryId).toBe(made.entry.id);
    expect(events.events.length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!ENABLED)("collapses a dedupeKey retry onto the same entry", async () => {
    const write = { ...probe("dedupe"), dedupeKey: `${MARK}-dedupe` };
    const first = await api().create(write);
    track(first.entry.id);
    const second = await api().create(write);
    expect(second.duplicate).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
  });

  it.skipIf(!ENABLED)(
    "validates scope rules and keeps other projects' memories invisible",
    async () => {
      const projectId = `proj-${MARK}`;
      await expectFailure(
        () => api().create({ ...probe("bad-global"), projectId }),
        "invalid_request",
        400,
      );
      await expectFailure(
        () => api().create({ title: "x", body: "y", kind: "fact", scope: "project" }),
        "invalid_request",
        400,
      );
      const scoped = await api().create({ ...probe("scoped"), scope: "project", projectId });
      track(scoped.entry.id);

      // No project: global only. A read must not leak another project's note.
      expect(await searchIds({ query: MARK })).not.toContain(scoped.entry.id);
      expect(await searchIds({ query: MARK, projectId: `proj-other-${MARK}` })).not.toContain(
        scoped.entry.id,
      );
      expect(await searchIds({ query: MARK, projectId })).toContain(scoped.entry.id);
    },
  );

  it.skipIf(!ENABLED)("turns expectedVersion into a compare-and-set", async () => {
    const made = await api().create(probe("cas"));
    track(made.entry.id);
    const bumped = await api().update(made.entry.id, {
      expectedVersion: 1,
      title: `corrected ${MARK}`,
    });
    expect(bumped.version).toBe(2);
    await expectFailure(
      () => api().update(made.entry.id, { expectedVersion: 1, title: "stale write" }),
      "conflict",
      409,
    );
    const read = await api().get(made.entry.id);
    expect(read.title).toBe(`corrected ${MARK}`);
  });

  it.skipIf(!ENABLED)(
    "archives, restores, and enforces the supersede pairing; search tracks every step",
    async () => {
      const made = await api().create({ ...probe("lifecycle"), tags: [MARK] });
      track(made.entry.id);
      expect(await searchIds({ query: MARK })).toContain(made.entry.id);

      const archived = await api().setStatus(made.entry.id, { status: "archived" });
      expect(archived.id).toBe(made.entry.id);
      expect(archived.status).toBe("archived");
      expect(await searchIds({ query: MARK })).not.toContain(made.entry.id);

      const restored = await api().setStatus(made.entry.id, { status: "active" });
      expect(restored.status).toBe("active");
      expect(await searchIds({ query: MARK })).toContain(made.entry.id);

      await expectFailure(
        () => api().setStatus(made.entry.id, { status: "superseded" }),
        "invalid_request",
      );
      await expectFailure(
        () =>
          api().setStatus(made.entry.id, {
            status: "superseded",
            supersededBy: "mem-supersede-target-does-not-exist" as MemoryId,
          }),
        "not_found",
      );

      const replacement = await api().create(probe("replacement"));
      track(replacement.entry.id);
      const superseded = await api().setStatus(made.entry.id, {
        status: "superseded",
        supersededBy: replacement.entry.id,
        reason: "conformance supersede",
      });
      expect(superseded.status).toBe("superseded");
      expect(await searchIds({ query: MARK })).not.toContain(made.entry.id);
      // The reverse door: a superseded entry can come back.
      await api().setStatus(made.entry.id, { status: "active" });
      expect(await searchIds({ query: MARK })).toContain(made.entry.id);
    },
  );

  it.skipIf(!ENABLED)(
    "hides expired entries from recall, includeExpired reveals them",
    async () => {
      const expiring = await api().create({ ...probe("expired"), expiresAt: 1000, tags: [MARK] });
      track(expiring.entry.id);
      expect(await searchIds({ query: MARK })).not.toContain(expiring.entry.id);
      expect(await searchIds({ query: MARK, includeExpired: true })).toContain(expiring.entry.id);
    },
  );

  it.skipIf(!ENABLED)("keeps one invalid batch item from failing the batch", async () => {
    const batch = await api().createBatch({
      entries: [
        probe("batch-ok"),
        { title: "batch-bad", body: "x", kind: "fact", scope: "project" },
      ],
    });
    expect(batch.results.length).toBe(2);
    expect(batch.results[0]?.ok).toBe(true);
    const good = batch.results[0]?.entry;
    if (good !== null && good !== undefined) track(good.id);
    expect(batch.results[1]?.ok).toBe(false);
    expect(batch.results[1]?.error?.code).toBe("invalid_request");
  });

  it.skipIf(!ENABLED)(
    "pages a tag-filtered list with opaque cursors until exhaustion",
    async () => {
      const ids: Array<MemoryId> = [];
      for (const label of ["page-1", "page-2", "page-3"]) {
        const made = await api().create({ ...probe(label), tags: [MARK] });
        ids.push(track(made.entry.id));
      }
      const seen = new Set<MemoryId>();
      let cursor: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const result = await api().list({
          limit: 1,
          tags: [MARK],
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const item of result.items) seen.add(item.entry.id);
        if (result.nextCursor === null) {
          expect(page).toBeGreaterThanOrEqual(2);
          break;
        }
        cursor = result.nextCursor;
      }
      for (const id of ids) expect(seen.has(id)).toBe(true);
    },
  );

  it.skipIf(!ENABLED)(
    "renders context byte-stable, non-empty with a pin, and free of entry ids",
    async () => {
      const pinned = await api().create({ ...probe("pinned"), pinned: true, tags: [MARK] });
      track(pinned.entry.id);
      const first = await api().context({});
      const second = await api().context({});
      expect(first.text).toBe(second.text);
      expect(first.empty).toBe(false);
      expect(first.pinned.some((entry) => entry.id === pinned.entry.id)).toBe(true);
      // ids are the reference's own format; only absence is the contract.
      expect(first.text.includes(pinned.entry.id)).toBe(false);
      // The budget is contract; a block that already fits must render the same
      // bytes, and one that does not must shrink and say so.
      const bounded = await api().context({ maxChars: 200 });
      if (first.text.length <= 200) expect(bounded.text).toBe(first.text);
      else {
        expect(bounded.text.length).toBeLessThanOrEqual(200);
        expect(bounded.truncated).toBe(true);
      }
    },
  );

  it.skipIf(!ENABLED)("leaves recall intact across an index rebuild", async () => {
    const before = (await api().search({ query: MARK })).items.map((item) => item.entry.id);
    expect(before.length).toBeGreaterThan(0);
    const rebuild = await api().rebuildIndex();
    expect(rebuild.indexed).toBeGreaterThanOrEqual(0);
    const after = (await api().search({ query: MARK })).items.map((item) => item.entry.id);
    expect(after.sort()).toEqual([...before].sort());
  });

  // --- the MCP surface -------------------------------------------------------
  // The same tools T3 Code proxies to agents; checked here in the same file
  // and worker as the REST tests so no write can slip between the two
  // context() calls that pin byte stability.
  let sessionId: string | null = null;
  let wireVersion: string | null = null;
  let nextRpcId = 0;

  interface RpcBody {
    readonly result?: unknown;
    readonly error?: unknown;
  }

  async function rpc(method: string, params?: Record<string, unknown>): Promise<RpcBody | null> {
    const isNotification = method.startsWith("notifications/");
    const response = await fetch(`${BASE_URL}${MEMORY_MCP_PATH}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...(wireVersion === null ? {} : { "mcp-protocol-version": wireVersion }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(isNotification ? {} : { id: ++nextRpcId }),
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (isNotification) {
      await response.text();
      return null;
    }
    const text = await response.text();
    if (text.trim().length === 0) return {};
    const frames = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
      : [text];
    for (const frame of frames.toReversed()) {
      try {
        const body = JSON.parse(frame) as RpcBody;
        if (body.result !== undefined || body.error !== undefined) return body;
      } catch {
        // Partial frame; the next one carries the payload.
      }
    }
    return null;
  }

  it.skipIf(!ENABLED)("completes an MCP initialize/initialized round-trip", async () => {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "memory-conformance", version: "0" },
    });
    const result = initialized?.result as
      | { readonly protocolVersion?: string; readonly serverInfo?: { readonly name?: string } }
      | undefined;
    expect(typeof result?.protocolVersion).toBe("string");
    expect((result?.serverInfo?.name ?? "").length).toBeGreaterThan(0);
    wireVersion = result?.protocolVersion ?? null;
    await rpc("notifications/initialized");
  });

  it.skipIf(!ENABLED)(
    "exposes the five canonical tools, each with a non-empty description",
    async () => {
      const listed = await rpc("tools/list");
      const tools = (
        listed?.result as { readonly tools?: ReadonlyArray<{ name: string; description?: string }> }
      )?.tools;
      expect(Array.isArray(tools)).toBe(true);
      const names = (tools ?? []).map((tool) => tool.name);
      const canonical = Object.values(MEMORY_TOOL_NAMES) as ReadonlyArray<string>;
      for (const tool of canonical) expect(names).toContain(tool);
      for (const tool of tools ?? []) {
        if (canonical.includes(tool.name)) {
          expect((tool.description ?? "").trim().length).toBeGreaterThan(20);
        }
      }
    },
  );

  it.skipIf(!ENABLED)(
    "memory_search over MCP recalls an entry the REST write created",
    async () => {
      const made = await api().create({
        title: `mcp round-trip ${MARK}`,
        body: `Created over REST, found over MCP (${MARK}).`,
        kind: "fact",
        scope: "global",
      });
      track(made.entry.id);
      const call = await rpc("tools/call", {
        name: MEMORY_TOOL_NAMES.search,
        arguments: { query: MARK, limit: 10 },
      });
      expect(call?.error).toBeUndefined();
      expect(JSON.stringify(call?.result ?? "")).toContain(made.entry.id);
    },
  );

  it.skipIf(!ENABLED)("returns MCP tool failures as data, not transport errors", async () => {
    const call = await rpc("tools/call", {
      name: MEMORY_TOOL_NAMES.forget,
      arguments: { id: "mem-never-written-conformance" },
    });
    // failureMode "return" is part of the tool contract: the JSON-RPC call
    // succeeds and the payload describes the failure, so an agent reads one
    // shape here and through the t3-code proxy.
    expect(call?.error).toBeUndefined();
    expect(call?.result).toBeDefined();
    expect(JSON.stringify(call?.result ?? "")).toContain("not_found");
  });
});
