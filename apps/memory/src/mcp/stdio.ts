// The bridge relays opaque JSON-RPC lines verbatim; schema-decoding foreign
// payloads here would reject traffic it must pass through untouched.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off globalFetchInEffect:off
import * as NodeReadline from "node:readline";

import * as Effect from "effect/Effect";

/**
 * Stdio-to-HTTP bridge for the memory MCP endpoint.
 *
 * `t3-memory mcp-stdio` is the MCP server an agent that only speaks stdio
 * spawns: it forwards each JSON-RPC line to the service's streamable-HTTP
 * endpoint, replays the negotiated session id and protocol version, writes
 * single JSON responses back as one line, and turns SSE events into one line
 * each. Notification acknowledgements (202/204) produce no output.
 *
 * This mirrors the bridge T3 Code runs for ACP agents, for the same reason:
 * stdio is the transport every MCP client supports, and the service itself
 * wants to keep one HTTP surface.
 */
export interface MemoryMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input?: NodeJS.ReadableStream | undefined;
  readonly output?: { write(chunk: string): unknown } | undefined;
  readonly fetchImplementation?:
    | ((url: string, init?: RequestInit) => Promise<Response>)
    | undefined;
}

const bridgeError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const asEnvelope = (value: unknown): { readonly id?: unknown; readonly result?: unknown } | null =>
  typeof value === "object" && value !== null ? (value as { readonly id?: unknown }) : null;

const protocolVersionOf = (payload: unknown): string | null => {
  const result = asEnvelope(payload)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
};

async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let separator = buffered.search(/\n\n|\r\n\r\n/u);
    while (separator !== -1) {
      const rawEvent = buffered.slice(0, separator);
      buffered = buffered.slice(separator).replace(/^(?:\r?\n){2}/u, "");
      const data = rawEvent
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
      separator = buffered.search(/\n\n|\r\n\r\n/u);
    }
  }
}

/** Every JSON-RPC payload a response carries, in arrival order. */
const responsePayloads = async (response: Response): Promise<ReadonlyArray<unknown>> => {
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return [];
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body !== null) {
    const payloads: Array<unknown> = [];
    for await (const data of sseDataLines(response.body)) {
      try {
        payloads.push(JSON.parse(data));
      } catch {
        // A malformed SSE event is the server's problem, not a reason to kill
        // the client's session; the next event still carries its response.
      }
    }
    return payloads;
  }
  const text = await response.text();
  if (text.trim().length === 0) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
};

export const runMemoryMcpStdioBridge = (
  options: MemoryMcpStdioBridgeOptions,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const doFetch = options.fetchImplementation ?? ((url, init) => fetch(url, init));
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;

    const write = (payload: unknown) => {
      output.write(`${JSON.stringify(payload)}\n`);
    };

    const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }

      let response: Response;
      try {
        response = await doFetch(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: options.authorization,
            ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
            ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
          },
          body: JSON.stringify(message),
        });
      } catch (cause) {
        // Answer inside the protocol so the client reports it as a failed call
        // rather than as a dead server it cannot explain.
        const id = asEnvelope(message)?.id;
        if (id !== undefined) {
          write({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32_000,
              message: `Memory MCP endpoint unreachable: ${bridgeError(cause).message}`,
            },
          });
        }
        continue;
      }

      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      if (!response.ok) {
        const id = asEnvelope(message)?.id;
        if (id !== undefined) {
          write({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32_000,
              message: `Memory MCP endpoint responded with HTTP ${response.status}.`,
            },
          });
        }
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      for (const payload of await responsePayloads(response)) {
        protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
        write(payload);
      }
    }
  });
