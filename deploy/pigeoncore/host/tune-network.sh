#!/usr/bin/env bash
# Host network tuning for the pigeoncore workbench.
#
# Why: clients reach this box from China at a measured ~120 ms RTT, and the path
# is congestion-window limited rather than bandwidth limited — a single TCP
# stream moved 1.1 MB/s while eight parallel streams aggregated 5.1 MB/s, against
# a 267 MB/s server uplink. HTTP/2 multiplexes the whole first load over one
# connection, so that single-stream number is what a page load actually gets.
#
# Idempotent. Safe to re-run; intended to be run once on a fresh host, or after
# a kernel change. Nothing here touches the application.
set -uo pipefail

echo "=== before ==="
sysctl -n net.ipv4.tcp_congestion_control net.core.default_qdisc net.ipv4.tcp_slow_start_after_idle \
          net.ipv4.tcp_notsent_lowat net.ipv4.tcp_fastopen net.ipv4.tcp_mtu_probing

# Load BBR now and on every boot.
if ! grep -qx tcp_bbr /proc/sys/net/ipv4/tcp_available_congestion_control; then
  modprobe tcp_bbr && echo "modprobe tcp_bbr: ok" || echo "modprobe tcp_bbr: FAILED"
fi
echo tcp_bbr > /etc/modules-load.d/tcp_bbr.conf

cat > /etc/sysctl.d/99-t3-network.conf <<'EOF'
# pigeoncore T3 Code workbench: long-RTT (China -> Tokyo ~120ms) tuning.
# See deploy/pigeoncore/host/tune-network.sh for the measurements behind this.
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# Bursty HTTP/WebSocket traffic must not re-enter slow start after an idle gap.
net.ipv4.tcp_slow_start_after_idle = 0
# Bounds unsent bytes in the write buffer; keeps multiplexed h2/h3 latency down.
net.ipv4.tcp_notsent_lowat = 131072
# Server-side TFO saves a round trip on every new connection.
net.ipv4.tcp_fastopen = 3
# Recover from PMTU blackholes instead of stalling.
net.ipv4.tcp_mtu_probing = 1

net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 131072 33554432
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_max_syn_backlog = 1024
EOF
sysctl -p /etc/sysctl.d/99-t3-network.conf

# ens3 keeps whatever qdisc it was created with, so set it explicitly. `replace`
# swaps in place and does not tear the interface down.
tc qdisc replace dev ens3 root fq && echo "tc qdisc replace ens3 fq: ok"

echo "=== after ==="
sysctl -n net.ipv4.tcp_congestion_control net.core.default_qdisc net.ipv4.tcp_slow_start_after_idle \
          net.ipv4.tcp_notsent_lowat net.ipv4.tcp_fastopen net.ipv4.tcp_mtu_probing
tc qdisc show dev ens3 | head -1
cat /proc/sys/net/ipv4/tcp_available_congestion_control
