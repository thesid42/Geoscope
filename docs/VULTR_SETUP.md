# Geoscope: simple Vultr setup

**Two servers, six steps.** One server runs the website; the other runs the sandbox jobs. A Vultr VPC connects them privately. The preparation script handles package installation.

Use **fresh Ubuntu 24.04 x86_64 VMs**. Commands below run in each server's SSH terminal, not local PowerShell. Stopped at Step 4 with the Shapely/DNS build error? **[Resume here](#resume-from-the-step-4-build-error)** using your existing VMs and tokens. Need troubleshooting? Use the [advanced guide](VULTR_ADVANCED.md).

## 1. Create two Vultr servers


| Server                          | Suggested size   | Public inbound ports                           |
| ------------------------------- | ---------------- | ---------------------------------------------- |
| `geoscope-controller` — website | 2 vCPU, 4 GB RAM | TCP 22 from your IP; TCP 80/443 from everyone. |
| `geoscope-worker` — sandboxes   | 2 vCPU, 4 GB RAM | TCP 22 from your IP only.                      |


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

```
sudo ufw allow from YOUR_ADMIN_PUBLIC_IP to any port 22 proto tcp
sudo ufw insert 1 allow in on VPC_INTERFACE from 10.12.96.4 to 10.12.96.3 port 8100 proto tcp
sudo ufw insert 2 deny in to any port 8100 proto tcp
sudo ufw enable
sudo ufw status numbered
```

This allows TCP 8100 only from the controller over the VPC interface. The worker also requires a shared token. Use the host firewall for this private traffic, alongside the Vultr firewall for public access. This setup uses HTTP inside the dedicated VPC; it does not add transport encryption between the VMs.

## 4. Configure the worker

If your previous attempt failed with `Temporary failure in name resolution`, skip the fresh-install commands and use **[Resume from the Step 4 build error](#resume-from-the-step-4-build-error)** below.

For a fresh install, on the **worker**:

```bash
cd "$HOME/Geoscope"
sudo bash scripts/install-worker.sh
openssl rand -hex 32
sudo nano /etc/parkscope/worker.env
```

If the image build reports `Temporary failure in name resolution`, continue with the recovery steps below.

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

### Resume from the Step 4 build error

Your Docker image build failed while d=ownloading packages. Keep the existing VMs and repository; **do not rerun** `prepare-vultr.sh` **or clone again**. Follow this sequence instead:

**A. Update both servers.** SSH to each VM using its **public IP**, then run on each:

```bash
cd "$HOME/Geoscope"
git pull --ff-only
```

**B. Replace the old private connection.** Attach both existing VMs to the same Vultr VPC as described in [Step 1](#1-create-two-vultr-servers). Record their actual VPC IPs, confirm them with `ip -br -4 addr`, and apply the worker firewall rules in [Step 3](#3-allow-the-private-connection). A NetBird IP is not a VPC IP.

Now remove NetBird on **both dedicated Geoscope VMs**, if installed. Keep using public-IP SSH for these commands:

```bash
if command -v netbird >/dev/null 2>&1; then
    sudo netbird down
    sudo systemctl disable --now netbird
    sudo apt-get remove -y netbird
fi
```

**C. Check DNS on the worker.** Run these separately; both should return addresses:

```bash
getent hosts pypi.org
getent hosts files.pythonhosted.org
```

If either fails, stop before rebuilding and inspect `resolvectl status` and `cat /etc/resolv.conf`. The host's DNS needs fixing first; removing NetBird or selecting host-network builds does not guarantee that. If both resolve, continue.

**D. Configure the worker before retrying.** The failed build may not have created its environment file. On the **worker**, create it only if missing:

```bash
cd "$HOME/Geoscope"
sudo install -d -m 0750 /etc/parkscope
if ! sudo test -f /etc/parkscope/worker.env; then
    sudo install -m 0600 deploy/worker.env.example /etc/parkscope/worker.env
fi
```

Keep an existing real `WORKER_TOKEN`. If you have not created one, run `openssl rand -hex 32` in the terminal, save that value privately, and use it below. Then open the file:

```bash
sudo nano /etc/parkscope/worker.env
```

The file should contain:

```dotenv
WORKER_TOKEN=YOUR_SHARED_WORKER_TOKEN
SANDBOX_IMAGE=parkscope-sandbox:local
WORKER_BIND_IP=YOUR_ACTUAL_WORKER_VPC_IP
TMPDIR=/var/lib/parkscope-worker/tmp
```

Remove old `NETBIRD_WORKER_IP` and `NETBIRD_INTERFACE` lines. Use the worker's actual VPC address, not its public address. Save and exit nano with **Ctrl+O, Enter, Ctrl+X**.

**E. Retry the build and start the worker.** Run on the **worker**:

```bash
sudo env SANDBOX_BUILD_NETWORK=host bash scripts/install-worker.sh
sudo systemctl status parkscope-worker --no-pager
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/worker-preflight.py'
```

Stop if the installer fails. Because you created the environment file first, this successful installer run also starts the service. Expect **active (running)** and **PASS**. The host network is used only for building the trusted image; analysis jobs still have no network.

**F. Continue at [Step 5](#5-configure-the-website)** on the controller. Set `WORKER_URL=http://YOUR_ACTUAL_WORKER_VPC_IP:8100` and use the **same worker token**. If you already configured that file, preserve its inference key and app secret. There is no need to repeat Steps 1–4 after finishing this recovery sequence.

## 5. Configure the website

On the **controller**:

```bash
cd "$HOME/Geoscope"
umask 077
cp -n deploy/controller.env.example deploy/controller.env
openssl rand -hex 32
nano deploy/controller.env
```

For a new configuration, use this new random string for `APP_ACCESS_TOKEN`. If resuming with an existing real app secret, keep it. Fill the file as follows, replacing the sample hostname and every placeholder:

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