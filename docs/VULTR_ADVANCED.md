# Geoscope: advanced Vultr deployment reference

Start with the [six-step setup guide](VULTR_SETUP.md). Two Vultr VMs communicate over a dedicated VPC. The controller calls Vultr Serverless Inference and dispatches execution to the authenticated worker. Jobs run in disposable gVisor containers with no network.

Use the VPC address assigned to each VM, not its public address or a guessed subnet. Example `10.0.0.2` values must be replaced with the actual worker address. Host firewall rules in the short guide restrict worker TCP 8100 to the controller; HTTP inside this VPC is not an encrypted tunnel.

## Migrate an existing worker

Use SSH through the VM's public address (or its working VPC address). Keep the existing shared worker token and app secret.

1. Attach both VMs to the same Vultr VPC and confirm their private addresses with `ip -br -4 addr`.
2. Add the worker host firewall rules from [step 3](VULTR_SETUP.md#3-allow-the-private-connection).
3. On the worker, pull the update, stop the previous service if it was started, and edit its protected environment:

```bash
cd "$HOME/Geoscope"
git pull --ff-only
sudo systemctl stop parkscope-worker.service 2>/dev/null || true
sudo nano /etc/parkscope/worker.env
```

Replace `NETBIRD_WORKER_IP=...` with `WORKER_BIND_IP=<actual-worker-VPC-IP>` and remove `NETBIRD_INTERFACE` if present. Preserve the other values. If the earlier build failed before this file was created, run the installer first to create it, then edit it and rerun.

```bash
sudo env SANDBOX_BUILD_NETWORK=host bash scripts/install-worker.sh
```

This uses the build DNS workaround when the host itself can resolve package servers. The new service validates the private bind address on each start. The installer preserves existing secrets.

4. On the controller, pull the same revision and change only `WORKER_URL` in `deploy/controller.env` to `http://<worker-VPC-IP>:8100`, then recreate the container:

```bash
cd "$HOME/Geoscope"
git pull --ff-only
nano deploy/controller.env
sudo docker compose -f deploy/controller.compose.yaml up --build -d --force-recreate
```

5. Once both the private connection and public-IP SSH work, remove the old NetBird client from these dedicated Geoscope VMs, if it was installed:

```bash
sudo netbird down
sudo systemctl disable --now netbird
sudo apt-get remove -y netbird
```

The new application, installer, and service do not require NetBird. These uninstall commands are manual because changing the repository does not change already-running servers. Remove the two retired peers/setup keys from your NetBird dashboard if no other workload needs them. Do not run the fresh-host preparation helper again on an installed worker; rerun the worker installer and live checks instead.

## Network checks

After setting the worker host firewall and starting its service, run on the controller:

```bash
curl --fail --silent --show-error http://WORKER_VPC_IP:8100/health
curl --fail --silent --show-error https://geoscope.example.com/api/worker-status
```

Both must report `ok: true`; the second checks the connection from the actual app container. On the worker, `sudo ss -lntp 'sport = :8100'` must show only its VPC address.

From outside the VPC, the following must fail to connect:

```bash
curl --connect-timeout 5 --max-time 10 http://WORKER_PUBLIC_IP:8100/health
```

If another test VM is attached to this VPC, its connection to the worker's private TCP 8100 must also fail. Verify the allowed controller still succeeds. Any HTTP response, including 401, means the port was reachable and is not proof of network denial. Review the actual UFW rule order; a timeout alone can also mean an offline server.

Vultr's [VPC provisioning](https://docs.vultr.com/products/network/vpc-networks/provisioning) and [adapter configuration](https://docs.vultr.com/how-to-configure-networking-on-vultr-cloud-servers) describe attaching the two VMs to a private network in the same region. Keep ordinary internet egress available on the hosts for package downloads and inference; analysis containers still have none.

## Manual package installation

Use fresh VMs without an existing Docker installation. The following uses Docker's package repository. If the machine already has Docker or containerd installed, first follow the compatibility guidance in [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git python3 python3-venv openssl nano iproute2 ufw
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

## Manual gVisor installation

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

## Model ID lookup

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

## Manual HTTPS installation

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

## Live execution evidence

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

This starts **one real, billed agent run** through the public site with a guest cookie. The SF dataset contains observed population and **simulated** land/buildings/services; the execution uses the real controller, Vultr inference, private VPC, and sandbox worker. It does not establish real-world land availability.

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

## Configuration reference

| Setting | Location | Meaning / default |
| --- | --- | --- |
| `VULTR_SERVERLESS_INFERENCE_API_KEY` | Controller env | Inference credential; mandatory for agent calls. |
| `VULTR_MODEL_ID` | Controller env | Exact catalog model ID; mandatory. |
| `WORKER_URL` | Controller env | `http://<worker-VPC-IP>:8100`; private VPC HTTP, without added transport encryption. |
| `WORKER_TOKEN` | Both env files | Shared random secret; must match. |
| `APP_ACCESS_TOKEN` | Controller env | Separate random secret; at least 32 bytes for public sessions. Rotation invalidates existing guest cookies. |
| `PUBLIC_ANALYSIS_ENABLED` | Controller env | `false` by default; `true` allows visitor jobs. |
| `PUBLIC_ORIGIN` | Controller env | Exact HTTPS origin for guest writes and secure cookies. |
| `APP_DATA_DIR` | Controller Compose | `/data`; backed by the `controller-data` named volume. Compose explicitly sets this value. |
| `MAX_UPLOAD_BYTES` | Controller env | Optional; default `20971520` (20 MiB). |
| `MAX_FEATURES` | Controller env | Optional; default `100000`; scenarios have a separate 5,000-feature limit. |
| `WORKER_TIMEOUT_SECONDS` | Controller env | Optional; default `90`. Worker request timeout permits 1–180 seconds; increasing it may also require reviewing the controller HTTP timeout. |
| `SANDBOX_IMAGE` | Worker env | Default `parkscope-sandbox:local`; build must exist on this worker. |
| `TMPDIR` | Worker env | `/var/lib/parkscope-worker/tmp`; service-writable job directory. |
| `SANDBOX_BUILD_NETWORK` | Installer shell only | Optional `default` or `host`; use `host` for build DNS recovery. Does not change analysis-job networking. |
| `WORKER_BIND_IP` | Worker env | Required assigned RFC1918 IPv4 address; checked before the worker starts. |

## Start, stop, logs, and updates

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

## Troubleshooting

| Symptom | Check / action |
| --- | --- |
| TLS/site unavailable | DNS A/AAAA records, controller inbound 80/443, Caddy logs and hostname. |
| HTTP 502 | Controller is running and loopback `http://127.0.0.1:8000/api/config` responds. |
| Worker preflight rejects bind address | Set `WORKER_BIND_IP` to its assigned RFC1918 VPC IPv4 address; attach/configure the VPC adapter first. |
| Worker health is false | Read the sandbox message; verify Docker access, `runsc`, and the installed sandbox image. |
| Host reaches worker but app cannot | Inspect Docker forwarding/NAT, overlapping Docker/VPC subnets, routes, and worker UFW rule order. |
| Worker returns 401 | Same `WORKER_TOKEN` on both hosts; restart worker and recreate controller after edits. |
| Guest writes return 403 | Exact `PUBLIC_ORIGIN`, matching Origin header, and cookie from `/api/config`. |
| Analysis disabled | Complete inference/worker configuration, public mode and a strong app secret; recreate the container after env edits. |
| Inference fails | Active Serverless Inference key/subscription and a chat-compatible model from its catalog. |
| Port 8100 reachable from another host | Inspect worker listener and host firewall; the controller-only allow must precede the general TCP 8100 deny. |
| Worker quarantined | Inspect cleanup failure before restarting; rerun containment checks after repairing the cause. |
| Package build cannot resolve names | Follow the build DNS section below; removing a VPN does not itself prove DNS is repaired. |

## Docker build cannot resolve PyPI

If `pip install shapely==2.0.7` logs `Temporary failure in name resolution` followed by `No matching distribution found`, it could not reach the package index. That output does not establish a version mismatch. Check DNS on the worker host first:

```bash
getent hosts pypi.org files.pythonhosted.org
```

If both names resolve, update the repository and run the installer using the host network **only for building the trusted sandbox image**:

```bash
cd "$HOME/Geoscope"
git pull --ff-only
sudo env SANDBOX_BUILD_NETWORK=host bash scripts/install-worker.sh
```

If this is the first successful installer run, fill in `/etc/parkscope/worker.env` as described in the short setup guide, then repeat that same installer command. The option is supplied to the installer shell, not stored in `worker.env`. Analysis jobs still use gVisor with `--network none`. No Docker daemon configuration is changed by this option. Docker documents [build network selection](https://docs.docker.com/reference/cli/docker/buildx/build/#set-the-networking-mode-for-the-run-instructions-during-build---network) separately from runtime networking.

If the host lookup also fails, the host's DNS needs repair first; host-network builds cannot fix it. Collect these diagnostics before changing resolver or firewall settings:

```bash
resolvectl status
cat /etc/resolv.conf
```

If name resolution succeeds but downloads still fail, check the new error for outbound HTTPS, proxy, or certificate problems. Docker explains [container DNS resolver issues](https://docs.docker.com/engine/daemon/troubleshoot/#dns-resolver-issues). If editing `/etc/docker/daemon.json` is eventually needed, preserve its existing `runsc` runtime configuration.

Related files: [Compose](../deploy/controller.compose.yaml), [worker service](../deploy/parkscope-worker.service), [worker installer](../scripts/install-worker.sh), [preflight](../scripts/worker-preflight.py), and [live evidence](deployment/demo/README.md).
