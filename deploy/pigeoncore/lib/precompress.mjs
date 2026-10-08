// Write brotli sidecars next to the build output so Caddy can serve them with
// `file_server { precompressed br }`.
//
// Why this exists: Caddy compresses on the fly at its streaming quality, which
// measured ~20% larger than quality 11 on this bundle (utils-5pMIS9-p.js:
// 446,491 B on the wire vs 371 KiB at q11). Every deploy changes every hashed
// filename, so a client re-downloads the whole ~1.4 MiB eager set each time, and
// that is the case this pays for. Sidecars are optional by construction: if this
// fails, the deploy continues and Caddy falls back to compressing on the fly.
//
// Usage: node precompress.mjs <assetsDir> [minBytes]
import { createReadStream, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, extname } from "node:path";
import { brotliCompress, constants } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);

// `.map` is deliberately absent: the deploy strips sourcemaps from the staged
// build, so compressing them here would be work on files that never ship.
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".svg", ".json", ".txt", ".wasm"]);

const assetsDir = process.argv[2];
const minBytes = Number(process.argv[3] ?? 4096);
if (assetsDir === undefined) {
  console.error("usage: precompress.mjs <assetsDir> [minBytes]");
  process.exit(1);
}

const OPTIONS = {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_SIZE_HINT]: 0,
  },
};

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collect(full));
      continue;
    }
    if (!COMPRESSIBLE.has(extname(entry.name))) continue;
    const size = statSync(full).size;
    if (size < minBytes) continue;
    out.push({ full, size });
  }
  return out;
}

const files = collect(assetsDir).sort((a, b) => b.size - a.size);
if (files.length === 0) {
  console.log("  precompress: nothing above the threshold");
  process.exit(0);
}

const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
console.log(`  precompress: ${files.length} files, ${(totalBytes / 1048576).toFixed(1)} MB`);

let written = 0;
let saved = 0;
let next = 0;
const started = Date.now();

async function worker() {
  while (true) {
    const index = next++;
    if (index >= files.length) return;
    const file = files[index];
    const source = await new Promise((resolve, reject) => {
      const chunks = [];
      createReadStream(file.full)
        .on("data", (chunk) => chunks.push(chunk))
        .on("end", () => resolve(Buffer.concat(chunks)))
        .on("error", reject);
    });
    const compressed = await brotli(source, {
      ...OPTIONS,
      params: { ...OPTIONS.params, [constants.BROTLI_PARAM_SIZE_HINT]: source.length },
    });
    const target = `${file.full}.br`;
    // Never ship a sidecar that is larger than the original; Caddy would still
    // prefer it, and the client would pay for the privilege.
    if (compressed.length >= source.length) {
      try {
        unlinkSync(target);
      } catch {
        // Nothing to remove.
      }
      continue;
    }
    writeFileSync(target, compressed, { mode: 0o644 });
    written += 1;
    saved += source.length - compressed.length;
  }
}

const workers = Math.max(1, Math.min(availableParallelism(), 4));
await Promise.all(Array.from({ length: workers }, worker));

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `  precompress: ${written} sidecars in ${seconds}s, ${(saved / 1048576).toFixed(1)} MB smaller`,
);
