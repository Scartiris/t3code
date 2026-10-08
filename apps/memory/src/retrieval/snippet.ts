import type { MemoryEntry } from "@t3tools/memory-protocol";

export const SNIPPET_MAX_CHARS = 240;
const SNIPPET_BODY_CHARS = 236;
const SNIPPET_LEAD_CHARS = 72;

const collapse = (value: string): string => value.replace(/\s+/gu, " ").trim();

/**
 * A short excerpt for a search result, centred on the first match when there is
 * one. Same shape as the thread search snippet, for the same reason: a fixed
 * window is stable, and a stable window keeps two identical queries returning
 * identical text.
 */
export const buildSnippet = (entry: Pick<MemoryEntry, "title" | "body">, query: string): string => {
  const text = collapse(`${entry.title} — ${entry.body}`);
  if (text.length <= SNIPPET_MAX_CHARS) return text;

  const normalizedQuery = collapse(query).toLowerCase();
  if (normalizedQuery.length === 0) return `${text.slice(0, SNIPPET_BODY_CHARS)}…`;

  const matchIndex = text.toLowerCase().indexOf(normalizedQuery);
  const idealStart = Math.max(0, matchIndex - SNIPPET_LEAD_CHARS);
  const start = Math.min(idealStart, text.length - SNIPPET_BODY_CHARS);
  const end = Math.min(text.length, start + SNIPPET_BODY_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};
