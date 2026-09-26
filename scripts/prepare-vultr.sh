#!/usr/bin/env bash
# Prepare a fresh dedicated Ubuntu VM; application configuration stays separate.
set -euo pipefail
usage() { echo 'Usage: sudo bash scripts/prepare-vultr.sh controller|worker'; }
if [[ ${1:-} == --help ]]; then usage; exit 0; fi
[[ $# -eq 1 && ( $1 == controller || $1 == worker ) ]] || { usage >&2; exit 2; }
role=$1
[[ $EUID -eq 0 ]] || { echo 'Run this installer with sudo.' >&2; exit 1; }
[[ -r /etc/os-release ]] || { echo 'Ubuntu 24.04 is required.' >&2; exit 1; }
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || { echo 'This helper supports Ubuntu 24.04 only. Use the advanced guide for other hosts.' >&2; exit 1; }
[[ $(dpkg --print-architecture) == amd64 ]] || { echo 'Use an x86_64 / amd64 VM for this setup.' >&2; exit 1; }
# Restarting Docker must not interrupt an existing deployment, even stopped containers.
if command -v docker >/dev/null 2>&1; then
  existing=$(docker ps -aq) || { echo 'Existing Docker is inaccessible; repair it before preparing this host.' >&2; exit 1; }
  [[ -z $existing ]] || { echo 'This helper is for fresh VMs. Existing containers found; use the advanced guide.' >&2; exit 1; }
fi
trap 'echo "Preparation stopped at line $LINENO. Fix the reported error before continuing." >&2' ERR
umask 022
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg git python3 python3-venv openssl nano apt-transport-https

# Docker: official Ubuntu repository.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# NetBird: host CLI only; enrollment happens in the next guide step.
curl -fsSL https://pkgs.netbird.io/debian/public.key \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/netbird-archive-keyring.gpg
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/netbird-archive-keyring.gpg] https://pkgs.netbird.io/debian stable main' \
  > /etc/apt/sources.list.d/netbird.list
apt-get update
apt-get install -y netbird
systemctl enable --now netbird

if [[ $role == worker ]]; then
  # gVisor includes the supporting runtime binaries through its apt package.
  curl -fsSL https://gvisor.dev/archive.key \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main' \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update
  apt-get install -y runsc
  if ! docker info --format '{{json .Runtimes}}' | python3 -c 'import json,sys; sys.exit(0 if "runsc" in json.load(sys.stdin) else 1)'; then
    runsc install
  fi
  systemctl restart docker
  docker run --rm --runtime=runsc hello-world
else
  # Caddy installs as a host service. Its website is configured separately.
  apt-get install -y debian-keyring debian-archive-keyring
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
printf '\n%s host packages are ready. Continue with NetBird enrollment in docs/VULTR_NETBIRD_SETUP.md.\n' "$role"
