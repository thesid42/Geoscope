# Geoscope: simple Vultr setup

**Two servers, six steps.** One server runs the website; the other runs the sandbox jobs. A Vultr VPC connects them privately. The preparation script handles package installation.

Use **fresh Ubuntu 24.04 x86_64 VMs**. Commands below run in each server's SSH terminal, not local PowerShell. Already started the previous setup? Use the [migration steps](VULTR_ADVANCED.md#migrate-an-existing-worker) and keep your existing tokens. Need troubleshooting? Use the [advanced guide](VULTR_ADVANCED.md).

## 1. Create two Vultr servers

| Server | Suggested size | Public inbound ports |
| --- | --- | --- |
| `geoscope-controller` — website | 2 vCPU, 4 GB RAM | TCP 22 from your IP; TCP 80/443 from everyone. |
| `geoscope-worker` — sandboxes | 2 vCPU, 4 GB RAM | TCP 22 from your IP only. |

Use the same region, attach your SSH key, and connect both VMs to the same dedicated **Vultr VPC**. In Vultr, open **Network → VPC Networks → Add VPC Network**, choose the region, then attach the network to both instances. See [Vultr VPC setup](https://docs.vultr.com/products/network/vpc-networks/provisioning). Keep normal outbound access enabled. **Do not expose ports 8000, 8100, or 5173.** Apply equivalent firewall restrictions to IPv6 if enabled.

Have these ready:

- A **Vultr Serverless Inference** key and an available chat/code model ID.
- A domain such as `geoscope.example.com`, with its DNS A record pointing to the **controller's public IP**. Remove any incorrect AAAA record.

## 2. Prepare each server

SSH to the controller. Run:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/thesid42/Geoscope.git "$HOME/Geoscope"
cd "$HOME/Geoscope"
sudo bash scripts/prepare-vultr.sh controller
```

SSH to the worker. Run:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/thesid42/Geoscope.git "$HOME/Geoscope"
cd "$HOME/Geoscope"
sudo bash scripts/prepare-vultr.sh worker
```

This installs Docker on both servers, Caddy on the controller, and gVisor on the worker. Stop if a command fails. The helper refuses hosts with existing Docker containers; use the advanced guide for updates.

## 3. Allow the private connection

Record the **controller VPC IP** and **worker VPC IP** from Vultr. On the worker, run `ip -br -4 addr` to find the interface with its VPC IP. If you attached the VPC after creating the VM, follow [Vultr's adapter configuration](https://docs.vultr.com/how-to-configure-networking-on-vultr-cloud-servers) until the address appears.

On the **worker**, replace the uppercase placeholders below. Allow your SSH address before enabling the host firewall; keep the Vultr console available:

```bash
sudo ufw allow from YOUR_ADMIN_PUBLIC_IP to any port 22 proto tcp
sudo ufw insert 1 allow in on VPC_INTERFACE from CONTROLLER_VPC_IP to WORKER_VPC_IP port 8100 proto tcp
sudo ufw insert 2 deny in to any port 8100 proto tcp
sudo ufw enable
sudo ufw status numbered
```

This allows TCP 8100 only from the controller over the VPC interface. The worker also requires a shared token. Use the host firewall for this private traffic, alongside the Vultr firewall for public access. This setup uses HTTP inside the dedicated VPC; it does not add transport encryption between the VMs.

## 4. Configure the worker

On the **worker**:

```bash
cd "$HOME/Geoscope"
sudo bash scripts/install-worker.sh
openssl rand -hex 32
sudo nano /etc/parkscope/worker.env
```

If the image build reports `Temporary failure in name resolution`, use the [build DNS recovery commands](VULTR_ADVANCED.md#docker-build-cannot-resolve-pypi).

The first installer run creates the configuration file. Save the generated random string privately as your **shared worker token**. Change only these two lines; keep the other defaults:

```dotenv
WORKER_TOKEN=PASTE_THE_GENERATED_WORKER_TOKEN
WORKER_BIND_IP=WORKER_VPC_IP
```

Start the configured worker and check it:

```bash
sudo bash scripts/install-worker.sh
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/worker-preflight.py'
```

Expect `PASS`. The existing `parkscope` paths/service names are intentional.

## 5. Configure the website

On the **controller**:

```bash
cd "$HOME/Geoscope"
umask 077
cp -n deploy/controller.env.example deploy/controller.env
openssl rand -hex 32
nano deploy/controller.env
```

Use this new random string for `APP_ACCESS_TOKEN`. Fill the file as follows, replacing the sample hostname and every placeholder:

```dotenv
VULTR_SERVERLESS_INFERENCE_API_KEY=YOUR_INFERENCE_KEY
VULTR_MODEL_ID=YOUR_AVAILABLE_MODEL_ID
WORKER_URL=http://WORKER_VPC_IP:8100
WORKER_TOKEN=PASTE_THE_SAME_WORKER_TOKEN
APP_ACCESS_TOKEN=PASTE_THE_NEW_RANDOM_STRING
PUBLIC_ANALYSIS_ENABLED=true
PUBLIC_ORIGIN=https://geoscope.example.com
APP_DATA_DIR=/data
```

All secrets stay on the servers. Public mode allows visitors to start paid analysis jobs. For finding the exact model ID, use the [model lookup command](VULTR_ADVANCED.md#model-id-lookup).

Set up HTTPS:

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the default site with this, using the **same hostname** as `PUBLIC_ORIGIN`:

```caddyfile
geoscope.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8000
}
```

Start everything:

```bash
chmod 600 deploy/controller.env
sudo docker compose -f deploy/controller.compose.yaml up --build -d
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

React is built and served automatically by FastAPI. There is no separate frontend server to start.

## 6. Check the deployment

On the **controller**, replace the hostname and run:

```bash
curl -fsS https://geoscope.example.com/api/config
curl -fsS https://geoscope.example.com/api/worker-status
```

Expect `demo_mode: false`, `analysis_enabled: true`, and worker `ok: true`. The worker-status request checks the connection from inside the app container.

From a machine outside the VPC, TCP 8100 on the worker's public IP must not connect. The controller must still reach the worker over its private address.

On the **worker**, with no analyses running, check sandbox containment:

```bash
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/deployment-demo.py'
```

Require all `PASS` messages. Open your website and run the SF clinic scenario; require a completed run and downloadable results. This uses real cloud execution with **simulated land data**. Health checks alone do not prove an agent run succeeded.

For the hackathon submission, follow the [network denial checks](VULTR_ADVANCED.md#network-checks) and [save live execution evidence](VULTR_ADVANCED.md#live-execution-evidence). If a check fails, use [troubleshooting](VULTR_ADVANCED.md#troubleshooting); keep the worker private.

## Useful commands

```bash
# Controller: logs / stop / start (from ~/Geoscope)
sudo docker compose -f deploy/controller.compose.yaml logs --tail=50 controller
sudo docker compose -f deploy/controller.compose.yaml stop
sudo docker compose -f deploy/controller.compose.yaml start

# Worker: logs / stop / start
sudo journalctl -u parkscope-worker -n 50 --no-pager
sudo systemctl stop parkscope-worker
sudo systemctl start parkscope-worker
```

If an existing controller host firewall blocks HTTPS, allow `80/tcp` and `443/tcp` there. The [advanced reference](VULTR_ADVANCED.md) includes configuration, updates, troubleshooting, and migration from the previous setup. Cloud deployment is verified only after its live checks pass.
