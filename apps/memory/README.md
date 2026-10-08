# t3-memory

A memory service: one store of durable facts, preferences, and decisions that
every agent on this box can read and write, in the same shape, over HTTP, MCP,
or a CLI.

The wire contract lives in [`packages/memory-protocol`](../../packages/memory-protocol)
— this app is its reference implementation. T3 Code is the first client: it
proxies the tools through its own `t3-code` MCP server and injects a rendered
block at the start of each provider session.

## What it is not

- **No model of its own.** Nothing here calls an LLM. Extraction and curation
  are the host's job (T3 Code does it with the user's existing provider
  subscription, so memory costs no extra API key). The store exposes
  `reviewState: "pending"` for the day a pipeline writes memories a human has
  not approved yet; nothing sets it today.
- **No embeddings.** Retrieval is SQLite FTS5 plus a CJK bigram column. That is
  deliberate: it is exact, offline, free, and adequate at the scale of one
  person's working notes. `embedding`-shaped retrieval can be added behind the
  same `/v1/search` shape when there is evidence it is needed.
- **Not multi-user.** One store, one bearer token, loopback by default.

## Run it

```bash
t3-memory token          # create the bearer token file (0600) if missing
t3-memory serve          # HTTP + MCP on 127.0.0.1:3211
t3-memory health         # ask a running service how it is doing
```

Environment:

| Variable            | Default                | Meaning                              |
| ------------------- | ---------------------- | ------------------------------------ |
| `MEMORY_HOME`       | `~/.t3-memory`         | Base directory                       |
| `MEMORY_DB`         | `<home>/memory.sqlite` | SQLite file                          |
| `MEMORY_TOKEN_FILE` | `<home>/token`         | Bearer token, at least 32 characters |
| `MEMORY_HOST`       | `127.0.0.1`            | Bind address                         |
| `MEMORY_PORT`       | `3211`                 | Port                                 |

A missing or too-short token does not stop the service: it starts, answers
`/health` with `tokenConfigured: false`, and rejects every authenticated route
with a message naming the fix. A service that refuses to boot cannot be
diagnosed over the network, and systemd would only restart it in a loop.

## Surfaces

### MCP

`POST /mcp` (streamable HTTP, same bearer token as the REST API), and
`t3-memory mcp-stdio`, which speaks MCP on stdin/stdout and forwards to the
running service — the transport for agents that only speak stdio.

| Tool              | What it does                                                   |
| ----------------- | -------------------------------------------------------------- |
| `memory_search`   | Ranked search. Omit the query to list the newest entries.      |
| `memory_remember` | Write up to 50 entries.                                        |
| `memory_update`   | Correct one entry, with `expectedVersion` for compare-and-set. |
| `memory_forget`   | Archive, or mark superseded by another entry.                  |
| `memory_restore`  | Undo a forget.                                                 |

Tool descriptions are part of the product: they say when _not_ to write, and
that an empty search result means "nothing recorded", not "false".

### REST

| Method  | Path                       | Notes                                   |
| ------- | -------------------------- | --------------------------------------- |
| `GET`   | `/health`                  | Open; counts and paths only, no content |
| `POST`  | `/v1/entries`              | Create; `dedupeKey` makes it idempotent |
| `POST`  | `/v1/entries/batch`        | Up to 50, per-item results              |
| `GET`   | `/v1/entries`              | List with filters (no ranking)          |
| `GET`   | `/v1/entries/<id>`         | Read one                                |
| `PATCH` | `/v1/entries/<id>`         | Partial update                          |
| `POST`  | `/v1/entries/<id>/status`  | archive / supersede / restore           |
| `GET`   | `/v1/entries/<id>/history` | Audit events                            |
| `POST`  | `/v1/search`               | Ranked search                           |
| `POST`  | `/v1/context`              | Rendered, injectable block              |
| `POST`  | `/v1/index/rebuild`        | Rebuild the FTS index from the table    |

Errors are always `{ "error": { "code", "message", "details"? } }` with `code`
one of `unauthorized`, `invalid_request`, `not_found`, `conflict`,
`unavailable`, `internal`.

`x-memory-source` carries the caller's provenance as JSON
(`{"kind":"agent","threadId":"…","providerInstanceId":"…"}`). It is transport
metadata, not payload: a proxy knows it, the agent it proxies for should not
have to say.

### CLI

```bash
t3-memory remember --title "部署前先跑测试" --body "…" --kind preference --pinned
t3-memory search 部署 --project <id>
t3-memory context --project <id>      # exactly what a session would inject
t3-memory list --status archived
t3-memory forget <id> --reason "过时了"
t3-memory restore <id>
```

## Model

- **kind** — `fact`, `preference`, `decision`, `reference`. Four, because
  progress notes belong to the thread that produced them and both T3 Code and
  the provider harnesses already keep that state.
- **scope** — `global` is visible everywhere; `project` only where `projectId`
  matches. A read with no `projectId` sees global entries only, so a caller
  cannot leak another project's notes by forgetting to pass one.
- **status** — `active`, `superseded`, `archived`. Only `active` entries are
  searched or injected; `superseded` keeps the record of what was believed
  before and why it changed.
- **expiresAt** — for facts with a shelf life ("we are migrating, so keep X in
  mind"). Expired entries leave search and injection but stay listable.
- **pinned** — injected at the start of every session. This is the one place a
  human's curation outranks retrieval.
- **dedupeKey** — unique per scope and project. A retry, or two agents learning
  the same fact, collapse onto one entry instead of accumulating near-duplicates.

Ranking is three terms and nothing else: `0.6 × relevance + 0.25 × importance +
0.15 × recency`, with a 30-day half-life on recency (see
`src/retrieval/rank.ts`). Relevance comes from FTS5 `bm25`, or from a substring
match when a query has no indexable terms.

### Why the bigram column

SQLite's `unicode61` tokenizer treats a run of Han characters as one token, so
neither it nor `trigram` can answer a two-character query: `部署` finds nothing
in a document that says `部署前先跑测试`. Measured against the `node:sqlite`
build this runs on, which is why `memory_fts` carries a second column of
overlapping CJK bigrams and queries expand the same way. A one-character query
produces no bigram at all and falls back to a substring scan.

## Context block

`POST /v1/context` returns a rendered `<t3_memory>` block. It is **deterministic**:
no ids, no timestamps, no hit counts — the same entries produce the same bytes,
because it goes near the front of a provider's prompt and anything that churned
per turn would invalidate the prompt cache for the whole conversation.

A session-start block has no query, so its second section is headed `Recent:`
rather than `Related:`. T3 Code fetches it once per provider session and keeps
it for that session's life; agents pull anything newer with `memory_search`.

## T3 Code integration

Configure the server, not the app:

```
T3CODE_MEMORY_URL=http://127.0.0.1:3211
T3CODE_MEMORY_TOKEN_FILE=/opt/t3-memory/token
```

With both set, T3 Code registers the five tools on its own `t3-code` MCP server
(so every provider gets them without a second MCP connection), fills each
thread's project automatically, attributes writes to the calling thread, and
injects the session block. With either missing, nothing is registered and no
block is injected — no settings toggle, no half-advertised feature.

## Operations

- Data lives in one SQLite file; `VACUUM INTO` is a complete backup.
- `t3-memory index-rebuild` repairs the FTS index from the entries table; the
  index is derived state and can always be thrown away.
- Bind to loopback. The deployment (`deploy/pigeoncore/`) runs it as a systemd
  unit beside `t3code.service` and never exposes it through Caddy.

## Planned, not built

`turn.completed` capture (T3 extracts with the provider subscription and writes
`reviewState: "pending"`), a review surface in the clients, embeddings, and
multi-user scoping. The schemas already carry the fields those need; the
endpoints come with the features.
