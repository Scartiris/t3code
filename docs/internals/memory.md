# Memory

This fork's memory is a persistent, cross-session store of durable facts, preferences and decisions
that agents read and write in one shape. The backend is external: either a service implementing
[`packages/memory-protocol`](../../packages/memory-protocol/src/index.ts), or OpenViking through
[`OpenVikingMemoryService`](../../apps/server/src/memory/OpenVikingMemoryService.ts). Both expose
the same workbench service and tools. This page covers what the code cannot show on its own: how memory reaches a provider's
prompt, and the constraints that make it arrive intact.

## The contract package is deliberately outside `packages/contracts`

The repo rule is that anything crossing the wire is typed in `packages/contracts`. Memory is not,
and that exception has to stay an exception: the service is its own process, its protocol package
depends on nothing but `effect`, and the external memory shapes stay out of `packages/contracts`. Workbench management DTOs
live in contracts because clients use them over RPC; they do not change or re-export the external
protocol. Making that protocol depend on contracts would make a memory client inherit the workbench's RPC surface, and would
point the dependency the wrong way — the workbench speaks memory, memory never speaks back.

`packages/memory-protocol` exports raw TypeScript (`exports["."] → ./src/index.ts`), so consumers
need no build step. `apps/server` declares it as `workspace:*`.

`MEMORY_ENV` (`packages/memory-protocol/src/protocol.ts`) names the variables both sides agree on,
and the protocol version bumps only on breaking shape changes — every decoder ignores unknown keys,
so an older client keeps working against a newer service.

A second implementation does not have to trust that sentence:
[`packages/memory-conformance`](../../packages/memory-conformance/README.md) is a black-box suite
that talks to any running service through nothing but the shared client, and it is the contract's
first consumer of its own promise. Run it against services exposing that REST contract.
OpenViking exposes a different native API; its adapter is tested through `MemoryService` instead.

## Configuration belongs to the environment

Deployment defaults use `T3CODE_MEMORY_URL`, `T3CODE_MEMORY_TOKEN_FILE` and
`T3CODE_MEMORY_BACKEND=openviking` (omission selects the protocol client). The token file
holds a dedicated user API key, not the OpenViking root key.
[`MemoryRuntime`](../../apps/server/src/memory/MemoryRuntime.ts) reads those defaults once
when its layer starts. `memory.enabled: null` inherits them so upgrades preserve an
operator's existing connection; explicit settings override them without restarting.

The URL is relative to the server's network, including for remote clients. Settings keys
use `ServerSecretStore` and clients receive only a redacted marker. A blank key retains
an existing settings key; deployment credentials are reused only when both backend and
normalized destination match. Changing the destination must never forward an unrelated
deployment credential.

The runtime is shared by prompt preparation, MCP handlers and connection checks. It
caches the adapter until its configuration changes, and serializes writes across adapter
replacements because OpenViking has no compare-and-swap. Disabled or incomplete connections
produce no injected block and hide the tools from fresh MCP listings. Existing session
prompts remain snapshots, while tool calls always use current settings. Switching services
changes where new calls go; it does not migrate stored memories.

## OpenViking owns storage and embeddings; the adapter owns workbench semantics

OpenViking 0.5 preserves native `MEMORY_FIELDS` metadata when replacing memory content. The adapter
therefore carries its exact entry and revisions in reserved comments, and reads the highest T3
version when the backend appends older metadata. Those comments never enter embeddings. Changing
the parser to take the final comment would silently resurrect old versions after an update.

Version checks serialize within one service instance because OpenViking 0.5 has no conditional
write API. Give each deployment its own OpenViking user and run only one workbench writer for that
namespace. Migration runs while the old service is stopped, before enabling the new writer.
The OpenViking key stays server-side; web, desktop, mobile and all provider tools use that writer.

Vector searches examine at most 200 candidates per visible scope before applying protocol filters
and ranking. Their totals and cursors describe that candidate set, while an empty query lists all
matching stored memories. This bounds semantic recall work on the provider preparation path.

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
  runtime's service in that context. An optional read is silent: a composition that
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

- The context renderer (the protocol backend or OpenViking adapter) renders no ids, timestamps or hit counts, and drops lines from the end
  to fit the budget — a half-rendered memory is worse than an absent one. The conformance suite
  checks this ([`conformance.test.ts`](../../packages/memory-conformance/src/conformance.test.ts)).
- The backend breaks ranking ties by id, so identical queries return identical order.
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
projects' memories rather than exposing them. The protocol backend receives provenance in the
`x-memory-source` header; the OpenViking adapter persists it in the entry and revision metadata.
The calling agent never has to construct transport metadata.

## Clients manage content through the shared writer

Web and desktop have an OpenViking settings page; mobile has an environment-specific page.
Management uses the same runtime and write semaphore as agent calls. Each operation captures
one connection so a mid-write settings change cannot split a read/modify/write across backends.
Memory edits retain protocol versions and provenance. Knowledge documents live separately under
`viking://~/resources/t3`; archive moves them to the sibling `t3-archive` directory so active
retrieval cannot return them. Content hashes reject stale edits within the one-writer boundary.
Knowledge is pulled through MCP tools rather than pushed into every session prompt.

Agents' memory and knowledge reads and writes appear in the work log: `memory-read` and
`memory-write` are added to `T3McpToolSummaryAction` in
[`t3McpToolPresentation.ts`](../../packages/shared/src/t3McpToolPresentation.ts), rendered by
[`work-log/presentation.ts`](../../packages/client-runtime/src/work-log/presentation.ts), and
`memory-write` shares priority 0 with edits and sent messages — a write changes what every later
session believes. Those labels go through `t()`; the sibling
[`t3ToolSummary.ts`](../../packages/client-runtime/src/t3ToolSummary.ts) still builds English
`phrase()` literals, so its summaries stay untranslated in a zh-CN build.

Read-only Claude sessions allow `memory_search`, `knowledge_search` and `knowledge_read`: these
are the retrieval tools annotated `Tool.Readonly`, and `ClaudeAdapterV2.test.ts` cross-checks the allowlist against the toolkit's
annotations so the two cannot drift.
