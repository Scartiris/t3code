import { describe, expect, it } from "vite-plus/test";

import { RANK_WEIGHTS, rankHits, recencyWeight, relevanceFromBm25, scoreOf } from "./rank.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const hit = (overrides: Partial<Parameters<typeof scoreOf>[0]> = {}) => ({
  id: "mem_a",
  relevance: 1,
  importance: 0.5,
  updatedAt: NOW,
  ...overrides,
});

describe("relevance", () => {
  it("maps a perfect bm25 to a score below one", () => {
    expect(relevanceFromBm25(-1)).toBeCloseTo(0.5, 5);
    expect(relevanceFromBm25(-1_000)).toBeGreaterThan(0.99);
  });

  it("treats a positive bm25 as no relevance", () => {
    expect(relevanceFromBm25(3)).toBe(0);
  });
});

describe("recency", () => {
  it("halves at the half-life and never reaches zero", () => {
    expect(recencyWeight(NOW, NOW)).toBe(1);
    expect(recencyWeight(NOW - 30 * DAY, NOW)).toBeCloseTo(0.5, 5);
    expect(recencyWeight(NOW - 365 * DAY, NOW)).toBeGreaterThan(0);
  });

  it("does not reward a future timestamp", () => {
    expect(recencyWeight(NOW + 10 * DAY, NOW)).toBe(1);
  });
});

describe("score", () => {
  it("is the weighted sum of its three terms", () => {
    const score = scoreOf(hit({ relevance: 1, importance: 1, updatedAt: NOW }), NOW);
    expect(score).toBeCloseTo(
      RANK_WEIGHTS.relevance + RANK_WEIGHTS.importance + RANK_WEIGHTS.recency,
      5,
    );
  });

  it("lets a fresh entry beat a stale one with the same relevance", () => {
    const fresh = scoreOf(hit({ id: "mem_fresh", updatedAt: NOW }), NOW);
    const stale = scoreOf(hit({ id: "mem_stale", updatedAt: NOW - 120 * DAY }), NOW);
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe("ranking", () => {
  it("orders by score", () => {
    const ranked = rankHits(
      [hit({ id: "mem_low", relevance: 0.2 }), hit({ id: "mem_high", relevance: 0.9 })],
      NOW,
    );
    expect(ranked.map((entry) => entry.item.id)).toEqual(["mem_high", "mem_low"]);
  });

  it("breaks ties by id so two identical queries agree", () => {
    const ranked = rankHits([hit({ id: "mem_b" }), hit({ id: "mem_a" })], NOW);
    expect(ranked.map((entry) => entry.item.id)).toEqual(["mem_a", "mem_b"]);
  });
});
