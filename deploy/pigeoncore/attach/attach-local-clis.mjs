// Attach the shared t3-memory MCP server to every locally installed agent
// CLI. Deliberately additive and idempotent: it creates the t3-memory entry
// where missing and never rewrites or removes anything else, so each CLI's own
// built-in servers and skills survive untouched. Re-run it after token
// rotation or on a new machine.
//
//   node deploy/pigeoncore/attach/attach-local-clis.mjs [--url <mcp-url>]
//
// The token comes from T3_MEMORY_TOKEN, else %USERPROFILE%\.t3-memory\token
// (copied from the host: `scp pigeoncore:/opt/t3-memory/token ...`).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const HOME = NodeOS.homedir();
const argUrl = process.argv.indexOf("--url");
const URL =
  argUrl >= 0 && process.argv[argUrl + 1]
    ? process.argv[argUrl + 1]
    : "http://100.121.96.26:3211/mcp";

const tokenFile = NodePath.join(HOME, ".t3-memory", "token");
const TOKEN = process.env.T3_MEMORY_TOKEN?.trim() || NodeFS.readFileSync(tokenFile, "utf8").trim();
if (TOKEN.length < 32) {
  console.error(
    "token missing or too short: copy it with  scp pigeoncore:/opt/t3-memory/token " +
      tokenFile.replace(/\\/g, "/"),
  );
  process.exit(1);
}

const results = [];
const ok = (name, what) => results.push(`  +    ${name}: ${what}`);
const had = (name, what) => results.push(`  =    ${name}: ${what}`);
const skip = (name, why) => results.push(`  skip ${name}: ${why}`);

const readJson = (file) => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch (cause) {
    return { __error: String(cause && cause.message ? cause.message : cause) };
  }
};
const writeJson = (file, data) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};

// --- Qwen Code: settings.json supports ${VAR} interpolation, so the token
// stays in the environment rather than in the config file.
{
  const file = NodePath.join(HOME, ".qwen", "settings.json");
  const settings = NodeFS.existsSync(file) ? readJson(file) : {};
  if (settings.__error)
    skip(
      "qwen",
      "settings.json not parseable (" + settings.__error + "); run `qwen mcp add` yourself",
    );
  else {
    settings.mcpServers ??= {};
    if (settings.mcpServers["t3-memory"]) had("qwen", "t3-memory already configured");
    else {
      // Interpolated at load time; the literal never lands on disk.
      settings.mcpServers["t3-memory"] = {
        httpUrl: URL,
        headers: { authorization: "Bearer ${T3_MEMORY_TOKEN}" },
      };
      writeJson(file, settings);
      ok("qwen", "mcpServers.t3-memory (httpUrl + $T3_MEMORY_TOKEN)");
    }
  }
}

// --- Codex: config.toml has the same bearer-token-via-env mechanism T3 Code
// itself uses for the t3-code server.
{
  const dir = NodePath.join(HOME, ".codex");
  const file = NodePath.join(dir, "config.toml");
  if (!NodeFS.existsSync(dir)) skip("codex", "~/.codex missing");
  else {
    const current = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
    if (current.includes("[mcp_servers.t3-memory]"))
      had("codex", "mcp_servers.t3-memory already configured");
    else {
      const block =
        (current.endsWith("\n") || current === "" ? "" : "\n") +
        "\n# Shared agent memory (t3-memory on the pigeoncore tailnet)\n" +
        "[mcp_servers.t3-memory]\n" +
        `url = "${URL}"\n` +
        'bearer_token_env_var = "T3_MEMORY_TOKEN"\n';
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(file, current + block);
      ok("codex", "[mcp_servers.t3-memory] (bearer_token_env_var)");
    }
  }
}

// --- Claude Code: go through its own CLI so the entry lands in whatever
// shape its settings loader expects.
{
  const get = NodeChildProcess.spawnSync("claude", ["mcp", "get", "t3-memory"], {
    encoding: "utf8",
    shell: true,
  });
  if (get.error && get.error.code === "ENOENT") skip("claude", "claude CLI not on PATH");
  else if (get.status === 0) had("claude", "t3-memory already configured");
  else {
    const add = NodeChildProcess.spawnSync(
      "claude",
      [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "http",
        "t3-memory",
        URL,
        "--header",
        `authorization: Bearer ${TOKEN}`,
      ],
      { encoding: "utf8", shell: true },
    );
    if (add.status === 0) ok("claude", "user-scope http server");
    else skip("claude", "mcp add failed: " + (add.stderr || add.stdout || "").trim().slice(0, 160));
  }
}

// --- OpenCode: remote MCP with the same env interpolation in headers.
{
  const dir = NodePath.join(HOME, ".config", "opencode");
  const file = NodePath.join(dir, "opencode.json");
  if (!NodeFS.existsSync(dir) && !NodeFS.existsSync(file)) skip("opencode", "no config directory");
  else {
    const config = NodeFS.existsSync(file) ? readJson(file) : {};
    if (config.__error) skip("opencode", "opencode.json not parseable; add the server yourself");
    else {
      config.mcp ??= {};
      if (config.mcp["t3-memory"]) had("opencode", "t3-memory already configured");
      else {
        config.mcp["t3-memory"] = {
          type: "remote",
          url: URL,
          enabled: true,
          headers: { authorization: "{env:T3_MEMORY_TOKEN}" },
        };
        writeJson(file, config);
        ok("opencode", "mcp.t3-memory (remote + {env:})");
      }
    }
  }
}

console.log("t3-memory attach -> " + URL);
for (const line of results) console.log(line);
console.log(
  "Cursor and any CLI not listed: point its MCP config at the same URL with  authorization: Bearer <token>.",
);
console.log(
  "Restart each CLI to pick the server up (T3 Code threads already reach the same service through the t3-code proxy).",
);
