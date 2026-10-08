import type { MemoryEntry, MemoryHit } from "@t3tools/memory-protocol";

/** The tag `apps/server` reads to decide a turn carries memory context. */
export const CONTEXT_BLOCK_TAG = "t3_memory";

export const BODY_LINE_MAX_CHARS = 200;
export const TITLE_LINE_MAX_CHARS = 120;

const collapse = (value: string): string => value.replace(/\s+/gu, " ").trim();

const oneLine = (value: string, max: number): string => {
  const collapsed = collapse(value);
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
};

/**
 * One memory as one line.
 *
 * Deliberately carries no id, timestamp, or hit count: this text goes into a
 * provider's prompt, and anything that changes between two renders of the same
 * memory would invalidate the prompt cache for the whole conversation.
 */
export const renderEntryLine = (entry: MemoryEntry): string =>
  `- [${entry.kind}] ${oneLine(entry.title, TITLE_LINE_MAX_CHARS)}: ${oneLine(entry.body, BODY_LINE_MAX_CHARS)}`;

export interface RenderContextInput {
  readonly pinned: ReadonlyArray<MemoryEntry>;
  readonly hits: ReadonlyArray<MemoryHit>;
  readonly maxChars: number;
  /**
   * Whether `hits` came from a query. A session-start block has no query, and
   * labelling its newest entries "Related" would overstate what the service
   * knows about what the user is about to ask.
   */
  readonly hitsAreQueryMatches: boolean;
}

export interface RenderedContext {
  readonly text: string;
  readonly truncated: boolean;
  readonly chars: number;
}

const PINNED_HEADING = "Pinned (curated, always apply):";
const RELATED_HEADING = "Related:";
const RECENT_HEADING = "Recent:";

/**
 * Renders the block a host app injects at the start of a session.
 *
 * Lines are dropped from the end until the block fits the budget, because a
 * half-rendered memory is worse than an absent one; only when a single line
 * cannot fit at all is it cut, and then `truncated` says so.
 */
export const renderContextBlock = (input: RenderContextInput): RenderedContext => {
  const pinnedIds = new Set(input.pinned.map((entry) => entry.id));
  const related = input.hits.filter((hit) => !pinnedIds.has(hit.entry.id));

  const lines: Array<string> = [];
  if (input.pinned.length > 0) {
    lines.push(PINNED_HEADING, ...input.pinned.map(renderEntryLine));
  }
  if (related.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(input.hitsAreQueryMatches ? RELATED_HEADING : RECENT_HEADING);
    lines.push(...related.map((hit) => renderEntryLine(hit.entry)));
  }
  if (lines.length === 0) return { text: "", truncated: false, chars: 0 };

  const header = `<${CONTEXT_BLOCK_TAG}>\n`;
  const footer = `\n</${CONTEXT_BLOCK_TAG}>`;
  const budget = Math.max(0, input.maxChars - header.length - footer.length);

  let truncated = false;
  let kept = lines;
  while (kept.length > 0 && joinedLength(kept) > budget) {
    kept = kept.slice(0, -1);
    truncated = true;
  }
  if (kept.length === 0) {
    const [first = ""] = lines;
    kept = [first.slice(0, Math.max(0, budget))];
    truncated = true;
  }

  const text = `${header}${kept.join("\n")}${footer}`;
  return { text, truncated, chars: text.length };
};

const joinedLength = (lines: ReadonlyArray<string>): number => lines.join("\n").length;
