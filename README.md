# GeoScope

GeoScope is a sandboxed geospatial analyst for service access, candidate locations, and population inside supplied zones. Bring population data and facilities such as clinics, schools, libraries, shelters, or parks; the same workflow measures proximity and compares proposed locations. Bring zone boundaries to estimate how much population falls inside them. The included San Francisco parks and 2020 Census snapshot is one documented example, not a complete current inventory. A land-aware SF mock scenario also checks proposed building footprints against modeled plots and obstructions, then displays the selected proposal in Three.js.

The React frontend talks to a FastAPI controller over HTTPS. Vite builds the frontend, and FastAPI serves its compiled assets alongside the existing API. The controller calls [Vultr Serverless Inference](https://docs.vultr.com/how-to-use-vultr-serverless-inference-in-python) and a private worker over NetBird. The worker runs model-authored Python only in disposable Linux Docker containers using gVisor `runsc`, with no network, a read-only input mount, resource limits, and bounded output. NetBird runs on the trusted VM hosts only. Neither access tokens nor NetBird credentials enter the analysis container.

## Input data and local preview

Uploads are GeoJSON FeatureCollections with EPSG:4326 longitude/latitude coordinates (RFC default WGS84; if a `crs` member is present it must identify EPSG:4326 or CRS84). Features use `properties.layer` values `population`, `service`, or `zone`; the legacy value `park` is treated as `service`. Population features need a finite, nonnegative numeric `properties.population`. Points, Polygons, and MultiPolygons are accepted; zones must be polygon geometries. Keep feature IDs stable where present because output maps preserve IDs, geometries, and source properties. The app's analysis uses projected local UTM metres and population polygon representative points.

Access mode requires population and service features and reports distance to the nearest service within the selected threshold (default 800 m). Compare mode has the same input requirements plus `candidate_a` and `candidate_b` as longitude/latitude pairs near the study area; the candidates are compared by population newly served within the threshold. Exposure mode requires population features and at least one zone polygon; zones are unioned, so overlapping zones do not double count population. Uploads must fit the configured 20 MiB and feature limits. Download the synthetic fixture at `GET /api/datasets/demo` or the San Francisco snapshot at `GET /api/datasets/real`; the latter's sources, dates, filters, hashes, and caveats are documented in [the data README](data/real/README.md).

For a local UI and data preview on Windows PowerShell, use Node.js 24 and Python 3.12 or newer. Build the React frontend, then start FastAPI:

```powershell
npm --prefix web ci
npm --prefix web run build
python -m pip install -r requirements.txt
$env:APP_DATA_DIR = ".\local-data"
python -m uvicorn app.controller:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`. This preview needs no API keys, but analysis submission stays disabled until backend credentials, public guest access, and the isolated worker are configured. No token is entered or stored in the UI. The Windows host cannot run the gVisor worker; it refuses to execute without Linux Docker advertising `runsc` and the local sandbox image. A Windows `runc` container is not evidence of sandbox containment.

For frontend development, leave FastAPI running on port 8000 and use a second terminal:

```powershell
npm --prefix web run dev
```

Vite serves React on `http://127.0.0.1:5173` and proxies `/api` to FastAPI. Set `GEOSCOPE_API_PROXY` only when using another local backend address. Keep Vultr and worker secrets on the backend; do not put them in frontend environment variables. A missing production build returns a helpful 503 at `/`, while the API remains available. The Dockerfile builds React in a Node stage and copies only `web/dist` into the Python runtime image.

See `web/package.json` and its lockfile for frontend dependencies, and `requirements.txt` for Python dependencies. On a configured Linux worker, run `uvicorn app.worker:app --host <NETBIRD_WORKER_IP> --port 8100` only after following the deployment setup below.

## SF land simulation and 3D proposals

To run the interactive **local mock** without cloud credentials:

```powershell
python -m pip install -r requirements-test.txt
npm --prefix web ci
npm --prefix web run build
python -m verification.scenario_demo_server --port 8765
```

Open `http://127.0.0.1:8765`. Select an area by two map corners (or edit bounds), choose clinic/library/school/community centre, set footprint dimensions and setback, then run. Choose a ranked plot to inspect its proposed building in the orbitable Three.js scene. Changing land assumptions or dimensions invalidates the old result and requires another calculation.

The mock uses 12 observed SF Census tracts and seven explicitly modeled plots: four fit the default building, one has an obstruction, one is restricted, and one is too small. It calculates geometry and proximity locally from fixed trusted code; it does **not** run an LLM, generated program, cloud worker, or gVisor. The live controller still requires isolated execution. See [fixture provenance](data/real-scenario/README.md). Actual parcel availability, use permissions and existing buildings are not established by this mock.

Scenario input needs `population` and `candidate_site` polygons with stable unique IDs, `land_status: "available"`, a traceable `source`, and `allowed_services`. Optional `building` and `restricted` polygons act as obstacles; their declared inventory coverage must be complete for the candidate sites. `land_inventory` supplies `source`, `as_of`, `building_coverage` and `restriction_coverage` (both `complete_for_candidate_sites`). Service features need a matching `service_type`; parks and untyped services never count as clinics or libraries. Missing matching inventory is unknown access, not proof of no existing services.

A candidate must contain the **whole footprint plus setback**, fit inside the selected area, and avoid every supplied building/restriction. Per plot, the search tests at most 81 deterministic anchors with 0/90-degree orientation. It returns up to three independent alternatives ranked by added population proximity, then mean distance, then site ID, and records rejected plots. A failed search means no fit was found under those tests, not that the plot can never be built on. Height changes the 3D massing only. Distances are projected straight-line measures; Census tract representative points allocate entire tract populations and are coarse for hyperlocal work. Verified land checks apply to supplied geometry and records; they do not independently establish ownership or planning approval.

## Environment-only access

`APP_ACCESS_TOKEN` stays on the backend: a randomly generated secret of at least 32 bytes signs HttpOnly, SameSite=Strict guest cookies and remains available for private programmatic bearer access. It is never sent to React. Set `PUBLIC_ANALYSIS_ENABLED=true` and `PUBLIC_ORIGIN` to the exact browser origin to enable guest analysis (use `http://127.0.0.1:5173` for Vite). All provider and worker credentials remain in the backend environment. `.env` files must be loaded by your process runner; Docker Compose loads `deploy/controller.env`.

Public mode deliberately allows visitors to start jobs, subject to the existing concurrency, input and storage caps; it is not a login system. Uploaded datasets and runs are isolated by a signed 24-hour guest session, writes require the configured Origin, and responses are not cached. Keep public mode disabled when private API-only access is intended. The separate loopback mock server generates an ephemeral server secret automatically unless one is configured.

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

## Submission status

The repository contains deployment instructions and configurable deployment files. No cloud VMs, Vultr credentials, NetBird account, public URL, or recording have been provisioned in this environment. Do not describe the service as live or claim real gVisor containment until the deployment and demo harness have succeeded on the actual worker. Record the HTTPS URL, commit/repository location, demo recording, and real worker evidence in the submission materials once available.

Implementation and acceptance scope are recorded in [PLAN.md](PLAN.md); checks actually run are recorded in [VERIFICATION.md](VERIFICATION.md). With `APP_DATA_DIR` set to a writable local directory, run the full local suite with `python -m pytest -q --basetemp=tmp/pytest-local`; the deployment policy helper tests can also be run alone with `python -m pytest -q tests/test_deployment_netbird.py --basetemp=tmp/pytest-deployment`. These temporary directories are disposable pytest output. The suite uses controlled substitutes for cloud services; it does not establish live containment or deployment.


## Automated checks

```powershell
npm --prefix web test
npm --prefix web run build
$env:APP_DATA_DIR = ".\local-data"
python -m pip install -r requirements-test.txt
python -m pytest -q --basetemp=tmp/pytest-local
```

Frontend tests run in a simulated DOM without launching a browser. Python tests cover the FastAPI API and compiled-asset boundary. No further browser checks are performed, as requested. The prior screenshot and browser evidence in `verification/` belong to the earlier static frontend.
