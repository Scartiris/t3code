# memory-conformance

A black-box acceptance suite for **any** implementation of the memory protocol
([`@t3tools/memory-protocol`](../memory-protocol/src/index.ts)). The point of
this package is that the backend is not required to be ours. Nothing here
imports a server implementation — every call goes through the protocol package's own client or the wire
formats it defines, so a green run means "this backend satisfies the contract",
not "this backend is ours".

The protocol header promises _"a second implementation only has to satisfy
these schemas"_. This suite is what makes that promise checkable: to choose a
dedicated memory project later, point it behind a protocol-shaped adapter, run
the suite, and the failures are the adapter's diff.

## Run

```powershell
# against any running implementation, scratch store strongly preferred
$env:MEMORY_CONFORMANCE_URL = "http://127.0.0.1:3211"
$env:MEMORY_CONFORMANCE_TOKEN = (Get-Content $env:USERPROFILE\.t3-memory\token -Raw).Trim()
vp test run packages/memory-conformance
```

Point it at a disposable store, never a store you care about: the suite writes
entries to whatever backend `MEMORY_CONFORMANCE_URL` names.

Without both env vars every test skips, so the package stays green in normal
`vp run -r test` runs — the suite is opt-in because it writes to the store it
is pointed at. Writes are tagged with a per-run marker and archived afterwards
(`forget` is archive, not delete — a conformance run is always visible in
`/v1/entries?status=archived`).

## What is a contract, and what is left free

Checked: bearer auth and the 401/404/400/409 envelope; every response shape
(the client schema-decodes each one, so "decodable by the shared client" is the
bar); create/read round-trips and `duplicate` on `dedupeKey` retries;
`expectedVersion` compare-and-set; scope validation and the fail-closed rule
(no `projectId` reveals global entries only); archive/supersede/restore and what
search shows at each step; expired-entry hiding with the `includeExpired`
escape; opaque-cursor pagination; `reviewState`/version fields present; audit
history grows on writes; `/v1/context` determinism (repeated calls return
identical bytes, and no entry id may appear in the block); index rebuild
leaving search intact; and the MCP surface: the five `MEMORY_TOOL_NAMES` with
descriptions, and failures returned as data rather than transport errors.

Deliberately not checked — the reference's freedoms: ranking weights and any
specific ordering, tokenizer choice (search tests use unique ASCII tokens only),
storage engine, the block's internal format (only stability and id-absence),
timestamps, and `reviewState` transitions (nothing writes `pending` yet).
A backend that indexes, renders, and ranks differently can still pass, and that
is the point.
