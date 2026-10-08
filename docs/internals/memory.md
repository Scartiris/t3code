# Memory

This fork ships a persistent, cross-session memory: one store of durable facts, preferences and
decisions that every agent on the box reads and writes in the same shape. The service
([`apps/memory`](../../apps/memory/README.md)) and its wire contract
([`packages/memory-protocol`](../../packages/memory-protocol/src/index.ts)) are separate from the
workbench; T3 Code is one client of them. This page covers only what the code cannot show on its
own: how memory reaches a provider's prompt, and the constraints that make it arrive intact.

For the data model, retrieval rules, REST/MCP/CLI surfaces and the service's own environment
variables, read [`apps/memory/README.md`](../../apps/memory/README.md). Do not copy it here.

## The contract package is deliberately outside `packages/contracts`

The repo rule is that anything crossing the wire is typed in `packages/contracts`. Memory is not,
and that exception has to stay an exception: the service is its own process, its protocol package
depends on nothing but `effect`, and `packages/contracts` contains no memory types. Putting the
memory shapes in contracts would make a memory client inherit the workbench's RPC surface, and would
point the dependency the wrong way — the workbench speaks memory, memory never speaks back.

`packages/memory-protocol` exports raw TypeScript (`exports["."] → ./src/index.ts`), so consumers
need no build step. It is **not** a declared dependency of `apps/server`: no edge exists in
`apps/server/package.json` or in `pnpm-lock.yaml`, even though files under `apps/server/src/memory`
and `apps/server/src/mcp/toolkits/memory` import it. Resolution there depends on the workspace graph
rather than a linked dependency, which is the kind of thing that holds until a build, a fresh
install on another machine, or a bundler that reads `package.json` says otherwise. Declare it as
`workspace:*` in `apps/server/package.json` to make the import honest.

`MEMORY_ENV` (`packages/memory-protocol/src/protocol.ts`) names the variables both sides agree on,
and the protocol version bumps only on breaking shape changes — every decoder ignores unknown keys,
so an older client keeps working against a newer service.

A second implementation does not have to trust that sentence:
[`packages/memory-conformance`](../../packages/memory-conformance/README.md) is a black-box suite
that talks to any running service through nothing but the shared client, and it is the contract's
first consumer of its own promise. Before swapping a dedicated memory backend in, run it - the
failures are that adapter's diff.

## Configuration is deployment-owned, never a setting

`T3CODE_MEMORY_URL` and `T3CODE_MEMORY_TOKEN_FILE` are read once, at module load, by
[`readMemoryConnection`](../../apps/server/src/memory/MemoryConnection.ts). Both must be set. The
token is a file, not an environment value, and must be at least `MEMORY_MIN_TOKEN_CHARS` long.

That placement is forced: a bearer token cannot live in a database the clients read, and the URL is
a property of the machine rather than a preference. The consequence is a rule for anyone wiring a
new surface — **no connection means no memory tools and no injected block**, the same shape as a
withheld MCP credential. `MemoryToolkitRegistrationLive` registers `Layer.empty` when the
environment is unconfigured, because five tools that answer "not configured" on every call are
worse than none. A half-configured deployment (one variable, unreadable token, short token) is
called out once at startup by `memoryConnectionProblem()`
([`server.ts`](../../apps/server/src/server.ts)); absence stays silent because absence is a choice.

## How memory reaches the prompt

The rendered `<t3_memory>` block is fetched once per provider session and cached in a module-level
map keyed by `ThreadId` ([`ThreadMemoryBlock.ts`](../../apps/server/src/memory/ThreadMemoryBlock.ts)).
[`warmMemoryBlock`](../../apps/server/src/orchestration-v2/ProviderSessionManager.ts) runs inside
`mcpPrepareLock`, immediately after the thread's MCP credential is minted, and is a no-op when a
value already exists — including a cached empty string, so a failed fetch is not retried per turn.
Both MCP-session teardown paths clear the entry.

Two decisions in that shape are load-bearing:

- **The map is module-level state, not a service**, like `McpProviderSession`. Adapters read it
  synchronously while assembling a turn and hold no service handle, so a `Layer`-based lookup is
  not available at the call site. The map is per-process and lost on restart; the memory lives in
  the service, not the cache.
- **`MemoryService` is composed into the orchestration layer and read as an optional
  service.** `ProviderSessionManager` resolves it with `Effect.serviceOption` when the layer
  is built, and
  [`runtimeLayer.ts`](../../apps/server/src/orchestration-v2/runtimeLayer.ts) puts the
  deployment's service in that context. An optional read is silent: a composition that
  forgets to provide it starts every session with no block, logs nothing, and fails no
  typecheck, while the memory tools keep working and nothing looks broken.
  `ProviderSessionManager.test.ts` pins that a prepared session really carries the block.

Retrieval is scoped by the thread's `projectId`, not its `ThreadId`, so every thread in a project
shares one block. A read with no project sees global entries only, so a missing project id fails
closed rather than leaking another project's notes.

## Byte stability is a contract, not an optimization

The block sits near the front of the prompt. Anything that changes between two turns invalidates
the provider's prompt cache for everything after it, which costs the user money and latency on
every turn of the conversation. So determinism is enforced at four boundaries, and each has to hold
on its own:

- `apps/memory/src/render/contextBlock.ts` renders no ids, timestamps or hit counts, and drops
  lines from the end to fit the budget — a half-rendered memory is worse than an absent one.
- `apps/memory/src/retrieval/rank.ts` breaks ties by id, so identical queries return identical order.
- `ProviderSessionManager.warmMemoryBlock` fetches once per session, so the block cannot drift
  mid-conversation.
- `provider/CodexDeveloperInstructions.ts` gives Codex its own `t3_memory` additional-context key.

That last bullet is the reason the injection path has two shapes rather than one. Codex resends an
entry only when its value changes, so folding memory into `t3_code_runtime` would make that entry
churn; separate keys also keep each value under Codex's per-entry token cap. Every other adapter —
Claude, Cursor, OpenCode, OpenCode 2, and the shared ACP path that Grok and Antigravity use —
passes the block as the second argument to
[`buildRuntimeInstructions`](../../apps/server/src/provider/RuntimeInstructions.ts), which appends
it after the pull-request-linking instructions. Cursor's block lands in the user message because
that is where its runtime info already goes.

`PiAdapterV2` never calls `buildRuntimeInstructions`, so Pi gets the five tools (they are
registered on the global `t3-code` MCP server) and no pushed block. A new adapter that skips the
argument silently opts out of memory, which no test will tell you.

`MEMORY_TOOL_GUIDANCE` is appended under the same condition that attaches the tools. Guidance
naming tools a turn does not have is a bug in either direction, and `RuntimeInstructions.test.ts`
pins it.

## Agents pull; the prompt only pushes at session start

A memory written mid-session is not visible in that session's prompt. That is the intended design,
not a defect: the block is a snapshot taken when the session was prepared, and
`memory_search` is how an agent sees anything newer. So the tools are the live surface and the
block is a starting orientation.

Memory writes are attributed to the calling thread. The proxy handler resolves the thread's shell
to learn its project and provenance, fills in a missing `projectId` on a search or a
`scope: "project"` write, and degrades to "no project" when the shell cannot be read — hiding other
projects' memories rather than exposing them. Provenance travels as the `x-memory-source` header,
transport metadata the proxied agent never has to construct.

## Clients see memory actions, not memory content

There is no settings toggle, browser, or review surface; `apps/web` and `apps/mobile` contain no
reference to the subsystem. The only user-visible trace is the work log: `memory-read` and
`memory-write` are added to `T3McpToolSummaryAction` in
[`t3McpToolPresentation.ts`](../../packages/shared/src/t3McpToolPresentation.ts), rendered by
[`work-log/presentation.ts`](../../packages/client-runtime/src/work-log/presentation.ts), and
`memory-write` shares priority 0 with edits and sent messages — a write changes what every later
session believes. Those labels go through `t()`; the sibling
[`t3ToolSummary.ts`](../../packages/client-runtime/src/t3ToolSummary.ts) still builds English
`phrase()` literals, so its summaries stay untranslated in a zh-CN build.

Read-only Claude sessions allow `memory_search` only: it is the one memory tool annotated
`Tool.Readonly`, and `ClaudeAdapterV2.test.ts` cross-checks the allowlist against the toolkit's
annotations so the two cannot drift.

## Deployment

`deploy/pigeoncore/` runs the service as `t3-memory.service` beside
`t3code.service`. The bind is wildcard; who may connect is the unit's cgroup
allow list — loopback plus the tailnet, never the public interface, and never
through Caddy. An agent CLI outside T3 Code attaches the same service directly
(`deploy/pigeoncore/attach/attach-local-clis.mjs`): one store, per-CLI config
entries, nothing replaced — keep that shape rather than inventing a config-sync
daemon. The workbench link is a systemd drop-in (`t3code.service.d/memory.conf`),
not an edit to the unit, so enabling memory leaves `t3code.service` matching
`host/harden-unit.sh` and disabling is one file and one restart. See the
[deployment runbook](../../deploy/pigeoncore/README.md#memory).
