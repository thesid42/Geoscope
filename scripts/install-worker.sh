#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'Install the worker only on a Linux VM.' >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo 'Run this host installer with sudo.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required; install python3 and python3-venv first.' >&2; exit 1; }
python3 -m venv --help >/dev/null 2>&1 || { echo 'Python virtualenv support is missing; on Debian/Ubuntu install python3-venv, then rerun.' >&2; exit 1; }
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
id parkscope >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/parkscope-worker --shell /usr/sbin/nologin parkscope
getent group docker >/dev/null || { echo 'Docker is not installed; install Docker Engine first.' >&2; exit 1; }
usermod -aG docker parkscope
install -d -o root -g parkscope -m 0750 /opt/parkscope
install -d -o parkscope -g parkscope -m 0700 /var/lib/parkscope-worker/tmp
cp -a "$repo/app" "$repo/requirements.txt" "$repo/Dockerfile.sandbox" /opt/parkscope/
install -d -o root -g parkscope -m 0750 /opt/parkscope/scripts/NetBird
install -o root -g parkscope -m 0640 "$repo/scripts/deployment-demo.py" /opt/parkscope/scripts/
install -o root -g parkscope -m 0750 "$repo/scripts/NetBird/preflight.sh" /opt/parkscope/scripts/NetBird/
chown -R root:parkscope /opt/parkscope
chmod -R u=rwX,g=rX,o= /opt/parkscope
python3 -m venv /opt/parkscope/venv
/opt/parkscope/venv/bin/pip install --requirement /opt/parkscope/requirements.txt
docker build --file /opt/parkscope/Dockerfile.sandbox --tag parkscope-sandbox:local /opt/parkscope
install -d -o root -g parkscope -m 0750 /etc/parkscope
if [[ ! -e /etc/parkscope/worker.env ]]; then
  install -o root -g parkscope -m 0640 "$repo/deploy/worker.env.example" /etc/parkscope/worker.env
  echo 'Edit /etc/parkscope/worker.env with the real shared token and NetBird address, then rerun this installer.'
  exit 0
fi
chown root:parkscope /etc/parkscope/worker.env
chmod 0640 /etc/parkscope/worker.env
install -m 0644 "$repo/deploy/parkscope-worker.service" /etc/systemd/system/parkscope-worker.service
systemctl daemon-reload
systemctl enable parkscope-worker
systemctl restart parkscope-worker
echo 'Worker installed. Review systemctl status parkscope-worker; load /etc/parkscope/worker.env and run bash /opt/parkscope/scripts/NetBird/preflight.sh as parkscope.'
