# Geoscope

Geoscope is a geospatial analysis app built with **React, FastAPI, Leaflet, and Three.js**. Select a local area, propose a clinic or library, compare candidate plots, and inspect the proposed building in 3D. Land checks cover the whole building footprint, setbacks, plot boundaries, and supplied obstacles before a site is ranked.

The repository includes a working **San Francisco mock simulation** and a separate production agent workflow designed for **Vultr Serverless Inference, gVisor sandboxes, and NetBird**. Cloud deployment and live containment verification are still pending.

## What you can do

| Workflow | Result |
| --- | --- |
| Facility scenario | Select an area, choose a clinic, library, school, or community centre, and rank up to three eligible plots with a 3D building preview. |
| Service access | Estimate population proximity to supplied facilities. |
| Candidate comparison | Compare two proposed locations against an existing service network. |
| Population inside zones | Estimate population assigned to supplied boundaries, accounting for overlapping zones. |

Results include metrics, GeoJSON, the input request, analysis code, and a run trace. The local mock enables the facility scenario only; the configured production controller supports all four workflows.

## Quick start: SF mock demo

Requirements: **Node.js 24**, **Python 3.12 or newer**, and a WebGL-capable browser for the 3D view. Run these commands from the repository root in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
npm --prefix web ci
npm --prefix web run build
.\.venv\Scripts\python.exe -m verification.scenario_demo_server --port 8765
```

On macOS/Linux, use `.venv/bin/python` instead of `.\.venv\Scripts\python.exe`. Open **http://127.0.0.1:8765**; use that exact host because the mock checks the request origin. FastAPI serves both the API and the built React frontend, so this demo needs only one server process.

1. Keep the SF mock dataset selected and choose a facility type.
2. Use **Select area on map** to mark two opposite corners, or edit the coordinate bounds.
3. Set the building width, depth, height, and setback, then run the analysis.
4. Select a ranked plot to inspect its proposed footprint and building in the orbitable 3D view.
5. Inspect rejected plots and download the calculation artifacts. Changing scenario inputs clears the old result and requires another run.

With the default 24 × 18 m footprint and 3 m setback, **four of seven modeled plots qualify**. The other plots are building-blocked, restricted, or too small. A 100 × 100 m footprint fits none of them.

### What the mock verifies

| Data or execution | SF mock |
| --- | --- |
| Population | 12 unchanged observed 2020 Census tracts from the bundled SF snapshot. |
| Plots, buildings, restrictions, services | Explicitly simulated features placed at SF coordinates. |
| Land checks | Computed containment, setbacks, declared permitted uses, and collisions against the modeled land inventory. |
| Analysis execution | Fixed trusted local calculations; no LLM, generated-code execution, cloud worker, or gVisor. |
| Real-world availability or permits | Not established by the mock. |

The 3D scene uses the checked footprint on flat ground. Height affects its appearance; width, depth, and setback affect site eligibility and placement. See [SF mock provenance](data/real-scenario/README.md) and its [manifest](data/real-scenario/manifest.json).

### Stop the app

Press **Ctrl+C** in the demo terminal. This stops both the API and the served frontend. When using separate FastAPI and Vite development terminals, press **Ctrl+C in each terminal**. Stop a Compose controller with:

```powershell
docker compose --file deploy/controller.compose.yaml down
```

## Production architecture

The live workflow is: **React → FastAPI controller on Vultr → Vultr Serverless Inference → private worker over NetBird → disposable gVisor container → verified results**.

The controller plans, generates analysis code, and makes bounded repair attempts. The separate worker executes generated code and a fixed GIS reference in isolated containers, compares their metrics and geometry, and returns checked artifacts. Sandboxes have no outbound network, read-only input, resource limits, bounded output, and verified cleanup. The worker refuses execution without the required `runsc` runtime; NetBird connects the trusted hosts and does not replace sandbox isolation. Provider keys, access tokens, and NetBird credentials never enter analysis containers.

The Dockerfile builds React in a Node stage and copies only compiled assets into the FastAPI runtime. The mock server is a separate development entry point, not a fallback when production infrastructure is unavailable.

## Environment configuration

There is **no API-token field in the UI**. Provider and worker credentials stay in the backend environment. `APP_ACCESS_TOKEN` signs opaque HttpOnly guest cookies and also supports private programmatic bearer access; its value is never sent to React.

| Variable | Purpose |
| --- | --- |
| `VULTR_SERVERLESS_INFERENCE_API_KEY` | Backend inference credential. |
| `VULTR_MODEL_ID` | Exact model ID available in the account's Vultr catalog. |
| `WORKER_URL` | Worker URL on its private NetBird address. |
| `WORKER_TOKEN` | Shared controller-to-worker secret. |
| `APP_ACCESS_TOKEN` | Random server secret of at least 32 bytes for public guest sessions and private API access. |
| `PUBLIC_ANALYSIS_ENABLED` | Set to `true` to allow browser guests to start jobs; defaults to disabled. |
| `PUBLIC_ORIGIN` | Exact browser origin, including scheme and port where applicable. |
| `APP_DATA_DIR` | Writable directory for uploaded datasets, run records, and artifacts. |

Start from [.env.example](.env.example) for local configuration or [deploy/controller.env.example](deploy/controller.env.example) for Compose. Do not commit filled-in environment files or put secrets in frontend environment variables. `.env` is loaded only when requested by the process runner; Compose loads `deploy/controller.env`.

Public mode permits visitor jobs subject to concurrency, input, and storage caps. It is not a login system. Guest uploads and runs are isolated by signed 24-hour sessions, writes require the configured Origin, and private responses are not cached. Keep public mode disabled for private API-only access. The loopback mock configures its own origin and generates an ephemeral server secret unless one is already configured; use a stable backend secret if mock sessions must survive restarts.

## Frontend and backend development

For the live-controller path, install `requirements.txt`, create a local `.env`, and set `APP_DATA_DIR` to a writable local path. For Vite development set `PUBLIC_ORIGIN=http://127.0.0.1:5173`. Run these in separate terminals:

```powershell
# Terminal 1: FastAPI (analysis requires configured Vultr and worker services)
.\.venv\Scripts\python.exe -m uvicorn app.controller:app --env-file .env --host 127.0.0.1 --port 8000

# Terminal 2: React with hot reload
npm --prefix web run dev
```

Vite runs at **http://127.0.0.1:5173** and proxies `/api` to FastAPI on port 8000. `GEOSCOPE_API_PROXY` can override that backend address. A controller without inference/worker configuration still exposes the map preview but disables analysis. For a mock with no cloud setup, use the quick start above instead.

## Data and analysis contracts

Uploads are GeoJSON FeatureCollections in EPSG:4326 longitude/latitude. If present, `crs` must identify EPSG:4326 or CRS84. Population features require a finite nonnegative `properties.population`. Preserve stable feature IDs.

| `properties.layer` | Geometry | Additional scenario requirements |
| --- | --- | --- |
| `population` | Point, Polygon, MultiPolygon | Population weight. Polygon weights are assigned through projected representative points. |
| `service` | Point, Polygon, MultiPolygon | Matching `service_type` for scenario baselines. |
| `park` | Point, Polygon, MultiPolygon | Legacy service alias in ordinary access/comparison; never counts as a clinic or library. |
| `zone` | Polygon, MultiPolygon | Used by population-inside-zones analysis. |
| `candidate_site` | Polygon, MultiPolygon | Unique string feature ID; `land_status: "available"`, nonempty `source`, and `allowed_services` containing the chosen service. |
| `building`, `restricted` | Polygon, MultiPolygon | Obstructions excluded from proposed footprints and setbacks. |

Scenario datasets also require top-level `land_inventory` with a `source`, ISO `as_of` date, and both `building_coverage` and `restriction_coverage` set to `complete_for_candidate_sites`. These are supplied declarations, not independent certification of ownership or permission. Missing obstruction coverage is not assumed clear. The [SF fixture](data/real-scenario/sf-mock.geojson) provides a complete worked input; regenerate it with `python scripts/generate_sf_mock_scenario.py`.

Scenarios accept at most 5,000 features and 100 candidate plots. Each selected-area side must be 20 m–10 km. The search tries up to 81 deterministic anchors per plot at 0°/90°, checking the entire footprint plus setback against the plot, selected area, buildings, and restrictions. It ranks one placement per eligible plot by added population proximity, then weighted mean distance, then site ID. Alternatives are independent proposals. No fit found by this bounded search does not mean that every possible placement is impossible.

Only matching typed services count toward a scenario baseline, including services outside the selected area. Missing matching inventory means unknown existing access, not verified absence. Distances are straight-line metres in a local projected CRS; routes, terrain, capacity, and travel barriers are not modeled. Whole-tract population allocation is coarse for hyperlocal analysis and is not an exact count of nearby residents.

The UI starts at a 400 m access threshold; the API default is 800 m. General uploads use the configured size/feature limits (20 MiB by default). Bundled data endpoints are `/api/datasets/demo`, `/api/datasets/real`, and `/api/datasets/localdemo`. The original SF parks/Census snapshot remains separate; see [its provenance](data/real/README.md).

## Deployment

Use two Linux VMs: a public controller VM with HTTPS terminated by a managed load balancer or host reverse proxy, and a worker VM with no public listener on TCP 8100. Use a dedicated NetBird account or project/groups for these peers. The worker should have at least 4 GiB RAM for two concurrent 768 MiB jobs plus the OS and runtime. The worker's Docker group membership grants root-equivalent control of that worker, so keep it dedicated and do not run unrelated workloads.

1. Install Docker Engine and NetBird on the worker host. Enroll that host and the controller host in the same NetBird network. Assign only those two peers to dedicated `geoscope-controller` and `geoscope-worker` groups. Deny public TCP 8100 in the cloud firewall/security group and bind the worker process only to its assigned NetBird address. NetBird traffic is carried inside the overlay tunnel, so the cloud firewall cannot filter the virtual NetBird interface itself.
2. Install gVisor following its [official install guide](https://gvisor.dev/docs/user_guide/install/), then verify Docker with `docker run --rm --runtime=runsc hello-world`. The gVisor docs recommend the Debian package route where supported. Do not modify an existing shared Docker daemon without reviewing its current configuration.
3. Install Python 3 and venv support first (on a minimal Debian/Ubuntu VM, install `python3` and `python3-venv`). Copy this repository to the worker and run `sudo bash scripts/install-worker.sh`. On first run it creates `/etc/parkscope/worker.env`; set `WORKER_TOKEN` to a random secret, `NETBIRD_WORKER_IP` to this worker's assigned NetBird address, and `SANDBOX_IMAGE=parkscope-sandbox:local`, then run the installer again. Set `NETBIRD_INTERFACE` if the interface is not named `wt0`. The script builds the pinned Python 3.12 / Shapely 2.0.7 / PyProj 3.7.0 sandbox image locally. The systemd process runs as a dedicated non-root user, bound to the NetBird address on port 8100. Verify setup with `sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; bash /opt/parkscope/scripts/NetBird/preflight.sh'`.
4. From a trusted admin machine, dry-run empty dedicated groups with `python3 scripts/NetBird/policy.py --create-groups`, then apply with `NETBIRD_API_TOKEN` and `--apply`. This creates only two empty groups and refuses to reuse names already present; it does not assign peers or change policies. Assign only the intended controller and worker peers in NetBird and verify membership. Then dry-run the narrow policy with the returned IDs: `python3 scripts/NetBird/policy.py --controller-group-id <id> --worker-group-id <id>`. Applying it creates only a one-way TCP/8100 rule and leaves existing policies unchanged. Re-running safely reuses that policy only when its live shape exactly matches; a mismatch is refused. Confirm controller-to-worker connectivity first and preserve management SSH access before changing a broad default rule. To verify unauthorized-peer denial, identify and explicitly disable the broad default policy using its exact ID and `--confirm-narrow-policy-tested`, then test that the authorized controller still connects and an unrelated peer cannot. The policy shape acknowledgement is only accepted after you perform those live tests. The API uses `Authorization: Token`; see [NetBird groups](https://docs.netbird.io/api/resources/groups) and [policy API](https://docs.netbird.io/api/resources/policies). Self-hosted NetBird is optional; use the [official quickstart](https://docs.netbird.io/selfhosted/selfhosted-quickstart) on a separate management host if required by your deployment.
5. On the controller VM, copy the repository, create `deploy/controller.env` from `deploy/controller.env.example`, and fill in `VULTR_SERVERLESS_INFERENCE_API_KEY`, an exact `VULTR_MODEL_ID` available to that account, the same `WORKER_TOKEN`, and a separate randomly generated `APP_ACCESS_TOKEN` of at least 32 bytes. Set `PUBLIC_ANALYSIS_ENABLED=true` to allow browser guests and `PUBLIC_ORIGIN=https://<your-domain>`. Set `WORKER_URL=http://<worker-NetBird-IP>:8100`. Protect the file with `chmod 600 deploy/controller.env`. Run `docker compose --file deploy/controller.compose.yaml up --build --detach`; the controller listens only on `127.0.0.1:8000` for the HTTPS proxy. The included [Caddy example](deploy/Caddyfile.example) can serve as the public HTTPS reverse proxy after replacing the sample domain. Ensure the proxy preserves `/api` paths and does not publish the worker port.
6. Check the worker readiness endpoint from the controller over NetBird and inspect `/api/config` through the public site. Configure DNS and HTTPS at the chosen proxy/load balancer. The backend keeps all API secrets; explicitly enabling public guest analysis permits bounded paid jobs. Sharing the site does not expose the worker endpoint.
7. Run the actual containment demonstration from the worker host after loading its protected environment: `sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; python3 /opt/parkscope/scripts/deployment-demo.py'`. The worker installer makes the protected environment readable only by root and the dedicated worker group. It copies the harness into `/opt/parkscope/scripts`. Save the unedited output with date, host identity, and source revision. It must show worker readiness, read-only input, blocked outbound networking, timeout enforcement, and no leftover managed job containers. The harness exits with failure if a check fails; it does not manufacture evidence.

Useful operator files: [controller compose](deploy/controller.compose.yaml), [worker systemd unit](deploy/parkscope-worker.service), [NetBird policy helper](scripts/NetBird/policy.py), [worker installer](scripts/install-worker.sh), and [containment demo](scripts/deployment-demo.py).

## Verification and project status

Latest recorded checks: **99 backend tests**, **15 frontend tests**, the production build, Docker packaging, and HTTP-only mock/asset checks passed. Frontend tests use a simulated DOM; geometry tests construct Three.js geometry without a browser. GPU appearance and browser interaction have not been checked for this version. See [VERIFICATION.md](VERIFICATION.md) for evidence and limits.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
npm --prefix web test
npm --prefix web run build
$env:APP_DATA_DIR = ".\local-data"
.\.venv\Scripts\python.exe -m pytest -q --basetemp=tmp/pytest-local
```

With the mock server already running on port 8765, `python verification/scenario_http_smoke.py` checks clinic/library runs, rejected oversized footprints, downloads, and guest isolation without opening a browser.

The SF mock is implemented. **Live Vultr, gVisor, and NetBird setup and acceptance checks remain pending.** Local tests do not establish cloud deployment or containment. The implementation plan is in [PLAN.md](PLAN.md); deployment files are in [deploy/](deploy/).
