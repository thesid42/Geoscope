#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'Install the worker only on a Linux VM.' >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo 'Run this host installer with sudo.' >&2; exit 1; }
# Build networking applies only to the trusted image installation, never analysis jobs.
build_network="${SANDBOX_BUILD_NETWORK:-default}"
case "$build_network" in
  default|host) ;;
  *) echo 'SANDBOX_BUILD_NETWORK must be default or host.' >&2; exit 2 ;;
esac
command -v python3 >/dev/null || { echo 'Python 3 is required; install python3 and python3-venv first.' >&2; exit 1; }
python3 -m venv --help >/dev/null 2>&1 || { echo 'Python virtualenv support is missing; on Debian/Ubuntu install python3-venv, then rerun.' >&2; exit 1; }
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
id parkscope >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/parkscope-worker --shell /usr/sbin/nologin parkscope
getent group docker >/dev/null || { echo 'Docker is not installed; install Docker Engine first.' >&2; exit 1; }
usermod -aG docker parkscope
install -d -o root -g parkscope -m 0750 /opt/parkscope
install -d -o parkscope -g parkscope -m 0700 /var/lib/parkscope-worker/tmp
cp -a "$repo/app" "$repo/requirements.txt" "$repo/Dockerfile.sandbox" /opt/parkscope/
install -d -o root -g parkscope -m 0750 /opt/parkscope/scripts
install -o root -g parkscope -m 0640 "$repo/scripts/deployment-demo.py" /opt/parkscope/scripts/
install -o root -g parkscope -m 0750 "$repo/scripts/worker-preflight.py" /opt/parkscope/scripts/
chown -R root:parkscope /opt/parkscope
chmod -R u=rwX,g=rX,o= /opt/parkscope
python3 -m venv /opt/parkscope/venv
/opt/parkscope/venv/bin/pip install --requirement /opt/parkscope/requirements.txt
if ! docker build --network "$build_network" --file /opt/parkscope/Dockerfile.sandbox --tag parkscope-sandbox:local /opt/parkscope; then
  echo 'Sandbox image build failed; worker installation stopped.' >&2
  echo 'If pip reported name resolution errors, check host DNS: getent hosts pypi.org files.pythonhosted.org' >&2
  echo 'If host DNS works, retry from the repository: sudo env SANDBOX_BUILD_NETWORK=host bash scripts/install-worker.sh' >&2
  exit 1
fi
install -d -o root -g parkscope -m 0750 /etc/parkscope
if [[ ! -e /etc/parkscope/worker.env ]]; then
  install -o root -g parkscope -m 0640 "$repo/deploy/worker.env.example" /etc/parkscope/worker.env
  echo 'Edit /etc/parkscope/worker.env with the real shared token and private WORKER_BIND_IP, then rerun this installer.'
  exit 0
fi
chown root:parkscope /etc/parkscope/worker.env
chmod 0640 /etc/parkscope/worker.env
install -m 0644 "$repo/deploy/parkscope-worker.service" /etc/systemd/system/parkscope-worker.service
systemctl daemon-reload
systemctl enable parkscope-worker
systemctl restart parkscope-worker
echo 'Worker installed. Review systemctl status parkscope-worker; load /etc/parkscope/worker.env and run /opt/parkscope/venv/bin/python /opt/parkscope/scripts/worker-preflight.py as parkscope.'
