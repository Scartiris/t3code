# pigeoncore workbench deployment

This fork is deployed as a self-hosted T3 Code server on the `pigeoncore` VPS and
served at **https://t3.pigeontech.cn**.

## Shape

```
browser ──https/quic──> Caddy (45.92.159.178:443, Let's Encrypt)
                          │  /assets/* served straight off disk, brotli sidecars
                          │  everything else reverse_proxied, WebSocket upgrade passed through
                          ▼
                        t3code.service (systemd)
                          node /opt/t3/dist/bin.mjs serve --host 127.0.0.1 --port 3773
                          T3CODE_HOME=/opt/t3/home
```

| Piece   | Where                                                                                   |
| ------- | --------------------------------------------------------------------------------------- |
| Host    | `pigeoncore` (45.92.159.178), Ubuntu 26.04, 4 vCPU / 7.8 GB                             |
| App     | `/opt/t3` — `dist/` (bundle + `client/`), `node_modules/`, `patches/`                   |
| State   | `/opt/t3/home` (`T3CODE_HOME`); runtime data under `home/userdata`                      |
| Service | `t3code.service`, `WantedBy=multi-user.target`                                          |
| Memory  | `/opt/t3-memory` — `dist/` (bundle), `home/memory.sqlite`, `token`; `t3-memory.service` |
| Proxy   | `caddy.service`, site block for `t3.pigeontech.cn`                                      |
| Node    | `/opt/node24` (v24.21.0), linked into `/usr/local/bin`                                  |
| DNS     | wildcard `*.pigeontech.cn → 45.92.159.178`; no per-host record needed                   |

The server binds to loopback only. Nothing but Caddy is exposed.

## Host setup

The scripts under `host/`, `backup/` and `lib/` describe how this box is
configured. They are checked in so a rebuilt host does not depend on remembering
what was done by hand. Re-run semantics differ per script: `tune-network.sh` is
idempotent, `harden-unit.sh` can be re-run but **replaces the whole
`t3code.service` file**, so hand edits and the deploy's registry `Environment=`
line are lost and you must restart the service yourself, and `precompress.mjs` is
run by the deploy rather than by hand.

| Script                                              | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host/tune-network.sh`                              | BBR + `fq` + a long-RTT sysctl set, written to `/etc/sysctl.d/99-t3-network.conf`. Applies `tc qdisc replace dev ens3`, so the interface name is hardcoded and it needs editing for another box. Clients reach this box from China at a measured ~120 ms RTT and the path is congestion-window limited, not bandwidth limited: one TCP stream moved 1.1 MB/s while eight parallel streams aggregated 5.1 MB/s against a 267 MB/s uplink. HTTP/2 multiplexes a whole first load over one connection, so the single-stream number is the one a page load gets. |
| `host/harden-unit.sh`                               | Rewrites `t3code.service` with `Restart=always` (closes the exit-0 hole), a **reachable** start limit (the stock 10s/5 window cannot fill at `RestartSec=5`, so a permanent fault used to restart forever instead of landing in `failed`), and memory/CPU/IO caps sized above the measured 446 MB provider-install burst. Runs `systemd-analyze verify` and `daemon-reload`, and deliberately does not restart.                                                                                                                                              |
| `backup/t3-backup.sh` + `t3-backup.{service,timer}` | Installed to `/usr/local/bin/t3-backup`, run daily into `/opt/t3-backups`. Takes a `VACUUM INTO` snapshot of `statev2.sqlite` and the memory store, plus the signing keys, settings, attachments and caches; skips `logs/` (108 MB of rotated traces) and `tools/` (445 MB the ACP registry re-creates).                                                                                                                                                                                                                                                     |
| `lib/precompress.mjs`                               | `node precompress.mjs <assetsDir> [minBytes]`. Writes brotli quality-11 `.br` sidecars for the compressible extensions above `minBytes` (default 4096), largest first, and deletes a sidecar when brotli loses to the original. Sourcemaps are skipped because the deploy already stripped them. Run by the deploy against the staging tree.                                                                                                                                                                                                                 |

`Caddyfile` is reconciled by the deploy, so the copy here and the live one cannot
drift; the previous one is kept as `/etc/caddy/Caddyfile.bak-<timestamp>`.

Setting up a fresh host is manual and in this order — Node under `/opt/node24`,
Caddy, ufw (tcp/443 **and** udp/443 for HTTP/3), the `pigeoncore` SSH alias, and
the wildcard DNS record first, then:

```bash
scp deploy/pigeoncore/host/tune-network.sh pigeoncore:/tmp/ && ssh pigeoncore 'bash /tmp/tune-network.sh'
scp deploy/pigeoncore/host/harden-unit.sh  pigeoncore:/tmp/ && ssh pigeoncore 'bash /tmp/harden-unit.sh'
scp deploy/pigeoncore/backup/t3-backup.sh          pigeoncore:/tmp/
scp deploy/pigeoncore/backup/t3-backup.service pigeoncore:/etc/systemd/system/
scp deploy/pigeoncore/backup/t3-backup.timer   pigeoncore:/etc/systemd/system/
ssh pigeoncore 'install -m 755 /tmp/t3-backup.sh /usr/local/bin/t3-backup && systemctl daemon-reload && systemctl enable --now t3-backup.timer'
```

## Backups

`backup/t3-backup.timer` runs daily (`Persistent=true`, so downtime is caught
up); `t3-backup.sh` keeps the newest 14 archives in `/opt/t3-backups`
(`T3_BACKUP_KEEP`). That covers a bad migration or an
accidental delete but not losing the box, so `backup.ps1` pulls the newest archive
off-host:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/pigeoncore/backup.ps1
```

It takes `-SshHost` (default `pigeoncore`), `-DestDir` (default
`%USERPROFILE%\t3-backups`, deliberately outside the worktree so archives never
appear in `git status`) and `-Keep` (default 14 local copies). It changes nothing
on the host: it reads the newest name, skips the pull when the local copy already
has the same byte size, compares the remote `sha256sum` against the local hash and
deletes the local copy if they disagree, then proves the archive opens with
`tar -tzf`.

Restore is `tar -xzf <archive> -C /opt/t3/home` with the service stopped; the
archive's `MANIFEST.txt` lists a sha256 per file for checking before you do.
The archive also carries `memory/memory.sqlite`, which belongs under
`/opt/t3-memory/home/` instead — restore it there with `t3-memory.service`
stopped, and note that the two services can be restored independently.

## Deploy

From the repository root, on this Windows machine:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/pigeoncore/deploy.ps1
```

It builds (`vp run --filter t3 build`), stages the JavaScript, ships it, installs
the native packages **on the host**, restarts the service and verifies HTTPS.

The remote half extracts into a staging directory while the old build is still
serving, renames the new build into place, and probes readiness rather than the
TCP port — the port is bound before recovery finishes, so a port check could
report success while the readiness gate still held every request. The probe is
`GET http://127.0.0.1:3773/.well-known/t3/environment`, looking for
`environmentId`, once a second for sixty tries. Any failure restores the
previous build and starts the service on it, so a bad tarball or a missing patch
degrades to "the deploy did not happen" rather than a dead workbench. The
previous tree is kept as `dist.old` for hand-rolling back one deploy.

That guard covers the install step only. Caddy is reconciled **after** the app
restarts: an unchanged Caddyfile is a no-op, a `caddy validate` failure leaves
the live config alone but aborts the deploy with the new build already serving,
and a failed `caddy reload` restores the config it just replaced. `-SkipVerify`
skips the HTTPS probe, not the Caddy step. Verify then asserts the two properties
the deploy claims: the largest asset must arrive from `file_server` (no
`via: 1.1 Caddy`) with wire bytes equal to its `.br` sidecar, and one
superseded-only chunk must still return 200.

The deploy also writes brotli sidecars (`lib/precompress.mjs`) for Caddy's
`precompressed br gzip`. Only `.br` files are produced; the `gzip` entry is inert
and gzip comes from the site's `encode zstd gzip` on the fly. Caddy's live encoder
measured ~20% larger than quality 11 across the eager set (1401 KB on the wire
against 1173 KB at q11), which matters because every deploy changes every hashed
filename and therefore forces a full re-download. Sidecars are optional: if
generation fails the deploy continues and Caddy compresses live.

A sidecar is not a route. Caddy 404s any `*.br`, `*.gz` or `*.zst` request, so
you cannot `curl` a sidecar to check it — fetch the real asset URL with
`Accept-Encoding: br` and look at `Content-Encoding`.

The same first load is why the web build writes `rel="modulepreload"` links into
`index.html` (`eagerModulePreloadPlugin` in `apps/web/vite.config.ts`).
`src/bootstrap.ts` loads `./main` through a dynamic import, so Vite emits a
runtime preload helper and the ~144-file eager burst only begins once the entry
has been fetched, parsed and executed — a whole round trip on a ~120 ms path. The
plugin walks the entry's static imports plus one level of dynamic import and
writes the links at build time on this machine. It is byte-neutral:
`bootstrap.ts` imports `main` unconditionally, so every one of those chunks was
already fetched on every load.

### Superseded assets are kept

A page opened before a deploy holds an `index.html` naming the previous build's
hashed chunks. Replacing `assets/` wholesale made those requests 404 and killed
the page mid-session, which was observed on 2026-10-06 immediately after a swap.

So the deploy merges older generations into the new `assets/` rather than
replacing it. That is safe because asset names are content hashes — a name can
never mean two different bodies — and it is bounded by an mtime prune
(`-AssetRetentionDays`, default 7). mtimes survive as build times rather than
extraction times, which is what makes the prune meaningful:

```
2026-10-06 01:40    176 files   previous generation, carried forward
2026-10-06 22:07   2333 files   this build
2026-10-06 22:16    484 files   brotli sidecars, written at deploy time
```

The deploy prints how many URLs it superseded and then fetches one of them, so
the property is asserted rather than assumed:

```
    superseded this deploy: 176 files
  superseded asset /assets/ChatMarkdown-CEtPQG0S.js -> 200
```

Precompression runs against the staged build _before_ the carry-forward merge, so
a carried-forward asset keeps the sidecar written in its own deploy generation
and never gains one from a later one. Serve it and Caddy compresses on the fly,
which is why the two features are independent.

| Flag                  | Effect                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-SkipBuild`          | Reuse the existing `apps/server/dist`                                                                                                                                                                   |
| `-SkipVerify`         | Skip the post-restart HTTPS probe; the Caddy reconcile still runs                                                                                                                                       |
| `-SshHost <alias>`    | Where `ssh`/`scp` go. The install, Caddy and verify halves still name `t3.pigeontech.cn`, `/opt/t3` and `/etc/caddy/Caddyfile` outright, so pointing it elsewhere deploys to one box and probes another |
| `-AssetRetentionDays` | Age at which superseded assets are pruned, default 7. This is the only bound on `assets/`, which otherwise grows by a full generation per deploy                                                        |

## Local ACP registry index

`node deploy/agents/build-registry.mjs` merges the entries under `deploy/agents/`
with the upstream index and writes `deploy/agents/registry.local.json`. The
deploy ships that to `/srv/acp/acp-registry.json`, Caddy serves it at
`https://t3.pigeontech.cn/acp-registry.json` with `Cache-Control: no-cache` — T3
refuses a registry URL that is not HTTPS, so a self-hosted index has to come from
a TLS origin — and the deploy sets `T3CODE_ACP_REGISTRY_URL` in the unit to point
the server at it.

Build it before deploying. When the JSON is absent the install step skips quietly
and leaves the existing index alone — but the service is still pointed at the
registry URL, so on a host that never had the file the server reads a 404. And
because `harden-unit.sh` rewrites `t3code.service` while the deploy `sed`s that
same file, the registry `Environment=` line survives a deploy but not a re-run of
the hardening script: re-run the hardening, then the deploy. The append branch is
anchored on `Environment=T3CODE_HOME=`, so on a unit written by hand without that
line the registry URL is silently never added.

## Pair a browser

Pairing tokens are one-time and short-lived. Mint one on the host:

```bash
ssh pigeoncore 'T3CODE_HOME=/opt/t3/home /opt/node24/bin/node /opt/t3/dist/bin.mjs pair --ttl 15m'
```

The command prints a URL pointing at `127.0.0.1` because the server binds to
loopback. **The token is origin-independent** — replace the origin:

```
https://t3.pigeontech.cn/pair#token=<TOKEN>
```

Manage paired devices with `... auth session list` and
`... auth session revoke`; see `... auth --help`.

## Operate

```bash
systemctl status t3code
journalctl -u t3code -f                 # server log
systemctl restart t3code
systemctl status caddy
journalctl -u caddy -f                  # proxy + ACME log
tail -f /var/log/caddy/t3.pigeontech.cn.log
```

## Why `runtime/` exists

The server bundle inlines nearly every dependency. Only the packages that are
genuinely loaded from disk stay external — `@cursor/sdk`, `node-pty`,
`@ff-labs/fff-node`, `@napi-rs/keyring` and their native closures
(`scripts/lib/cli-external-packages.ts` is the source of truth).

`runtime/package.json` + `runtime/pnpm-workspace.yaml` describe exactly that
closure, and the deploy script installs it **on the Linux host** rather than
staging it here. That is deliberate: `pnpm install` on Windows resolves
`node-pty`'s win32 prebuilds (conpty.dll, OpenConsole.exe), which are useless on
the target. The host install is what produces the Linux bindings.

Two patches are load-bearing and are copied from `patches/` at deploy time:

- `@ff-labs/fff-node` — upstream publishes an ESM-only exports map, but the
  server loads it through `createRequire` because it dlopens a native addon from
  the real filesystem. Without the added `require` condition the process dies at
  startup with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- `node-pty` — keeps the host's `WATCH_REPORT_DEPENDENCIES` out of the conpty
  worker's IPC channel. Windows-only paths, but the patch must apply so the
  install matches the monorepo.

If a future dependency starts failing with `ERR_MODULE_NOT_FOUND` or
`ERR_PACKAGE_PATH_NOT_EXPORTED` at startup, the fix is usually to add it (and
its closure) to `runtime/package.json`, not to change the bundle.

## Providers

Installed globally with npm, so the binaries land in `/opt/node24/bin` — already
on the service's `PATH`. Verified by executing them from the server process's own
environment, which is how T3 probes them:

| Provider    | Package                     | Version |
| ----------- | --------------------------- | ------- |
| Codex       | `@openai/codex`             | 0.160.0 |
| Claude Code | `@anthropic-ai/claude-code` | 2.1.289 |
| OpenCode    | `opencode-ai` (1.x)         | 1.18.34 |

Sign in on the host, then **Refresh provider status** in the app:

```bash
ssh -t pigeoncore 'codex login'          # or: codex login --device-auth
ssh -t pigeoncore 'claude auth login'
ssh -t pigeoncore 'opencode auth login'
```

OpenCode is pinned to **1.x** on purpose: the docs warn that 1.x and 2.x must not
share a machine, and 1.x is what the local machine runs. To move to 2.x later:

```bash
ssh pigeoncore '/opt/node24/bin/npm install -g @opencode/cli'
```

Not installed, and why:

- **Cursor** — `cursor-agent` exists on npm but is an unrelated package that
  installs no such binary; the real CLI comes from `https://cursor.com/install`.
- **Grok Build** — official installer only, at `https://x.ai/cli`.
- **Pi** — official installer only, at `https://pi.dev`.
- **Antigravity** — no CLI to install; T3 manages its runtime through the
  provider settings UI.

## Memory

`apps/memory` is the unified memory service: one store of durable facts,
preferences, and decisions that every agent in the workbench reads and writes in
the same shape. Its interface, data model, and retrieval rules are in
[apps/memory/README.md](../../apps/memory/README.md).

```powershell
# Build, ship, swap, restart, probe /health, roll back on failure.
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/pigeoncore/deploy-memory.ps1
```

The deploy never touches `/opt/t3-memory/home`: the store outlives a deploy, and
the remote half swaps `dist/` atomically with the previous bundle kept as
`dist.old`.

Point the workbench at it (a systemd drop-in, so `t3code.service` keeps matching
`harden-unit.sh`). `deploy-memory.ps1` uploads the enabler alongside the install
scripts, but wipes `/tmp/t3-memory-install` on every run, so re-run the deploy
before relying on these paths after a reboot:

```bash
ssh pigeoncore 'bash /tmp/t3-memory-install/enable-in-t3code.sh'          # enable
ssh pigeoncore 'bash /tmp/t3-memory-install/enable-in-t3code.sh --disable' # remove
```

Both halves restart the workbench. `deploy-memory.ps1` takes the same `-SshHost`,
`-SkipBuild` and `-SkipVerify` as the main deploy.

That writes `Environment=T3CODE_MEMORY_URL=…` and
`T3CODE_MEMORY_TOKEN_FILE=/opt/t3-memory/token` and restarts the workbench. With
either variable absent, T3 Code registers no memory tools and injects no memory
block, so disabling is one file and one restart.

Operate:

```bash
systemctl status t3-memory
journalctl -u t3-memory -f
curl -s http://127.0.0.1:3211/health      # counts and paths, no content
ssh pigeoncore '/opt/node24/bin/node /opt/t3-memory/dist/bin.mjs health'
ssh pigeoncore '/opt/node24/bin/node /opt/t3-memory/dist/bin.mjs search 部署 --project <id>'
```

The service binds wildcard, but the unit's cgroup filter admits loopback and
the tailnet only (`IPAddressDeny=any` with `IPAddressAllow=localhost,
100.64.0.0/10`): the workbench reaches it on `127.0.0.1:3211`, an agent CLI on
any tailnet device reaches `http://100.121.96.26:3211/mcp`, and the public
interface never completes a handshake. There is still no Caddy site block, and
the bearer token still gates every authenticated route behind that — WireGuard
protects the path, not the store. Adding a hosted embedding or extraction
endpoint means adding it to the allow list too.

Attach a tailnet machine (this repo must be checked out where you run it):

```powershell
scp pigeoncore:/opt/t3-memory/token $env:USERPROFILE\.t3-memory\token
setx T3_MEMORY_TOKEN (Get-Content $env:USERPROFILE\.t3-memory\token -Raw).Trim()
node deploy/pigeoncore\attach\attach-local-clis.mjs
```

The script is additive and idempotent: it writes a `t3-memory` entry into each
CLI's own config (env-interpolated token where the CLI supports it, an inline
header for Claude Code) and leaves that CLI's built-in servers and skills
untouched. Re-run it after token rotation; `--url` points it at another host.

## Deliberately not done

- **T3 Connect is off.** The build runs without the Clerk keys from
  `.env.example`, so the server is reachable only through this domain. Copy
  `.env.example` to `.env` and rebuild if you want the hosted relay.
- **`resource-monitor` is absent.** It is the Rust helper for resource
  telemetry; the server degrades without it. Build it with
  `cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml`
  on the host and drop the binary in `/opt/t3/dist/resource-monitor/`.
- **The apex and other `*.pigeontech.cn` names** resolve here but have no site
  block, so they fail the TLS handshake. The old OpenChamber names
  (`openchamber.`, `oc.`, `office.`) are unused; their previous Caddy config is
  preserved at `/etc/caddy/Caddyfile.bak-*` and in the 2026-10-04 snapshot.

## Security notes

The server runs as **root** so agents get unrestricted filesystem access, which
is the point of a workbench but means anything reaching it has root on this box.
Access is gated by the pairing/token flow; keep tokens out of logs and
screenshots, and revoke sessions you no longer use.

The backups widen that surface. Each archive carries `userdata/secrets/`, so it
holds provider signing keys, and `backup.ps1` copies it to
`%USERPROFILE%\t3-backups` as plaintext with no ACL beyond your account — 14
generations deep, on a machine that also has the host's SSH key. Treat that
directory as secret material: do not sync it, back it up to a third party, or
add it to any archive you share. The memory bearer token is deliberately in none
of them; `/opt/t3-memory/token` is created once and must be copied by hand.
