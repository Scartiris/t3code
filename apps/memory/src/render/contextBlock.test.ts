import { describe, expect, it } from "vite-plus/test";

import { MemoryId, type MemoryEntry, type MemoryHit } from "@t3tools/memory-protocol";

import { CONTEXT_BLOCK_TAG, renderContextBlock, renderEntryLine } from "./contextBlock.ts";

const NOW = 1_800_000_000_000;

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: MemoryId.make("mem_test_0001"),
  version: 1,
  title: "部署前先跑测试",
  body: "上线 pigeoncore 之前先在本地跑一遍测试。",
  kind: "preference",
  scope: "global",
  projectId: null,
  tags: [],
  pinned: false,
  importance: 0.5,
  status: "active",
  supersededBy: null,
  expiresAt: null,
  dedupeKey: null,
  reviewState: "accepted",
  source: { kind: "human" },
  hitCount: 0,
  lastAccessedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const hitOf = (memory: MemoryEntry, score = 0.5): MemoryHit => ({
  entry: memory,
  score,
  snippet: memory.body,
});

describe("entry line", () => {
  it("renders kind, title, and a one-line body", () => {
    expect(renderEntryLine(entry())).toBe(
      "- [preference] 部署前先跑测试: 上线 pigeoncore 之前先在本地跑一遍测试。",
    );
  });

  it("collapses newlines so one memory stays one line", () => {
    expect(renderEntryLine(entry({ body: "first\n\nsecond" }))).toContain("first second");
  });

  it("truncates a long body", () => {
    const line = renderEntryLine(entry({ body: "x".repeat(500) }));
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(500);
  });
});

describe("context block", () => {
  it("is empty when there is nothing to say", () => {
    const rendered = renderContextBlock({
      pinned: [],
      hits: [],
      maxChars: 2_000,
      hitsAreQueryMatches: false,
    });
    expect(rendered.text).toBe("");
    expect(rendered.truncated).toBe(false);
    expect(rendered.chars).toBe(0);
  });

  it("wraps pinned and recent entries in one tag", () => {
    const rendered = renderContextBlock({
      pinned: [entry({ pinned: true })],
      hits: [hitOf(entry({ id: MemoryId.make("mem_test_0002"), title: "Caddy 负责 TLS" }))],
      maxChars: 2_000,
      hitsAreQueryMatches: false,
    });
    expect(rendered.text.startsWith(`<${CONTEXT_BLOCK_TAG}>\n`)).toBe(true);
    expect(rendered.text.endsWith(`\n</${CONTEXT_BLOCK_TAG}>`)).toBe(true);
    expect(rendered.text).toContain("Pinned (curated, always apply):");
    expect(rendered.text).toContain("Recent:");
  });

  it("labels query hits as related rather than recent", () => {
    const rendered = renderContextBlock({
      pinned: [],
      hits: [hitOf(entry())],
      maxChars: 2_000,
      hitsAreQueryMatches: true,
    });
    expect(rendered.text).toContain("Related:");
    expect(rendered.text).not.toContain("Recent:");
  });

  it("does not repeat a pinned entry that also matched the query", () => {
    const memory = entry({ pinned: true, title: "唯一一条" });
    const rendered = renderContextBlock({
      pinned: [memory],
      hits: [hitOf(memory)],
      maxChars: 2_000,
      hitsAreQueryMatches: true,
    });
    expect(rendered.text.match(/唯一一条/gu)).toHaveLength(1);
    expect(rendered.text).not.toContain("Related:");
  });

  it("carries no id and no timestamp, so the same memory renders the same bytes", () => {
    const first = renderContextBlock({
      pinned: [entry({ pinned: true })],
      hits: [hitOf(entry({ id: MemoryId.make("mem_test_0009") }))],
      maxChars: 2_000,
      hitsAreQueryMatches: false,
    });
    const second = renderContextBlock({
      pinned: [entry({ pinned: true, updatedAt: NOW + 999_999, hitCount: 42 })],
      hits: [hitOf(entry({ id: MemoryId.make("mem_test_0009"), updatedAt: NOW + 999_999 }))],
      maxChars: 2_000,
      hitsAreQueryMatches: false,
    });
    expect(first.text).toBe(second.text);
    expect(first.text).not.toContain("mem_test");
    expect(first.text).not.toContain("1800000000000");
  });

  it("drops whole lines rather than cutting one when the budget is tight", () => {
    const rendered = renderContextBlock({
      pinned: [],
      hits: [
        hitOf(entry({ id: MemoryId.make("mem_a"), title: "A" })),
        hitOf(entry({ id: MemoryId.make("mem_b"), title: "B" })),
      ],
      maxChars: 120,
      hitsAreQueryMatches: false,
    });
    expect(rendered.truncated).toBe(true);
    expect(rendered.chars).toBeLessThanOrEqual(120);
    expect(rendered.text.endsWith(`\n</${CONTEXT_BLOCK_TAG}>`)).toBe(true);
  });

  it("still stays well formed when even one line cannot fit", () => {
    const rendered = renderContextBlock({
      pinned: [entry({ pinned: true, body: "y".repeat(400) })],
      hits: [],
      maxChars: 40,
      hitsAreQueryMatches: false,
    });
    expect(rendered.truncated).toBe(true);
    expect(rendered.text.startsWith(`<${CONTEXT_BLOCK_TAG}>`)).toBe(true);
    expect(rendered.text.endsWith(`</${CONTEXT_BLOCK_TAG}>`)).toBe(true);
  });
});
