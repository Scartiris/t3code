/**
 * Build a local ACP Registry index.
 *
 * T3 reads one registry index. To offer agents the public registry does not
 * carry — an in-house ACP server, a pinned internal build — point the server at
 * this file with `T3CODE_ACP_REGISTRY_URL` and it will list them alongside
 * everything the official registry already has.
 *
 * The official index is embedded rather than fetched at runtime so a server with
 * no outbound access still starts and still sees the local entries. Re-run this
 * script to pick up upstream additions.
 *
 *   node deploy/agents/build-registry.mjs [--out <path>] [--offline]
 *
 * Local entries live beside this script as `*.json`, each shaped like one entry
 * from the official registry. An entry whose id already exists upstream
 * overrides it, which is how you pin a version or swap a distribution.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outPath = outIdx > -1 ? argv[outIdx + 1] : path.join(here, "registry.local.json");
const offline = argv.includes("--offline");

// ---------------------------------------------------------------- local entries
const localEntries = fs
  .readdirSync(here)
  .filter((f) => f.endsWith(".json") && !f.startsWith("registry."))
  .map((f) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(here, f), "utf8"));
    if (!parsed.id || !parsed.distribution) {
      throw new Error(`${f}: an entry needs at least "id" and "distribution"`);
    }
    return { file: f, entry: parsed };
  });

// ------------------------------------------------------------- official entries
let official = { version: "1.0.0", agents: [] };
if (!offline) {
  try {
    const res = await fetch(OFFICIAL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    official = await res.json();
  } catch (err) {
    console.warn(`could not fetch the official registry (${err.message}); building local-only`);
  }
}

const byId = new Map((official.agents ?? []).map((a) => [a.id, a]));
let added = 0;
let overridden = 0;
for (const { file, entry } of localEntries) {
  if (byId.has(entry.id)) {
    overridden++;
    console.log(
      `  override  ${entry.id}  (upstream version ${byId.get(entry.id).version} -> ${entry.version})`,
    );
  } else {
    added++;
    console.log(`  add       ${entry.id}  (${file})`);
  }
  byId.set(entry.id, entry);
}

const agents = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
const out = {
  ...official,
  agents,
  // Non-standard, ignored by other ACP clients; useful when debugging a server.
  _generatedBy: "deploy/agents/build-registry.mjs",
  _localEntries: localEntries.map((l) => l.entry.id),
};

fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nwrote ${outPath}`);
console.log(
  `  ${agents.length} agents (${added} added, ${overridden} overridden, ${agents.length - added} from upstream)`,
);
