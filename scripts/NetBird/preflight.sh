#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || fail 'worker containment requires Linux.'
command -v docker >/dev/null || fail 'Docker CLI is missing.'
docker info >/dev/null 2>&1 || fail 'Docker daemon is not reachable by this service user.'
docker info --format '{{json .Runtimes}}' | python3 -c 'import json,sys; x=json.load(sys.stdin); sys.exit(0 if "runsc" in x else 1)' || fail 'Docker has no runsc runtime; no fallback is permitted.'
image="${SANDBOX_IMAGE:-parkscope-sandbox:local}"
docker image inspect "$image" >/dev/null 2>&1 || fail "required image $image is missing; build it on this Linux worker first."
[[ -n "${WORKER_TOKEN:-}" ]] || fail 'WORKER_TOKEN is empty.'
[[ -n "${NETBIRD_WORKER_IP:-}" ]] || fail 'NETBIRD_WORKER_IP is empty.'
interface="${NETBIRD_INTERFACE:-wt0}"
ip -4 addr show dev "$interface" 2>/dev/null | grep -Fq "$NETBIRD_WORKER_IP" || fail "NetBird address $NETBIRD_WORKER_IP is not assigned to $interface. Set NETBIRD_INTERFACE if your interface uses another name."
printf 'PASS: Linux, Docker, runsc, %s, worker token, and NetBird bind address are ready.\n' "$image"
