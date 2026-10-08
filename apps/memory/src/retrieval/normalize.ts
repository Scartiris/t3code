/**
 * Text preparation for the index and for queries.
 *
 * SQLite's `unicode61` tokenizer treats a run of Han characters as a single
 * token, so neither `trigram` nor the default tokenizer can answer a two
 * character Chinese query: `部署` finds nothing in a document that says
 * `部署前先跑测试`. Measured against the `node:sqlite` build this service runs
 * on, which is why the index carries a second column of overlapping CJK
 * bigrams instead of relying on the tokenizer.
 */

/** Han, kana, and hangul: scripts written without spaces between words. */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/gu;
const ASCII_WORD = /[a-z0-9_.\-/]+/gu;

export const normalizeText = (value: string): string =>
  value.toLowerCase().replace(/\s+/gu, " ").trim();

/**
 * Overlapping two-character grams of every CJK run. One-character runs are
 * kept whole so a single character still lands in the index, though the query
 * side handles that case with a substring scan instead.
 */
export const cjkBigrams = (value: string): ReadonlyArray<string> => {
  const grams: Array<string> = [];
  for (const run of value.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      grams.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      grams.push(run.slice(index, index + 2));
    }
  }
  return grams;
};

export const asciiWords = (value: string): ReadonlyArray<string> =>
  normalizeText(value).match(ASCII_WORD) ?? [];

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

/** Text for the `norm` column: tokenized by `unicode61` into words and whole CJK runs. */
export const buildIndexText = (parts: ReadonlyArray<string>): string =>
  normalizeText(parts.filter((part) => part.length > 0).join(" \n "));

/** Text for the `grams` column: space separated bigrams, each its own token. */
export const buildBigramText = (parts: ReadonlyArray<string>): string =>
  unique(cjkBigrams(parts.filter((part) => part.length > 0).join("\n"))).join(" ");

/**
 * Query terms. Short CJK queries produce no grams at all (`部署` does, `部`
 * does not) — that empty case is the caller's signal to use the substring
 * fallback rather than the index.
 */
export const queryTokens = (query: string): ReadonlyArray<string> =>
  unique([...asciiWords(query), ...cjkBigrams(query)]);

const quoteToken = (token: string): string => `"${token.replaceAll('"', '""')}"`;

/**
 * Whether the index can answer this query at all.
 *
 * A bare CJK character produces one single-character token, and the index
 * stores single characters only when they stood alone in the document — so
 * `部署前` is not reachable by searching `部`. Such a query goes to the
 * substring scan instead.
 */
export const isIndexableQuery = (query: string): boolean =>
  queryTokens(query).some((token) => token.length > 1);

/**
 * An FTS5 `MATCH` expression, or null when the query has no indexable terms.
 * Terms are OR-ed across all columns: the table holds only `norm`, `grams`, and
 * an unindexed id, so a column filter would add syntax without changing results.
 */
export const buildMatchExpression = (query: string): string | null => {
  const tokens = queryTokens(query);
  return tokens.length === 0 ? null : tokens.map(quoteToken).join(" OR ");
};

/** `%`-escaped pattern for the `LIKE ... ESCAPE '!'` substring fallback. */
export const buildLikePattern = (query: string): string =>
  `%${normalizeText(query).replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
