# Geoscope: two-VM deploy

Use **two** Ubuntu 24.04 VMs in the same region, on the same Vultr VPC. Do not put frontend and worker on one instance.

SSH with each VM’s **public** IP. Run each block only on the machine named above it.

There is no separate frontend process. The controller Docker build compiles React; FastAPI serves it; nginx is the public HTTP reverse proxy.

No domain is required. Open `http://149.28.204.217` (HTTP, not HTTPS). Let’s Encrypt will not issue a certificate for a raw IP.

```
Internet → nginx :80 → FastAPI :8000 (controller)
                             │
                             └── VPC → worker :8100
```

## Your addresses

Confirmed from the worker (`enp8s0` / `10.12.96.3`). Controller public/VPC values are what you recorded — re-check with `ip -br -4 addr` on the controller if anything fails.

| Name | Value | Use |
| --- | --- | --- |
| `YOUR_LAPTOP_IP` | `12.94.170.82` | Worker SSH allow. Re-run `curl -4 ifconfig.me` if you change networks or VPN. |
| Controller public | `149.28.204.217` | Browser and Caddy. SSH to the controller. |
| Controller VPC | `10.12.96.4` | UFW `from` address on the worker. |
| Worker VPC | `10.12.96.3` | `WORKER_BIND_IP` and `WORKER_URL`. |
| Worker public | `140.82.51.227` | SSH to the worker only. Never put this in `WORKER_URL`. |
| Worker VPC NIC | `enp8s0` | UFW `in on` interface. |

Do **not** put `WORKER_TOKEN` or `APP_ACCESS_TOKEN` in this file. Generate each with `openssl rand -hex 32`. They must be **different**. `APP_ACCESS_TOKEN` must be at least 32 bytes — a word like `randomstring` will disable guest analysis.

Also need a [Vultr Serverless Inference](https://docs.vultr.com/products/compute/serverless-inference/management/connection) key and an exact model id from `GET https://api.vultrinference.com/v1/models`.

---

## 1. Create two VMs

Cloud Compute → **High Performance** → **2 vCPU / 4 GB** → Ubuntu 24.04 → same region → your SSH key.

| VM | Public firewall |
| --- | --- |
| `geoscope-controller` (`149.28.204.217`) | 22 from your laptop; **80** from everyone. 443 is unused without a domain. |
| `geoscope-worker` (`140.82.51.227`) | 22 from your laptop only |

1. [Create a VPC](https://docs.vultr.com/products/network/vpc-networks/provisioning) in that region.
2. Attach it to **both** instances.
3. Never open port **8100**, **8000**, or **5173**.

If a VPC IP is missing, configure the extra NIC ([Vultr adapter docs](https://docs.vultr.com/how-to-configure-networking-on-vultr-cloud-servers)), then run `ip -br -4 addr` again.

Skip DNS. Bookmark `http://149.28.204.217`. Do not type `https://`.

---

## 2. Worker first

SSH: `ssh root@140.82.51.227`

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/thesid42/Geoscope.git "$HOME/Geoscope"
cd "$HOME/Geoscope"
sudo bash scripts/prepare-vultr.sh worker
```

Confirm gVisor:

```bash
docker info --format '{{json .Runtimes}}'
sudo docker run --rm --runtime=runsc hello-world
```

`runsc` must appear. A normal `runc` test is not enough.

### Firewall on the worker

Keep the Vultr web console open before `ufw enable`.

```bash
sudo ufw allow from 12.94.170.82 to any port 22 proto tcp
sudo ufw insert 1 allow in on enp8s0 from 10.12.96.4 to 10.12.96.3 port 8100 proto tcp
sudo ufw insert 2 deny in to any port 8100 proto tcp
sudo ufw enable
sudo ufw status numbered
```

### Worker service

```bash
cd "$HOME/Geoscope"
openssl rand -hex 32
sudo bash scripts/install-worker.sh
sudo nano /etc/parkscope/worker.env
```

Exactly four lines. No `]`, quotes, or spaces around `=`. Paste the openssl value only into `WORKER_TOKEN` on the server.

```dotenv
WORKER_TOKEN=
SANDBOX_IMAGE=parkscope-sandbox:local
WORKER_BIND_IP=10.12.96.3
TMPDIR=/var/lib/parkscope-worker/tmp
```

```bash
sudo cat -A /etc/parkscope/worker.env
sudo bash scripts/install-worker.sh
sudo systemctl status parkscope-worker --no-pager
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/worker-preflight.py'
```

Expect **active (running)** and **PASS**.

If the image build fails on DNS:

```bash
getent hosts pypi.org files.pythonhosted.org
sudo env SANDBOX_BUILD_NETWORK=host bash scripts/install-worker.sh
```

If preflight says Docker has no `runsc`:

```bash
sudo runsc install
sudo systemctl restart docker
sudo docker run --rm --runtime=runsc hello-world
sudo systemctl restart parkscope-worker
```

---

## 3. Controller second

SSH: `ssh root@149.28.204.217`

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/thesid42/Geoscope.git "$HOME/Geoscope"
cd "$HOME/Geoscope"
sudo bash scripts/prepare-vultr.sh controller
umask 077
cp -n deploy/controller.env.example deploy/controller.env
openssl rand -hex 32
nano deploy/controller.env
```

```dotenv
VULTR_SERVERLESS_INFERENCE_API_KEY=your-inference-key
VULTR_MODEL_ID=exact-id-from-vultr-models-catalog
WORKER_URL=http://10.12.96.3:8100
WORKER_TOKEN=
APP_ACCESS_TOKEN=
PUBLIC_ANALYSIS_ENABLED=true
PUBLIC_ORIGIN=http://149.28.204.217
APP_DATA_DIR=/data
```

`WORKER_TOKEN` is the same value as on the worker. `APP_ACCESS_TOKEN` is the new openssl string from this machine.

If Caddy is already installed from an earlier attempt, stop it so it does not steal port 80:

```bash
sudo systemctl disable --now caddy
sudo apt-get install -y nginx
```

```bash
sudo cp deploy/nginx-geoscope.conf.example /etc/nginx/sites-available/geoscope
sudo ln -sfn /etc/nginx/sites-available/geoscope /etc/nginx/sites-enabled/geoscope
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
chmod 600 deploy/controller.env
sudo docker compose -f deploy/controller.compose.yaml up --build -d
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

Compose builds React and starts FastAPI on `127.0.0.1:8000`. nginx is the only public entry.

---

## 4. Check

On the **controller**:

```bash
curl -fsS http://149.28.204.217/api/config
curl -fsS http://149.28.204.217/api/worker-status
```

Want `demo_mode: false`, `analysis_enabled: true`, worker `ok: true`. Open [http://149.28.204.217](http://149.28.204.217).

From your laptop, port 8100 on `140.82.51.227` must not connect.

On the **worker** (no jobs running):

```bash
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/deployment-demo.py'
```

Open the site and run the SF clinic scenario. Land data in that fixture is simulated; execution is real.

---

## Daily commands

```bash
# Controller (from ~/Geoscope)
sudo docker compose -f deploy/controller.compose.yaml logs --tail=50 controller
sudo docker compose -f deploy/controller.compose.yaml restart

# Worker
sudo journalctl -u parkscope-worker -n 50 --no-pager
sudo systemctl restart parkscope-worker
```

---

## Not this path

- One VM for both roles is unsupported (the API container cannot use `127.0.0.1` to reach the worker, and loopback bind is rejected).
- Laptop mock: `python -m verification.scenario_demo_server --port 8765`
- A domain later: set nginx `server_name` to the hostname, add TLS if you want, set `PUBLIC_ORIGIN=https://your-domain.com`, and reload nginx plus the controller container.

More recovery notes: [VULTR_SETUP.md](VULTR_SETUP.md), [VULTR_ADVANCED.md](VULTR_ADVANCED.md).
