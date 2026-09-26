# Geoscope: advanced deployment reference

Start with the [short setup guide](VULTR_NETBIRD_SETUP.md). This reference keeps the manual installation steps, configuration details, and deployment evidence checks.

This guide deploys the React frontend and FastAPI controller on one Vultr VM, with code execution on a separate Vultr VM using gVisor. NetBird provides the private connection between them. Agent model calls go through Vultr Serverless Inference.

**Target:** fresh Ubuntu 24.04 LTS x86_64 VMs. Commands after SSH are **Bash on Linux**, not PowerShell. Run each section on the host named in its heading. Replace all example domains, addresses, IDs, and secret placeholders. Official installation references were checked on **2026-09-26**; cloud execution still needs the acceptance checks below.

## 1. Deployment layout and values to collect

```text
Browser -- HTTPS:443 --> Vultr controller VM
                         Caddy --> 127.0.0.1:8000
                         FastAPI + compiled React
                           |-- HTTPS --> Vultr Serverless Inference
                           |
                           +-- NetBird encrypted tunnel, TCP:8100
                                      |
                               Vultr worker VM
                               private FastAPI worker
                                      |
                               disposable gVisor jobs
                               no network; bounded resources
```

| Component | Suggested starting size / role |
| --- | --- |
| `geoscope-controller` | 2 vCPU, 4 GiB RAM; Caddy, Docker Compose, app and frontend build. |
| `geoscope-worker` | 2 vCPU, at least 4 GiB RAM; Docker, gVisor, Python worker. Keep this VM dedicated. |
| NetBird | Managed account for this guide; install a host peer on each VM. |
| Inference | Vultr Serverless Inference subscription and an available chat/code model; no GPU VM required by this architecture. |
| DNS | A domain/subdomain you control, such as `geoscope.example.com`. |

Sizes are starting recommendations, not measured capacity guarantees. The worker allows two jobs at once, each with a 768 MiB memory limit. Its service account has Docker access, which grants effective control of the worker host.

Record these values privately before continuing:

| Value | Where it is used |
| --- | --- |
| Controller and worker public IPs | SSH; only the controller IP goes in website DNS. |
| Controller and worker **NetBird** IPs | Network policy and worker binding; these differ from public/Vultr VPC addresses. |
| Public hostname | DNS, Caddyfile, and `PUBLIC_ORIGIN`. |
| Vultr **Serverless Inference** API key | Controller only; not the general Vultr infrastructure API token. |
| Exact available model ID | Controller `VULTR_MODEL_ID`. |
| One random `WORKER_TOKEN` | Same value on controller and worker. |
| Separate random `APP_ACCESS_TOKEN` | Controller only; browser session signing and private API bearer access. |
| NetBird setup keys | Peer enrollment only; one key per host is convenient. |
| NetBird personal access token | Optional policy helper only; separate from setup keys and app tokens. |

No credentials belong in React, `VITE_*` variables, Git, or an analysis container. Filled-in `.env` files are ignored by this repository.

## 2. Create the VMs, firewall rules, and DNS

In the Vultr Console, create two compute instances in the same region, select Ubuntu 24.04 LTS, and attach your SSH public key. Use the sizes and hostnames above. Select a limited sudo user if desired; use the actual username shown for the instance. See [Vultr instance provisioning](https://docs.vultr.com/products/compute/instances/cloud-compute/provisioning).

Attach a separate Vultr firewall group to each VM, allowing only these public inbound connections:

| Destination | Protocol / port | Source |
| --- | --- | --- |
| Both VMs | TCP 22 | Your administrator public IP `/32` (and approved admin IPv6 `/128` if used). |
| Controller | TCP 80 and 443 | Internet; Caddy uses these for HTTP/HTTPS and certificate issuance. |
| Worker | TCP 8100 | **No public allow rule.** It is reached through NetBird. |
| Controller | TCP 8000, 5173 | **No public allow rules.** Production has no Vite server. |

Keep the Vultr web console and an existing SSH session available while changing firewall rules. Apply equivalent restrictions to IPv6 if enabled. NetBird needs outbound connectivity to its management/signaling/relay services; allow normal outbound traffic for this initial deployment. Relay connectivity is acceptable; diagnose tunnel problems with [NetBird client troubleshooting](https://docs.netbird.io/help/troubleshooting-client). Do not expose worker TCP 8100 publicly to repair a tunnel problem.

Create a DNS **A record** for your hostname pointing to the controller's public IPv4. Add an AAAA record only if that controller's IPv6 and firewall are configured. Avoid a stale AAAA record pointing elsewhere.

Open two local terminals and SSH to the hosts, replacing the sample usernames/IPs:

```bash
# Terminal A: controller
ssh YOUR_SSH_USER@CONTROLLER_PUBLIC_IP
```

```bash
# Terminal B: worker
ssh YOUR_SSH_USER@WORKER_PUBLIC_IP
```

## 3. Install base packages and Docker — BOTH VMs

Use fresh VMs without an existing Docker installation. The following uses Docker's package repository. If the machine already has Docker or containerd installed, first follow the compatibility guidance in [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git python3 python3-venv openssl nano
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version

git clone https://github.com/thesid42/Geoscope.git "$HOME/Geoscope"
cd "$HOME/Geoscope"
git rev-parse HEAD
```

Use the same repository commit on both hosts. If the directory already exists, inspect it and use `git pull --ff-only` instead of cloning over it. Keep using the same SSH user and repository directory so Compose reuses its existing data volume.

## 4. Enroll the hosts — BOTH VMs

Create two short-lived, one-use setup keys in your NetBird account. Install the CLI using the [official NetBird Linux package repository](https://docs.netbird.io/get-started/install/linux):

```bash
curl -fsSL https://pkgs.netbird.io/debian/public.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/netbird-archive-keyring.gpg
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/netbird-archive-keyring.gpg] https://pkgs.netbird.io/debian stable main' \
  | sudo tee /etc/apt/sources.list.d/netbird.list >/dev/null
sudo apt-get update
sudo apt-get install -y netbird
sudo systemctl enable --now netbird

read -rsp 'NetBird setup key for THIS host: ' NB_SETUP_KEY
printf '\n'
export NB_SETUP_KEY
sudo --preserve-env=NB_SETUP_KEY netbird up
unset NB_SETUP_KEY
sudo netbird status -d
ip -4 addr show dev wt0
```

The setup key is supplied through the supported [`NB_SETUP_KEY` environment variable](https://docs.netbird.io/manage/peers/bootstrap-via-config-file), without placing its literal value in shell history. Record each host's assigned IPv4 address. `100.64.0.2` below is only an example; use the worker's actual address. If your interface is not `wt0`, record its name too.

In NetBird, create exactly these groups and assign their peers:

| Group | Members |
| --- | --- |
| `geoscope-controller` | Only the controller VM. |
| `geoscope-worker` | Only the worker VM. |

Create an enabled access policy with source `geoscope-controller`, destination `geoscope-worker`, protocol **TCP**, port **8100**, and **unidirectional** access. Return traffic is handled by connection tracking. Do not add sandbox containers as NetBird peers.

NetBird's initial **Default / All-to-All** policy still permits broad access even after adding this narrow rule. Keep it only during initial connectivity checks, then disable it and any other broad policy covering these peers in section 8. On a shared account, preserve explicit policies required by other services. [NetBird policy behavior](https://docs.netbird.io/manage/access-control/manage-network-access).

### Optional: use the repository policy helper instead of creating the groups/policy manually

Run from `~/Geoscope` on the controller or another trusted Linux admin machine. Skip group creation if you already created the groups in the dashboard; obtain their actual group IDs instead. The helper refuses to reuse existing group names.

```bash
cd "$HOME/Geoscope"
python3 scripts/NetBird/policy.py --create-groups
read -rsp 'NetBird personal access token: ' NETBIRD_API_TOKEN
printf '\n'
export NETBIRD_API_TOKEN
python3 scripts/NetBird/policy.py --create-groups --apply
```

Assign the two peers in the dashboard, then insert the **returned IDs**, not group names:

```bash
CONTROLLER_GROUP_ID='REPLACE_WITH_CONTROLLER_GROUP_ID'
WORKER_GROUP_ID='REPLACE_WITH_WORKER_GROUP_ID'
python3 scripts/NetBird/policy.py \
  --controller-group-id "$CONTROLLER_GROUP_ID" --worker-group-id "$WORKER_GROUP_ID"
python3 scripts/NetBird/policy.py \
  --controller-group-id "$CONTROLLER_GROUP_ID" --worker-group-id "$WORKER_GROUP_ID" --apply
unset NETBIRD_API_TOKEN
```

The first policy call previews the payload; `--apply` creates or verifies the exact narrow policy. It does not disable existing policies. The personal token is not needed by the running app. API details: [NetBird policies](https://docs.netbird.io/api/resources/policies).

## 5. Install gVisor and the worker — WORKER VM

Install gVisor from its [official apt repository](https://gvisor.dev/docs/user_guide/install/). This includes the runtime's supporting binaries.

```bash
sudo apt-get install -y apt-transport-https
curl -fsSL https://gvisor.dev/archive.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n' "$(dpkg --print-architecture)" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
sudo apt-get update
sudo apt-get install -y runsc
sudo systemctl restart docker
sudo docker info --format '{{json .Runtimes}}'
sudo docker run --rm --runtime=runsc hello-world
```

Docker must list `runsc`, and the test must succeed. If the runtime was not registered, use `sudo runsc install`, restart Docker, and repeat the test, as described in the [gVisor Docker quick start](https://gvisor.dev/docs/user_guide/quick_start/docker/). Do not replace the required runtime with `runc`.

Install the worker:

```bash
cd "$HOME/Geoscope"
sudo bash scripts/install-worker.sh
openssl rand -hex 32
sudo nano /etc/parkscope/worker.env
```

On its first run the installer creates the environment template and exits **before starting a service**. Save the generated random value privately as your shared `WORKER_TOKEN`. Fill the file with:

```dotenv
WORKER_TOKEN=REPLACE_WITH_THE_GENERATED_SHARED_TOKEN
SANDBOX_IMAGE=parkscope-sandbox:local
NETBIRD_WORKER_IP=100.64.0.2
TMPDIR=/var/lib/parkscope-worker/tmp
NETBIRD_INTERFACE=wt0
```

Use the actual NetBird IP/interface. These legacy `parkscope` image, directory, and service names match the existing scripts; keep them as shown. Then run the installer again:

```bash
sudo bash scripts/install-worker.sh
sudo systemctl status parkscope-worker --no-pager
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; bash /opt/parkscope/scripts/NetBird/preflight.sh'
sudo ss -lntp 'sport = :8100'
```

Expect a `PASS` from preflight and a listener on **the worker's NetBird IP:8100**, never `0.0.0.0:8100` or its public IP. The environment file is root-owned, group `parkscope`, mode `0640`; only the host worker receives its secret.

If an existing **active UFW firewall** blocks this private listener, add this scoped rule on the worker, substituting both actual addresses/interface. Inspect `sudo ufw status verbose` first:

```bash
sudo ufw allow in on wt0 from CONTROLLER_NETBIRD_IP to WORKER_NETBIRD_IP port 8100 proto tcp
```

This is additional host filtering; NetBird must also allow the connection. Do not enable a new host firewall without first allowing your administration connection.

## 6. Configure inference and the app — CONTROLLER VM

In the Vultr Serverless Inference subscription, obtain its inference API key. Discover model IDs from the account's catalog; do not copy an assumed model name from an old tutorial. The application's endpoints are `/v1/models` and `/v1/chat/completions`. Vultr documents model listing in its [Serverless Inference API example](https://docs.vultr.com/products/compute/serverless-inference/vector-store/rag-chat-collection).

```bash
read -rsp 'Vultr Serverless Inference API key: ' VULTR_SERVERLESS_INFERENCE_API_KEY
printf '\n'
export VULTR_SERVERLESS_INFERENCE_API_KEY
python3 - <<'PY'
import json, os, urllib.request
req = urllib.request.Request(
    'https://api.vultrinference.com/v1/models',
    headers={'Authorization': 'Bearer ' + os.environ['VULTR_SERVERLESS_INFERENCE_API_KEY']},
)
with urllib.request.urlopen(req, timeout=30) as response:
    payload = json.load(response)
for model in payload.get('data', []):
    print(model['id'])
PY
unset VULTR_SERVERLESS_INFERENCE_API_KEY
```

Select an available text/chat model capable of producing Python code. The live scenario acceptance test below determines whether it works with this app's requests; membership in the catalog alone does not establish that.

Create the app configuration:

```bash
cd "$HOME/Geoscope"
umask 077
# First deployment only; do not overwrite an existing configured file.
cp -n deploy/controller.env.example deploy/controller.env
chmod 600 deploy/controller.env
openssl rand -hex 32
nano deploy/controller.env
```

Use this **new** random value for `APP_ACCESS_TOKEN`; copy the shared worker token from section 5. Complete configuration:

```dotenv
VULTR_SERVERLESS_INFERENCE_API_KEY=REPLACE_WITH_INFERENCE_KEY
VULTR_MODEL_ID=REPLACE_WITH_AN_EXACT_AVAILABLE_MODEL_ID
WORKER_URL=http://100.64.0.2:8100
WORKER_TOKEN=REPLACE_WITH_THE_SAME_WORKER_TOKEN
APP_ACCESS_TOKEN=REPLACE_WITH_THE_SEPARATE_APP_SECRET
PUBLIC_ANALYSIS_ENABLED=true
PUBLIC_ORIGIN=https://geoscope.example.com
APP_DATA_DIR=/data
MAX_UPLOAD_BYTES=20971520
MAX_FEATURES=100000
WORKER_TIMEOUT_SECONDS=90
```

Use the actual worker IP and public hostname. `PUBLIC_ORIGIN` has no path or trailing slash. Public mode lets visitors start paid inference/sandbox jobs; use `false` for private bearer-only API access. The browser uses a signed HttpOnly cookie and never needs an API-token field.

Build and start:

```bash
sudo docker compose -f deploy/controller.compose.yaml config --quiet
sudo docker compose -f deploy/controller.compose.yaml up --build --detach
sudo docker compose -f deploy/controller.compose.yaml ps
curl --fail --silent --show-error http://127.0.0.1:8000/api/config
```

Compose reads `deploy/controller.env`. The Dockerfile builds React and serves the compiled files through FastAPI; no separate `npm run dev` command is needed. `config --quiet` validates without printing the resolved secrets.

Verify the private route **from inside the running app container**, not just from the host:

```bash
sudo docker compose -f deploy/controller.compose.yaml exec -T controller python - <<'PY'
import os, httpx
base = os.environ['WORKER_URL'].rstrip('/')
with httpx.Client(timeout=10) as client:
    response = client.get(base + '/health')
    response.raise_for_status()
    health = response.json()
    assert health.get('ok') is True and 'runsc' in health.get('sandbox', '').lower(), health
    response = client.post(base + '/execute', json={})
    assert response.status_code == 401, response.status_code
print('PASS: app container reaches the private ready worker; unauthenticated execution is rejected.')
PY
```

This checks routing and basic authorization behavior. The live analysis in section 9 checks that the configured shared token actually works.

## 7. Put HTTPS in front — CONTROLLER VM

Use the [official Caddy package](https://caddyserver.com/docs/install):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
sudo nano /etc/caddy/Caddyfile
```

On this dedicated new host, replace the default site with the following. The hostname must match DNS and `PUBLIC_ORIGIN`:

```caddyfile
geoscope.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8000
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
curl --fail --silent --show-error https://geoscope.example.com/api/config
curl --fail --silent --show-error https://geoscope.example.com/api/worker-status
```

If UFW is already active on this controller, allow `80/tcp` and `443/tcp` there too. Keep port 8000 bound to loopback as in the supplied Compose file. Do not strip `/api` at the proxy.

Expect `demo_mode: false`, `analysis_enabled: true`, and worker `ok: true`. Those values are configuration/readiness checks, not proof of an executed agent job. Do not run `verification.scenario_demo_server` as the cloud entry point.

## 8. Enforce the narrow NetBird policy

After the section 6 private connection test passes, inspect all NetBird policies affecting these groups. Disable the broad Default / All-to-All policy in the dashboard, and remove overlapping broad access to these peers. Keep any explicit administration policies needed by other devices. With public-IP SSH restricted to your admin address, these changes do not depend on NetBird for administration.

Alternatively, use the helper from the controller with the exact policy ID you have inspected:

```bash
cd "$HOME/Geoscope"
read -rsp 'NetBird personal access token: ' NETBIRD_API_TOKEN
printf '\n'
export NETBIRD_API_TOKEN
python3 scripts/NetBird/policy.py \
  --controller-group-id REPLACE_WITH_CONTROLLER_GROUP_ID \
  --worker-group-id REPLACE_WITH_WORKER_GROUP_ID \
  --disable-default-policy-id REPLACE_WITH_INSPECTED_BROAD_POLICY_ID \
  --confirm-narrow-policy-tested --apply
unset NETBIRD_API_TOKEN
```

`--confirm-narrow-policy-tested` acknowledges that you already checked peer membership and the live allowed connection. The script disables only that one identified policy. Repeat the section 6 container check **after** disabling broad policies.

For a denial test, enroll an administrator-controlled third peer without assigning it to either Geoscope group. From that peer:

```bash
curl --connect-timeout 5 --max-time 10 http://WORKER_NETBIRD_IP:8100/health
```

The request must fail to connect. The controller must still connect successfully. Test the worker's **public** IP from your laptop too; TCP 8100 must not connect. A response such as HTTP 401 still proves the network port is reachable and does not count as network denial. Record failure to connect together with the policy/group configuration; a timeout alone could also indicate an offline peer. ICMP ping is not an acceptance test for a TCP-only policy.

## 9. Verify real execution and save evidence

### A. Containment checks — WORKER VM

Run while no other analyses are active. The harness deliberately submits a timeout probe and verifies cleanup as well as successful jobs. It does not use the LLM.

```bash
cd "$HOME/Geoscope"
mkdir -p "$HOME/geoscope-evidence"
set -o pipefail
(
  date -u
  hostname
  git rev-parse HEAD
  sudo docker info --format '{{json .Runtimes}}'
  sudo docker image inspect parkscope-sandbox:local --format '{{.Id}}'
  sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/deployment-demo.py'
) 2>&1 | tee "$HOME/geoscope-evidence/containment-$(date -u +%Y%m%dT%H%M%SZ).log"
```

Require a zero exit status and PASS messages for readiness, read-only input and unchanged input hash, blocked outbound connections, timeout enforcement, a subsequent healthy job, and cleanup. Preserve actual output; do not label local mock/runc results as cloud containment evidence. These probes demonstrate the tested controls, not immunity from every possible escape.

### B. Complete agent workflow over HTTPS — CONTROLLER VM

This starts **one real, billed agent run** through the public site with a guest cookie. The SF dataset contains observed population and **simulated** land/buildings/services; the execution uses the real controller, Vultr inference, NetBird, and sandbox worker. It does not establish real-world land availability.

```bash
cd "$HOME/Geoscope"
sudo docker compose -f deploy/controller.compose.yaml exec -T controller python - <<'PY'
import json, os, time
from pathlib import Path
import httpx

origin = os.environ['PUBLIC_ORIGIN'].rstrip('/')
with httpx.Client(base_url=origin, timeout=30) as client:
    response = client.get('/api/config')
    response.raise_for_status()
    config = response.json()
    assert config['demo_mode'] is False and config['analysis_enabled'] is True, config
    client.headers['Origin'] = origin
    response = client.post('/api/runs', json={
        'dataset_id': 'localdemo', 'analysis_mode': 'scenario',
        'question': 'Where can this hypothetical clinic fit and improve nearby service coverage?',
        'study_area': [-122.433, 37.758, -122.417, 37.776],
        'service_type': 'clinic', 'threshold_m': 400,
        'building': {'width_m': 24, 'depth_m': 18, 'height_m': 12, 'setback_m': 3},
    })
    response.raise_for_status()
    run_id = response.json()['id']
    print('Started live run:', run_id, flush=True)
    deadline = time.monotonic() + 900
    while True:
        response = client.get(f'/api/runs/{run_id}')
        response.raise_for_status()
        run = response.json()
        if run['status'] in ('completed', 'failed', 'interrupted'):
            break
        if time.monotonic() > deadline:
            raise SystemExit('Timed out waiting; inspect this run before submitting another.')
        time.sleep(3)
    assert run['status'] == 'completed', run.get('error') or run
    assert any(a.get('verified_against_reference') is True for a in run['attempts']), run['attempts']
    response = client.get(f'/api/runs/{run_id}/artifacts/result.json')
    response.raise_for_status()
    assert response.json() == run['result']
    evidence = Path('/data/deployment-evidence')
    evidence.mkdir(exist_ok=True)
    (evidence / f'{run_id}.json').write_text(json.dumps(run, indent=2), encoding='utf-8')
    print('PASS: HTTPS guest session, Vultr agent, private worker, reference verification, artifact download.')
    print('Evidence saved inside controller data volume:', evidence / f'{run_id}.json')
PY
```

The polling deadline does not cancel a running job. A failed code-generation attempt may be repaired by the agent, but a terminal failure is not a passed deployment test. Inspect the run error/trace, resolve the cause, and rerun deliberately.

For the presentation, open the public site and use the SF scenario to select a plot and show its 3D building. Change service type or footprint dimensions to demonstrate a different result. The script above checks the HTTP execution path; it does not verify visual appearance or browser interactions.

## 10. Configuration reference

| Setting | Location | Meaning / default |
| --- | --- | --- |
| `VULTR_SERVERLESS_INFERENCE_API_KEY` | Controller env | Inference credential; mandatory for agent calls. |
| `VULTR_MODEL_ID` | Controller env | Exact catalog model ID; mandatory. |
| `WORKER_URL` | Controller env | `http://<worker-NetBird-IP>:8100`; HTTP travels inside the encrypted tunnel. |
| `WORKER_TOKEN` | Both env files | Shared random secret; must match. |
| `APP_ACCESS_TOKEN` | Controller env | Separate random secret; at least 32 bytes for public sessions. Rotation invalidates existing guest cookies. |
| `PUBLIC_ANALYSIS_ENABLED` | Controller env | `false` by default; `true` allows visitor jobs. |
| `PUBLIC_ORIGIN` | Controller env | Exact HTTPS origin for guest writes and secure cookies. |
| `APP_DATA_DIR` | Controller Compose | `/data`; backed by the `controller-data` named volume. Compose explicitly sets this value. |
| `MAX_UPLOAD_BYTES` | Controller env | Optional; default `20971520` (20 MiB). |
| `MAX_FEATURES` | Controller env | Optional; default `100000`; scenarios have a separate 5,000-feature limit. |
| `WORKER_TIMEOUT_SECONDS` | Controller env | Optional; default `90`. Worker request timeout permits 1–180 seconds; increasing it may also require reviewing the controller HTTP timeout. |
| `NETBIRD_WORKER_IP` | Worker env | Assigned address used by the systemd listener. |
| `NETBIRD_INTERFACE` | Worker env | Optional preflight setting; default `wt0`; it does not change NetBird's interface. |
| `SANDBOX_IMAGE` | Worker env | Default `parkscope-sandbox:local`; build must exist on this worker. |
| `TMPDIR` | Worker env | `/var/lib/parkscope-worker/tmp`; service-writable job directory. |
| `NB_SETUP_KEY` | Enrollment shell only | Enrolls a host; clear after use. |
| `NETBIRD_API_TOKEN` | Policy-helper shell only | Personal access token; clear after use. |
| `NETBIRD_API_URL` | Policy-helper shell only | Optional; default `https://api.netbird.io/api`. |

Self-hosted NetBird is optional. Use a separate management host and the [official self-hosted setup](https://docs.netbird.io/selfhosted/selfhosted-quickstart). Enroll peers with your management URL and point `NETBIRD_API_URL` at that deployment's API when using the helper. No Geoscope runtime code change is needed; configuring that separate management stack is outside this managed-NetBird guide.

## 11. Start, stop, logs, and updates

**Controller**, from the same `~/Geoscope` directory:

```bash
sudo docker compose -f deploy/controller.compose.yaml logs --tail=100 controller
sudo journalctl -u caddy -n 100 --no-pager

# Stop/start the app while preserving its data volume.
sudo docker compose -f deploy/controller.compose.yaml stop
sudo docker compose -f deploy/controller.compose.yaml start

# Apply changes to controller.env; restart alone does not reload Compose env values.
sudo docker compose -f deploy/controller.compose.yaml up -d --force-recreate
```

**Worker:**

```bash
sudo journalctl -u parkscope-worker -n 100 --no-pager
sudo systemctl stop parkscope-worker
sudo systemctl start parkscope-worker

# After editing /etc/parkscope/worker.env:
sudo systemctl restart parkscope-worker
sudo netbird status -d
```

For an update, wait for active jobs to finish. Update the **worker first**, then the controller to the same revision:

```bash
# WORKER
cd "$HOME/Geoscope"
sudo systemctl stop parkscope-worker
git pull --ff-only
sudo bash scripts/install-worker.sh
```

```bash
# CONTROLLER
cd "$HOME/Geoscope"
git pull --ff-only
sudo docker compose -f deploy/controller.compose.yaml up --build --detach
```

Repeat readiness and containment checks after runtime/security changes. The worker installer preserves an existing worker environment file. Keep private backups of both environment files, Caddy configuration, and the controller data volume. Do not use `docker compose down --volumes` unless you intend to delete saved datasets and runs. Stopping the app does not stop Vultr VM billing.

## 12. Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Site unavailable / TLS fails | DNS A/AAAA records, controller inbound 80/443, existing host firewall, `journalctl -u caddy`, Caddyfile hostname. |
| HTTP 502 | Controller container is running and `curl http://127.0.0.1:8000/api/config` succeeds; Caddy upstream is loopback port 8000. |
| Analysis disabled | All four inference/worker settings are populated, public mode is enabled, app secret is long enough, HTTPS origin is valid; recreate the container after env edits. |
| Guest POST returns 403 | Exact `PUBLIC_ORIGIN`, a cookie obtained from `/api/config`, and matching `Origin` header; use the configured HTTPS hostname. |
| Worker cannot bind its address | NetBird is connected and IP is assigned; correct `NETBIRD_WORKER_IP`, then restart the worker. |
| Worker health `ok: false` | Inspect its `sandbox` message, Docker permissions, `runsc` registration, and local sandbox image. HTTP 200 alone is insufficient. |
| Host reaches worker but container cannot | Repeat section 6 from the app container; inspect Docker forwarding/NAT, subnet overlap, NetBird status, and host firewall. Keep the worker private. |
| Worker calls return 401 | Exact same `WORKER_TOKEN` on both hosts; restart worker and recreate controller after changes. |
| Model catalog / inference 401 or 403 | Use a Serverless Inference key with an active subscription; an infrastructure API token is different. |
| Model missing or request rejected | Rediscover catalog IDs, select a chat-compatible model, then inspect returned error/trace; do not switch providers silently. |
| Unauthorized peer can connect | Broad Default or overlapping NetBird policy is still enabled, or peer group membership is too broad. |
| HTTP 429 | Two jobs/requests may already be active; wait and inspect run status before resubmitting. |
| Worker quarantined after cleanup error | Stop admitting work, inspect worker logs and labeled job containers, repair cleanup/runtime failure, then restart and rerun containment checks. |
| SF scenario fits no buildings | Check selected area, footprint, setback, and supplied obstacles. A completed empty result can be correct. The land data remain simulated. |

Related repository files: [Compose](../deploy/controller.compose.yaml), [controller env template](../deploy/controller.env.example), [worker env template](../deploy/worker.env.example), [worker service](../deploy/parkscope-worker.service), [installer](../scripts/install-worker.sh), [NetBird policy helper](../scripts/NetBird/policy.py), and [live evidence notes](deployment/demo/README.md).
