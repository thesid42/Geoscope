# Geoscope: simple Vultr setup

**Two servers, six steps.** One server runs the website; the other runs the sandbox jobs. NetBird connects them privately. The preparation script handles package installation.

Use **fresh Ubuntu 24.04 x86_64 VMs**. Commands below run in each server's SSH terminal, not local PowerShell. Already have a deployment, or need troubleshooting? Use the [advanced guide](VULTR_NETBIRD_ADVANCED.md).

## 1. Create two Vultr servers

| Server | Suggested size | Public inbound ports |
| --- | --- | --- |
| `geoscope-controller` — website | 2 vCPU, 4 GB RAM | TCP 22 from your IP; TCP 80/443 from everyone. |
| `geoscope-worker` — sandboxes | 2 vCPU, 4 GB RAM | TCP 22 from your IP only. |

Use the same region and attach your SSH key. Keep normal outbound access enabled. **Do not expose ports 8000, 8100, or 5173.** Apply equivalent firewall restrictions to IPv6 if enabled.

Have these ready:

- A NetBird account and two one-use setup keys, one per server.
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

This installs Docker and NetBird on both servers, Caddy on the controller, and gVisor on the worker. Stop if a command fails. The helper refuses hosts with existing Docker containers; use the advanced guide for updates.

## 3. Connect both servers with NetBird

Run this on **each server**, pasting that server's setup key when asked:

```bash
read -rsp 'NetBird setup key: ' NB_SETUP_KEY
printf '\n'
export NB_SETUP_KEY
sudo --preserve-env=NB_SETUP_KEY netbird up
unset NB_SETUP_KEY
sudo netbird status
```

In the NetBird dashboard:

1. Put only the controller in a group named `geoscope-controller`.
2. Put only the worker in a group named `geoscope-worker`.
3. Add an enabled policy: **controller group → worker group, TCP 8100, unidirectional**.
4. Record the worker's **NetBird IP**. Use it wherever `WORKER_NETBIRD_IP` appears below.

Leave the initial Default policy until the connection check in step 6, then disable broad access. No NetBird API token or policy script is needed for this path.

## 4. Configure the worker

On the **worker**:

```bash
cd "$HOME/Geoscope"
sudo bash scripts/install-worker.sh
openssl rand -hex 32
sudo nano /etc/parkscope/worker.env
```

The first installer run creates the configuration file. Save the generated random string privately as your **shared worker token**. Change only these two lines; keep the other defaults:

```dotenv
WORKER_TOKEN=PASTE_THE_GENERATED_WORKER_TOKEN
NETBIRD_WORKER_IP=WORKER_NETBIRD_IP
```

Start the configured worker and check it:

```bash
sudo bash scripts/install-worker.sh
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; bash /opt/parkscope/scripts/NetBird/preflight.sh'
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
WORKER_URL=http://WORKER_NETBIRD_IP:8100
WORKER_TOKEN=PASTE_THE_SAME_WORKER_TOKEN
APP_ACCESS_TOKEN=PASTE_THE_NEW_RANDOM_STRING
PUBLIC_ANALYSIS_ENABLED=true
PUBLIC_ORIGIN=https://geoscope.example.com
APP_DATA_DIR=/data
```

All secrets stay on the servers. Public mode allows visitors to start paid analysis jobs. For finding the exact model ID, use the [model lookup command](VULTR_NETBIRD_ADVANCED.md#6-configure-inference-and-the-app--controller-vm).

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

Now disable NetBird's **Default / All-to-All** policy and any other broad policy affecting these two groups. Keep your narrow TCP 8100 rule. Repeat the worker-status check; it must still say `ok: true`. Use dedicated groups/account and preserve any policies needed by unrelated services.

On the **worker**, with no analyses running, check sandbox containment:

```bash
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/deployment-demo.py'
```

Require all `PASS` messages. Open your website and run the SF clinic scenario; require a completed run and downloadable results. This uses real cloud execution with **simulated land data**. Health checks alone do not prove an agent run succeeded.

For the hackathon submission, follow the [network denial checks](VULTR_NETBIRD_ADVANCED.md#8-enforce-the-narrow-netbird-policy) and [save live execution evidence](VULTR_NETBIRD_ADVANCED.md#9-verify-real-execution-and-save-evidence). If a check fails, use [troubleshooting](VULTR_NETBIRD_ADVANCED.md#12-troubleshooting); keep the worker private.

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

If an existing host firewall blocks traffic, see the advanced guide's [worker rule](VULTR_NETBIRD_ADVANCED.md#5-install-gvisor-and-the-worker--worker-vm) and [HTTPS setup](VULTR_NETBIRD_ADVANCED.md#7-put-https-in-front--controller-vm). The [full configuration reference](VULTR_NETBIRD_ADVANCED.md#10-configuration-reference) includes updates and optional settings. Cloud deployment is verified only after its live checks pass.
