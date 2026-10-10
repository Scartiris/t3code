import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

import {
  MemoryEntry,
  MemoryId,
  type MemoryContextResult,
  type MemoryHit,
  type MemorySearchInput,
  type MemoryStatus,
  MemorySource,
} from "@t3tools/memory-protocol";

/*
 * How a protocol memory lives in OpenViking.
 *
 * One entry is one markdown file under `viking://~/memories/t3/`. The visible
 * text is `# title` plus the body, which is what OpenViking embeds and what its
 * search abstract shows. Everything else the protocol owns rides in the
 * file's `MEMORY_FIELDS` comment under a `t3` key, including an exact copy of
 * title and body because native writes normalize visible text. OpenViking strips that block
 * from normal reads and from the embedded text, and keeps it on raw reads.
 *
 * The fields recall has to filter on are mirrored into OpenViking's k=v
 * retrieval tags, because tags are the only filter its vector search applies
 * before ranking. Tags are lowercased by OpenViking, so every tagged value here
 * is either lowercase already or hashed.
 */

/** Where every T3 memory file lives, relative to the authenticated OpenViking user. */
export const OPENVIKING_MEMORY_ROOT = "viking://~/memories/t3";

const TAG = {
  marker: "t3.mem=1",
  status: (status: MemoryStatus) => `t3.status=${status}`,
  visibility: (projectId: string | null) =>
    projectId === null ? "t3.vis=global" : `t3.vis=p${hashKey(projectId)}`,
  pinned: "t3.pinned=1",
  dedupe: (scope: string, projectId: string | null, dedupeKey: string) =>
    `t3.dk=${hashKey(`${scope}\u0000${projectId ?? ""}\u0000${dedupeKey}`)}`,
} as const;

/** Lowercase, `=`-free and short: the only shape an OpenViking tag value survives intact. */
const hashKey = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

/** Exact protocol values, independent of OpenViking's visible-text normalization. */
const StoredFields = Schema.Struct({
  id: MemoryId,
  title: Schema.optionalKey(MemoryEntry.fields.title),
  body: Schema.optionalKey(MemoryEntry.fields.body),
  version: Schema.Int,
  kind: MemoryEntry.fields.kind,
  scope: MemoryEntry.fields.scope,
  projectId: MemoryEntry.fields.projectId,
  tags: MemoryEntry.fields.tags,
  pinned: Schema.Boolean,
  importance: MemoryEntry.fields.importance,
  status: MemoryEntry.fields.status,
  supersededBy: MemoryEntry.fields.supersededBy,
  expiresAt: MemoryEntry.fields.expiresAt,
  dedupeKey: MemoryEntry.fields.dedupeKey,
  source: MemoryEntry.fields.source,
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
  reviewState: Schema.optionalKey(MemoryEntry.fields.reviewState),
  hitCount: Schema.optionalKey(MemoryEntry.fields.hitCount),
  lastAccessedAt: Schema.optionalKey(MemoryEntry.fields.lastAccessedAt),
});

const MemoryFieldsEnvelope = Schema.fromJsonString(
  Schema.Struct({
    t3: StoredFields,
    revisions: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          entry: MemoryEntry,
          actor: MemorySource,
          reason: Schema.optionalKey(Schema.String),
        }),
      ),
    ),
  }),
);
const decodeEnvelope = Schema.decodeUnknownOption(MemoryFieldsEnvelope);
const encodeEnvelope = Schema.encodeSync(MemoryFieldsEnvelope);
const decodeEntry = Schema.decodeUnknownOption(MemoryEntry);

const MEMORY_FIELDS_PATTERN = /<!--\s*MEMORY_FIELDS\s*\n([\s\S]*?)\n-->/gu;
const TITLE_PATTERN = /^# (.*)\n\n([\s\S]*)$/u;

export const memoryUri = (id: MemoryId): string =>
  `${OPENVIKING_MEMORY_ROOT}/${encodeURIComponent(id)}.md`;

/** The bytes one entry is stored as. A `-->` in a value would end the comment early. */
type Revisions = NonNullable<(typeof MemoryFieldsEnvelope.Type)["revisions"]>;

export const renderMemoryFile = (entry: MemoryEntry, revisions: Revisions = []): string => {
  const json = encodeEnvelope({ t3: entry, revisions }).replaceAll("-->", "--\\u003e");
  // Create parses the first reserved comment; replace retains old metadata and
  // appends it after this content. Put our envelope first and read the highest
  // T3 version, so either layout remains valid without touching native metadata.
  const body = entry.body.replace(/<!--\s*MEMORY_FIELDS\b/gu, "&lt;!-- MEMORY_FIELDS");
  return `# ${collapse(entry.title)}\n\n<!-- MEMORY_FIELDS\n${json}\n-->\n\n${body}`;
};

const latestEnvelope = (raw: string) => {
  let latest: typeof MemoryFieldsEnvelope.Type | undefined;
  for (const match of raw.matchAll(MEMORY_FIELDS_PATTERN)) {
    const fields = decodeEnvelope(match[1] ?? "");
    if (
      fields._tag === "Some" &&
      (latest === undefined || fields.value.t3.version > latest.t3.version)
    )
      latest = fields.value;
  }
  return latest;
};

/** Previous versions travel in the same atomic file write and never enter embeddings. */
export const memoryRevisions = (raw: string): Revisions => latestEnvelope(raw)?.revisions ?? [];

/** `undefined` for any file this adapter did not write, so stray files never decode as memories. */
export const parseMemoryFile = (raw: string): MemoryEntry | undefined => {
  const fields = latestEnvelope(raw);
  if (fields === undefined) return undefined;
  const visible = TITLE_PATTERN.exec(raw.replace(MEMORY_FIELDS_PATTERN, "").trim());
  const entry = decodeEntry({
    ...fields.t3,
    title: fields.t3.title ?? visible?.[1],
    body: fields.t3.body ?? visible?.[2],
    reviewState: fields.t3.reviewState ?? "accepted",
    hitCount: fields.t3.hitCount ?? 0,
    lastAccessedAt: fields.t3.lastAccessedAt ?? null,
  });
  return entry._tag === "Some" ? entry.value : undefined;
};

/** The retrieval tags an entry is indexed under; recall filters are built from the same table. */
export const memoryTags = (entry: MemoryEntry): ReadonlyArray<string> => [
  TAG.marker,
  TAG.status(entry.status),
  `t3.scope=${entry.scope}`,
  TAG.visibility(entry.projectId),
  ...(entry.pinned ? [TAG.pinned] : []),
  ...(entry.dedupeKey === null ? [] : [TAG.dedupe(entry.scope, entry.projectId, entry.dedupeKey)]),
];
/**
 * One recall filter per visibility a read may see. OpenViking ANDs tags, so
 * "global or this project" is two queries, never one; a read with no project
 * sees global entries only, which is how a missing project fails closed.
 */
export const recallTagSets = (input: {
  readonly scope?: "global" | "project" | undefined;
  readonly projectId?: string | undefined;
  readonly includeAllProjects?: boolean | undefined;
  readonly pinnedOnly?: boolean | undefined;
  readonly status?: MemoryStatus | undefined;
}): ReadonlyArray<ReadonlyArray<string>> => {
  const base = [
    TAG.marker,
    TAG.status(input.status ?? "active"),
    ...(input.pinnedOnly ? [TAG.pinned] : []),
  ];
  if (input.includeAllProjects) {
    return input.scope === undefined ? [base] : [[...base, `t3.scope=${input.scope}`]];
  }
  const sets: Array<ReadonlyArray<string>> = [];
  if (input.scope !== "project") sets.push([...base, TAG.visibility(null)]);
  if (input.scope !== "global" && input.projectId !== undefined) {
    sets.push([...base, TAG.visibility(input.projectId)]);
  }
  return sets;
};

export const dedupeTags = (
  scope: string,
  projectId: string | null,
  dedupeKey: string,
): ReadonlyArray<string> => [TAG.marker, TAG.dedupe(scope, projectId, dedupeKey)];

/** A project-scoped memory needs a project; a global one must not name one. */
export const scopeProblem = (scope: string, projectId: string | null): string | undefined => {
  if (scope === "project" && projectId === null) {
    return 'A memory with scope "project" must carry a projectId.';
  }
  if (scope === "global" && projectId !== null) {
    return 'A memory with scope "global" must not carry a projectId.';
  }
  return undefined;
};

/** Tags tagged as visible and active can lag the file by a write; the file is the authority. */
export const isRecallable = (entry: MemoryEntry, input: MemorySearchInput, now: number): boolean =>
  entry.status === (input.status ?? "active") &&
  (input.includePending === true || entry.reviewState === "accepted") &&
  (input.scope === undefined || entry.scope === input.scope) &&
  (entry.scope === "global" ||
    input.includeAllProjects === true ||
    entry.projectId === input.projectId) &&
  (input.pinnedOnly !== true || entry.pinned) &&
  (input.kinds === undefined || input.kinds.length === 0 || input.kinds.includes(entry.kind)) &&
  (input.tags === undefined ||
    input.tags.length === 0 ||
    input.tags.some((tag) => entry.tags.includes(tag))) &&
  (input.includeExpired === true || entry.expiresAt === null || entry.expiresAt > now);

// --- ranking ---------------------------------------------------------------

/** Relevance is OpenViking's opinion, importance the writer's, recency is age. */
const RANK_WEIGHTS = { relevance: 0.6, importance: 0.25, recency: 0.15 } as const;
const RECENCY_HALF_LIFE_MS = 30 * 86_400_000;

export interface Candidate {
  readonly entry: MemoryEntry;
  /** OpenViking's similarity, 0 when the read had no query. */
  readonly relevance: number;
}

const scoreOf = (candidate: Candidate, now: number): number =>
  RANK_WEIGHTS.relevance * Math.min(1, Math.max(0, candidate.relevance)) +
  RANK_WEIGHTS.importance * candidate.entry.importance +
  RANK_WEIGHTS.recency *
    0.5 **
      (Math.max(0, Math.floor(now / 86_400_000) * 86_400_000 - candidate.entry.updatedAt) /
        RECENCY_HALF_LIFE_MS);

/** Ties break by id, so two identical reads return identical order and identical prompts. */
export const rankCandidates = (
  candidates: ReadonlyArray<Candidate>,
  query: string,
  now: number,
): ReadonlyArray<MemoryHit> =>
  candidates
    .map((candidate) => ({ candidate, score: scoreOf(candidate, now) }))
    .sort((left, right) =>
      query.length === 0
        ? right.candidate.entry.updatedAt - left.candidate.entry.updatedAt ||
          left.candidate.entry.id.localeCompare(right.candidate.entry.id)
        : right.score === left.score
          ? left.candidate.entry.id.localeCompare(right.candidate.entry.id)
          : right.score - left.score,
    )
    .map(({ candidate, score }) => ({
      entry: candidate.entry,
      score,
      snippet: buildSnippet(candidate.entry, query),
    }));

const SNIPPET_MAX_CHARS = 240;
const SNIPPET_BODY_CHARS = 236;
const SNIPPET_LEAD_CHARS = 72;

const collapse = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** A fixed window centred on the first match, so the same read returns the same text. */
export const buildSnippet = (entry: Pick<MemoryEntry, "title" | "body">, query: string): string => {
  const text = collapse(`${entry.title} — ${entry.body}`);
  if (text.length <= SNIPPET_MAX_CHARS) return text;
  const needle = collapse(query).toLowerCase();
  if (needle.length === 0) return `${text.slice(0, SNIPPET_BODY_CHARS)}…`;
  const at = text.toLowerCase().indexOf(needle);
  const start = Math.min(Math.max(0, at - SNIPPET_LEAD_CHARS), text.length - SNIPPET_BODY_CHARS);
  const end = Math.min(text.length, start + SNIPPET_BODY_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};
// --- the injected block -----------------------------------------------------

/** The tag adapters look for when a turn carries memory context. */
export const CONTEXT_BLOCK_TAG = "t3_memory";

const BODY_LINE_MAX_CHARS = 200;
const TITLE_LINE_MAX_CHARS = 120;

const oneLine = (value: string, max: number): string => {
  const collapsed = collapse(value);
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
};

/** No id, timestamp or hit count: anything that changes between renders breaks the prompt cache. */
const renderEntryLine = (entry: MemoryEntry): string =>
  `- [${entry.kind}] ${oneLine(entry.title, TITLE_LINE_MAX_CHARS)}: ${oneLine(entry.body, BODY_LINE_MAX_CHARS)}`;

/**
 * The block injected at the start of a session. Lines drop from the end until
 * it fits, because a half-rendered memory is worse than an absent one.
 */
export const renderContextBlock = (input: {
  readonly pinned: ReadonlyArray<MemoryEntry>;
  readonly hits: ReadonlyArray<MemoryHit>;
  readonly maxChars: number;
  readonly hitsAreQueryMatches: boolean;
}): Pick<MemoryContextResult, "text" | "truncated" | "chars"> => {
  const pinnedIds = new Set(input.pinned.map((entry) => entry.id));
  const related = input.hits.filter((hit) => !pinnedIds.has(hit.entry.id));
  const lines: Array<string> = [];
  if (input.pinned.length > 0) {
    lines.push("Pinned (curated, always apply):", ...input.pinned.map(renderEntryLine));
  }
  if (related.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(input.hitsAreQueryMatches ? "Related:" : "Recent:");
    lines.push(...related.map((hit) => renderEntryLine(hit.entry)));
  }
  if (lines.length === 0) return { text: "", truncated: false, chars: 0 };

  const header = `<${CONTEXT_BLOCK_TAG}>\n`;
  const footer = `\n</${CONTEXT_BLOCK_TAG}>`;
  const budget = input.maxChars - header.length - footer.length;
  if (budget <= 0) return { text: "", truncated: true, chars: 0 };
  let truncated = false;
  let kept = lines;
  while (kept.length > 0 && kept.join("\n").length > budget) {
    kept = kept.slice(0, -1);
    truncated = true;
  }
  if (!kept.some((line) => line.startsWith("- ["))) return { text: "", truncated: true, chars: 0 };
  while (kept.length > 0 && !(kept[kept.length - 1] ?? "").startsWith("- ["))
    kept = kept.slice(0, -1);
  const text = `${header}${kept.join("\n")}${footer}`;
  return { text, truncated, chars: text.length };
};
