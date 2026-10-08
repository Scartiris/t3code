import type { MemoryListInput } from "./requests.ts";

/**
 * `GET /v1/entries` query encoding, shared by the client and the service so the
 * two cannot drift. Repeated `kind`/`tag` keys carry arrays because a list
 * filter is the one place a comma-joined value would be ambiguous (tags may
 * contain commas).
 */
export const memoryListInputToSearchParams = (input: MemoryListInput): URLSearchParams => {
  const params = new URLSearchParams();
  for (const kind of input.kinds ?? []) params.append("kind", kind);
  for (const tag of input.tags ?? []) params.append("tag", tag);
  if (input.scope !== undefined) params.set("scope", input.scope);
  if (input.projectId !== undefined) params.set("projectId", input.projectId);
  if (input.includeAllProjects !== undefined) {
    params.set("includeAllProjects", String(input.includeAllProjects));
  }
  if (input.status !== undefined) params.set("status", input.status);
  if (input.pinnedOnly !== undefined) params.set("pinnedOnly", String(input.pinnedOnly));
  if (input.includeExpired !== undefined)
    params.set("includeExpired", String(input.includeExpired));
  if (input.includePending !== undefined)
    params.set("includePending", String(input.includePending));
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  return params;
};

/** Reads back what `memoryListInputToSearchParams` wrote. Unknown keys are ignored. */
export const memoryListInputFromSearchParams = (params: URLSearchParams): MemoryListInput => {
  const kinds = params.getAll("kind").filter((kind) => kind.length > 0);
  const tags = params.getAll("tag").filter((tag) => tag.length > 0);
  const scope = params.get("scope");
  const status = params.get("status");
  const projectId = params.get("projectId");
  const limit = params.get("limit");
  const cursor = params.get("cursor");
  return {
    ...(kinds.length === 0 ? {} : { kinds: kinds as NonNullable<MemoryListInput["kinds"]> }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(scope === null ? {} : { scope: scope as NonNullable<MemoryListInput["scope"]> }),
    ...(status === null ? {} : { status: status as NonNullable<MemoryListInput["status"]> }),
    ...(projectId === null ? {} : { projectId }),
    ...(cursor === null ? {} : { cursor }),
    ...(limit === null || !Number.isFinite(Number(limit)) ? {} : { limit: Number(limit) }),
    ...(params.get("includeAllProjects") === null
      ? {}
      : { includeAllProjects: params.get("includeAllProjects") === "true" }),
    ...(params.get("pinnedOnly") === null
      ? {}
      : { pinnedOnly: params.get("pinnedOnly") === "true" }),
    ...(params.get("includeExpired") === null
      ? {}
      : { includeExpired: params.get("includeExpired") === "true" }),
    ...(params.get("includePending") === null
      ? {}
      : { includePending: params.get("includePending") === "true" }),
  };
};
