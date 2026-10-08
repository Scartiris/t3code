// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { readMemoryConnection } from "./MemoryConnection.ts";

const tokenFile = (contents: string): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-memory-token-"));
  const path = NodePath.join(dir, "token");
  NodeFS.writeFileSync(path, contents, { mode: 0o600 });
  return path;
};

describe("memory connection", () => {
  it("is absent when the deployment never mentioned memory", () => {
    expect(readMemoryConnection({})).toEqual({});
  });

  it("names the variable that is missing", () => {
    const attempt = readMemoryConnection({ T3CODE_MEMORY_URL: "http://127.0.0.1:3211" });
    expect(attempt.connection).toBeUndefined();
    expect(attempt.problem).toContain("T3CODE_MEMORY_TOKEN_FILE");
  });

  it("also complains when only the token is set", () => {
    const attempt = readMemoryConnection({ T3CODE_MEMORY_TOKEN_FILE: "/tmp/token" });
    expect(attempt.problem).toContain("T3CODE_MEMORY_URL");
  });

  it("reads a token and trims a trailing slash from the URL", () => {
    const path = tokenFile(`${"t".repeat(40)}\n`);
    const attempt = readMemoryConnection({
      T3CODE_MEMORY_URL: "http://127.0.0.1:3211///",
      T3CODE_MEMORY_TOKEN_FILE: path,
    });
    expect(attempt.connection).toEqual({
      baseUrl: "http://127.0.0.1:3211",
      token: "t".repeat(40),
    });
  });

  it("refuses a token too short to be a secret", () => {
    const path = tokenFile("short\n");
    const attempt = readMemoryConnection({
      T3CODE_MEMORY_URL: "http://127.0.0.1:3211",
      T3CODE_MEMORY_TOKEN_FILE: path,
    });
    expect(attempt.connection).toBeUndefined();
    expect(attempt.problem).toContain("shorter than");
  });

  it("reports an unreadable token file instead of pretending", () => {
    const attempt = readMemoryConnection({
      T3CODE_MEMORY_URL: "http://127.0.0.1:3211",
      T3CODE_MEMORY_TOKEN_FILE: NodePath.join(NodeOS.tmpdir(), "t3-memory-does-not-exist", "token"),
    });
    expect(attempt.connection).toBeUndefined();
    expect(attempt.problem).toContain("Could not read the memory token");
  });
});
