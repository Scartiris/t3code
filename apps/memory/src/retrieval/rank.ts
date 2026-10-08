/**
 * Ranking, as one pure function so a test can pin it.
 *
 * Three terms only. Relevance is the index's opinion, importance is the
 * writer's, recency is age. Anything more (hit counts, graph distance,
 * embeddings) has to earn its place by beating these on real data.
 */
export const RANK_WEIGHTS = {
  relevance: 0.6,
  importance: 0.25,
  recency: 0.15,
} as const;

/** A month-old memory keeps half its recency credit; the curve never reaches zero. */
export const RECENCY_HALF_LIFE_DAYS = 30;

const DAY_MS = 86_400_000;

export interface RankableHit {
  readonly id: string;
  /** 0..1, computed by the store from the index or from a substring match. */
  readonly relevance: number;
  readonly importance: number;
  readonly updatedAt: number;
}

/**
 * SQLite's `bm25()` is negative and more negative is a better match. The map
 * compresses an unbounded score into 0..1 without letting one exact hit
 * dominate the other two terms.
 */
export const relevanceFromBm25 = (bm25: number): number => {
  const raw = Math.max(0, -bm25);
  return raw / (1 + raw);
};

export const recencyWeight = (updatedAt: number, now: number): number =>
  0.5 ** (Math.max(0, now - updatedAt) / DAY_MS / RECENCY_HALF_LIFE_DAYS);

export const scoreOf = (hit: RankableHit, now: number): number =>
  RANK_WEIGHTS.relevance * hit.relevance +
  RANK_WEIGHTS.importance * hit.importance +
  RANK_WEIGHTS.recency * recencyWeight(hit.updatedAt, now);

export interface RankedHit<A> {
  readonly item: A;
  readonly score: number;
}

/**
 * Sorts by score, then by id, so equal scores come back in the same order on
 * every call: a hit list that reshuffles between two identical queries is how
 * callers end up with non-deterministic prompts.
 */
export const rankHits = <A extends RankableHit>(
  hits: ReadonlyArray<A>,
  now: number,
): ReadonlyArray<RankedHit<A>> =>
  hits
    .map((item) => ({ item, score: scoreOf(item, now) }))
    .sort((left, right) =>
      right.score === left.score
        ? left.item.id.localeCompare(right.item.id)
        : right.score - left.score,
    );
