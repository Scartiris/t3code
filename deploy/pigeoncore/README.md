# pigeoncore workbench deployment

This fork is deployed as a self-hosted T3 Code server on the `pigeoncore` VPS and
served at **https://t3.pigeontech.cn**.

## Shape

```
browser ──https──> Caddy (45.92.159.178:443, Let's Encrypt)
                     │  reverse_proxy, WebSocket upgrade passed through
                     ▼
                   t3code.service (systemd)
                     node /opt/t3/dist/bin.mjs serve --host 127.0.0.1 --port 3773
                     T3CODE_HOME=/opt/t3/home
```

| Piece   | Where                                                                 |
| ------- | --------------------------------------------------------------------- |
| Host    | `pigeoncore` (45.92.159.178), Ubuntu 26.04, 4 vCPU / 7.8 GB           |
| App     | `/opt/t3` — `dist/` (bundle + `client/`), `node_modules/`, `patches/` |
| State   | `/opt/t3/home` (`T3CODE_HOME`); runtime data under `home/userdata`    |
| Service | `t3code.service`, `WantedBy=multi-user.target`                        |
| Proxy   | `caddy.service`, site block for `t3.pigeontech.cn`                    |
| Node    | `/opt/node24` (v24.21.0), linked into `/usr/local/bin`                |
| DNS     | wildcard `*.pigeontech.cn → 45.92.159.178`; no per-host record needed |

The server binds to loopback only. Nothing but Caddy is exposed.

## Deploy

From the repository root, on this Windows machine:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/pigeoncore/deploy.ps1
```

It builds (`vp run --filter t3 build`), stages the JavaScript, ships it, installs
the native packages **on the host**, restarts the service and verifies HTTPS.

| Flag               | Effect                                |
| ------------------ | ------------------------------------- |
| `-SkipBuild`       | Reuse the existing `apps/server/dist` |
| `-SkipVerify`      | Skip the post-restart HTTPS probe     |
| `-SshHost <alias>` | Target a different host               |

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
