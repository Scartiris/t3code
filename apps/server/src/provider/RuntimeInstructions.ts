const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher.
</pull_request_linking>`;

/**
 * Appended with the memory block, so it appears exactly when the memory tools
 * are attached. Without it an agent reads the block as background and never
 * looks anything up, which is the failure mode every memory feature has.
 */
export const MEMORY_TOOL_GUIDANCE = `<memory_tools>
Long-term memory is available through the t3-code MCP server: memory_search looks up what earlier sessions recorded, memory_remember writes durable facts and decisions, memory_update corrects one, memory_forget retires one, memory_restore undoes that. Search before asking the user something they have probably already answered, and before re-deriving a decision. Write only what outlives this conversation — not secrets, and not what the repository already states.
</memory_tools>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 *
 * `memoryBlock` is the rendered `<t3_memory>` block for this thread, fetched
 * once when the provider session was prepared. It must be byte-stable for the
 * life of that session: it sits near the front of the prompt, and a value that
 * changed per turn would invalidate the provider's prompt cache every turn.
 */
export function buildRuntimeInstructions(
  runtime: {
    readonly harness: string;
    readonly model?: string | undefined;
    readonly modelName?: string | undefined;
    readonly reasoningEffort?: string | undefined;
  },
  memoryBlock?: string | undefined,
): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const memory = memoryBlock === undefined ? "" : memoryBlock.trim();
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${
    memory.length === 0 ? "" : `\n\n${MEMORY_TOOL_GUIDANCE}\n\n${memory}`
  }`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
