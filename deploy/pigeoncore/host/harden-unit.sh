#!/usr/bin/env bash
# Harden the t3code systemd unit.
#
# Three things this fixes, each measured on the live host:
#
#  1. Restart=on-failure left a hole: a clean exit(0) never restarted. The
#     observed 130 on every stop is deliberate (Effect maps interruption-only
#     causes to 130 in .repos/effect-smol/packages/effect/src/Runtime.ts), so
#     SIGTERM was covered but a clean exit was not.
#
#  2. The default start limit was unreachable, which is worse than it sounds.
#     systemd's limiter is a fixed window anchored on the first attempt; with
#     RestartSec=5 at most two or three attempts fit in the stock 10s/5 window,
#     so StartLimitBurst=5 never fired and a permanent fault looped forever. Seen
#     on 2026-10-04: three ERR_PACKAGE_PATH_NOT_EXPORTED crash-restarts ~7s
#     apart, with no `failed` state for an operator to notice.
#
#  3. Nothing bounded the cgroup. Measured budgets on a 7.9 GB box: process
#     VmHWM 434 MB, V8 heap ceiling 2240 MB, and a 446 MB provider-install burst
#     (tools/qwen-code 144M + tools/deepseek-harness 302M) charged to this same
#     cgroup. 3G soft / 4G hard sits above all of that and below the point where
#     the kernel starts choosing victims among caddy, xray and tailscaled.
set -uo pipefail

UNIT=/etc/systemd/system/t3code.service
BAK=$UNIT.bak-$(date +%Y%m%d-%H%M%S)

echo "=== current ==="
systemctl show t3code -p Restart -p StartLimitBurst -p StartLimitIntervalUSec -p MemoryHigh \
  -p MemoryMax -p MemorySwapMax -p CPUWeight -p IOWeight -p TasksMax -p OOMPolicy

cp -a "$UNIT" "$BAK"
echo "=== backup -> $BAK ==="

cat > "$UNIT" <<'EOF'
[Unit]
Description=T3 Code workbench server (pigeoncore)
Documentation=https://github.com/Scartiris/t3code
After=network-online.target
Wants=network-online.target
# Reachable on purpose; see deploy/pigeoncore/host/harden-unit.sh for why the
# stock 10s/5 window is not.
StartLimitIntervalSec=300
StartLimitBurst=12

[Service]
Type=simple
WorkingDirectory=/opt/t3
Environment=T3CODE_HOME=/opt/t3/home
Environment=T3CODE_ACP_REGISTRY_URL=https://t3.pigeontech.cn/acp-registry.json
Environment=NODE_ENV=production
Environment=PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/node24/bin/node /opt/t3/dist/bin.mjs serve --host 127.0.0.1 --port 3773 --no-browser
Restart=always
RestartSec=5
# Contain agent builds and provider installs. See this script's header for the
# measured numbers these limits are sized against.
MemoryHigh=3G
MemoryMax=4G
MemorySwapMax=2G
CPUWeight=50
IOWeight=50
TasksMax=2048
# An OOM kill should read as a failed unit, not a silent stop.
OOMPolicy=stop
SyslogIdentifier=t3code

[Install]
WantedBy=multi-user.target
EOF

echo "=== verify ==="
systemd-analyze verify "$UNIT" 2>&1 | grep -v '^$' || echo "  (no findings)"

echo "=== daemon-reload (the unit is not restarted here) ==="
systemctl daemon-reload
systemctl show t3code -p Restart -p StartLimitBurst -p StartLimitIntervalUSec -p MemoryHigh \
  -p MemoryMax -p MemorySwapMax -p CPUWeight -p IOWeight -p TasksMax -p OOMPolicy
echo "=== service untouched ==="
systemctl is-active t3code
