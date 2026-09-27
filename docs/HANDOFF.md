# Geoscope application handoff

Recorded September 26, 2026 (America/Los_Angeles), September 27 UTC. Last tested and deployed **application** commit: `55e8a63` on `main`. Documentation commits may be newer. This is a status snapshot, not a claim that all future deployments have been tested.

## Start here

- Public application: [http://149.28.204.217/](http://149.28.204.217/).
- Repository: [thesid42/Geoscope](https://github.com/thesid42/Geoscope), public, branch `main`.
- Stack: React/Vite, FastAPI, Leaflet, Three.js, Vultr Serverless Inference, a separate worker, and gVisor containers over Vultr VPC. **No NetBird integration.**
- Live API checks and automated tests passed. The most recent browser retries failed **before accessing the page**, so the final rendered UI has not been accepted visually.
- The dataset mixes observed population/facility records with simulated land. Geometric fit is checked; actual land availability is not established.
- Credentials belong in the existing server environment files or the operator's private credential store. No passwords, API keys, worker tokens, or app secrets belong in this document or Git.

### Deployed land-context update

Commit `55e8a63` moved the four eligible simulated plots off mapped OSM buildings and transport corridors. The deployed fixture includes 556 mapped building footprints and 435 buffered road/footpath corridors around all seven plots, enforced as sandbox obstructions. It has 1,085 features (915,961 bytes). The verified clinic ranking is `sfmock-fit-02`, `sfmock-fit-01`, `sfmock-fit-03`, with additional population weights `2,906`, `2,906`, and `0`. This is deployed and API-tested on both the controller and worker; deployed visual browser acceptance remains outstanding.

## Implemented behavior

| Workflow | Inputs and outcome |
| --- | --- |
| Facility sites (`scenario`) | Select a rectangle, facility type, dimensions, setback, and service distance. Check supplied plots and obstructions; rank up to three independent proposals; display the checked footprint in 3D. |
| Population estimate (`exposure`) | Count whole population weights whose projected representative points fall inside the drawn rectangle. A rectangle replaces pre-existing zones for that run without modifying the source dataset. API clients may omit the rectangle and use supplied zones. |
| Nearby services (`access`) | Estimate existing proximity and population inside/outside the chosen straight-line distance. |
| Compare locations (`compare`) | Compare A/B against the supplied service inventory; pins and coordinates lock during execution and changed inputs invalidate old results. |

The live controller supports all four workflows. `verification/scenario_demo_server.py` is an explicitly labeled local fixed-reference demo supporting only scenarios; it does not invoke an LLM or claim cloud execution.

The UI now has task-specific actions, collapsible advanced settings, result headlines, and technical details/downloads behind a disclosure. Map labels align with ranked Site 1/2/3 cards. Blue dashed lines mark the study boundary, purple outlines mark candidate plots, teal identifies the selected plot, orange shows proposed footprints, gray shows supplied building records, and red shows restrictions. Excluded plots have labels and reasons. Clicking a ranked marker selects its result; a separate button zooms to the selected site.

The 3D view provides building close-up and neighborhood views, nine current-view OpenStreetMap tiles, north and metric-scale cues, nearby service labels, and a checked proposal footprint. Supplied buildings with documented heights can be extruded; unknown heights stay flat. Tile/WebGL failures have fallback states. Street imagery and display heights do not participate in land-fit verification.

## Data and expected default results

The default SF study rectangle is `[-122.433, 37.758, -122.417, 37.776]` in west/south/east/north order. The building defaults to **24 × 18 × 12 m**, setback **3 m**, service distance **400 m**, and type **clinic**.

| Data | Scope, size, and provenance |
| --- | --- |
| [SF population and parks](../data/real/sf-parks-census.geojson) | 1,837,936 bytes (~1.84 MB); 244 population tracts and 226 selected park features. See its [manifest](../data/real/manifest.json). |
| [Raw facility download](../data/real-scenario/sf-osm-services-raw.json) | 34,310 bytes; 76 OSM elements in the query response. |
| [Normalized facilities](../data/real-scenario/sf-osm-services.geojson) | 41,358 bytes (~41.4 kB); 75 records after excluding one explicitly disused clinic: 21 clinics, 4 libraries, 34 schools, 16 community centers. |
| [Combined SF demo](../data/real-scenario/sf-mock.geojson) | 915,961 bytes; 1,085 features: 12 unchanged Census tracts, 75 mapped facilities, 7 simulated plots, 556 mapped building footprints, and 435 buffered road/footpath corridors. |

The facility query covers a neighborhood extract, **not the whole city**. Its source timestamp is **2026-05-06T03:25:00Z**, even though it was downloaded in September. OSM coverage and operating status may be incomplete or stale. Counts are mapped feature records, not a certified directory or a count of distinct architectural structures. Ways and relations use the center returned by Overpass; separate OSM elements may describe the same real facility. Attribution and ODbL terms are recorded in the [facility manifest](../data/real-scenario/sf-osm-services-manifest.json).

Observed default results:

| Metric | Verified value |
| --- | --- |
| Population weight across all 12 input tracts | 40,776 |
| Population weight assigned inside the rectangle | 37,351 across 11 representative points |
| Population weight outside the rectangle | 3,425 |
| Mapped facilities inside the rectangle | 12 clinics; 1 library; 13 schools; 7 community centers |
| Plot fit | 4 eligible out of 7; top 3 displayed |
| Ranked clinic plot IDs | `sfmock-fit-02`, `sfmock-fit-01`, `sfmock-fit-03` |
| Baseline clinic coverage within 400 m | 34,445 population weight; 2,906 outside |
| Additional coverage for the ranked clinic proposals | **2,906; 2,906; 0**, in rank order |

The first two alternatives add the same estimated population weight and are ordered by weighted mean distance; the third adds zero. A plot fitting the supplied constraints does not by itself establish a need for another clinic. Do not change data or verification just to produce a positive recommendation.

`existing_services_in_area` counts the selected facility type. `existing_service_counts` contains all four type counts. A service is counted when its projected geometry representative point is covered by the selected area, including boundary points. `service_features` remains the global matching-type inventory count used for baseline distances, including records outside the rectangle. `service_inventory` carries source/date/completeness. Missing records are not evidence of absence.

## Verification evidence

Last implementation checks, completed before this documentation update:

| Check | Recorded outcome |
| --- | --- |
| Full backend suite | **138 passed** in Linux with GIS dependencies; Starlette/HTTPX deprecation warning only. |
| Frontend suite | **30 passed** across App, map lifecycle, scene geometry, and viewer lifecycle/fallback tests. |
| Production build | Passed. Lazy Three.js bundle is ~609 kB minified; Vite reports its >500 kB size advisory. |
| Public deployment | Homepage and built JS/CSS returned 200; all four modes enabled; worker readiness returned `ok: true`; scenario dataset served 1,085 features. |
| Street texture request | Returned 200 with `Access-Control-Allow-Origin: *`; this is connectivity evidence, not visual verification. |
| Final live population job | `c956d92a615843b192f723ad47d10ae5`, completed, reference verified, one execution attempt. |
| Final live scenario job | `813e604c322449d79f6e9b686f6c1840`, completed and reference verified on attempt 3 after two bounded repairs. It returned four eligible plots and preferred `sfmock-fit-02`; every ranked candidate reported no building, road, or other restriction overlap. |
| Worker cleanup | No managed analysis containers remained after the job. Installed `scenario.py` and `scenario_program.py` matched the `55e8a63` repository checksums. |
| Public worker exposure | TCP 8100 was previously checked as unreachable on the worker's public address; worker communication uses the private VPC. |
| Final visual browser pass | **Not completed.** Browser runtime exits before navigation with `windows sandbox failed: helper_unknown_error: setup refresh had errors`. Reset/retry also failed. |

The deployment update rechecked public HTML, configuration, worker readiness, and the 1,085-feature dataset and ran the paid live scenario above. It did not rerun the whole test suite on the server; the recorded 138 backend and 30 frontend tests ran locally before deployment.

Local full run records and downloaded artifacts are in ignored `tmp/live-smoke/`, including `population-area.json`, `scenario.json`, result JSON/GeoJSON, analysis scripts, and traces. They are convenience evidence on this workstation, not a committed test fixture or a public API access grant. Guest-owned run endpoints require the original session or authorized operator access; do not assume another browser can fetch these IDs. Server run data is subject to retention limits. [VERIFICATION.md](../VERIFICATION.md) preserves older verification stages, which must not override this newer status.

## Deployment and operations

| Component | Current layout |
| --- | --- |
| Controller | Vultr VM serving the public HTTP URL through **Nginx**. Repository checkout: `/root/Geoscope`. |
| Controller container | Compose service `controller`, current container `deploy-controller-1`, image `geoscope-controller:local`; published on `127.0.0.1:8000`. FastAPI serves React's built assets; no separate Vite server runs in production. |
| Controller configuration | `/root/Geoscope/deploy/controller.env`; run data at container `/data` in the named `controller-data` volume. Preserve the existing secrets and volume. |
| Worker | Separate Vultr VM, private VPC HTTP endpoint on port 8100, systemd service `parkscope-worker`. No NetBird dependency. |
| Installed worker code | `/opt/parkscope/app`; environment `/etc/parkscope/worker.env`; venv `/opt/parkscope/venv`; service user `parkscope`. A repository pull alone does **not** update this installed code. |
| Sandbox | `parkscope-sandbox:local`, mandatory `runsc`, no network, non-root, read-only root/input, resource/output limits, cleanup verification. |
| Inference | Last deployed model: `deepseek-v4.1-flash`, called through Vultr Serverless Inference. Backend explicitly sets `reasoning_effort: "none"` for DeepSeek V4 models to avoid exhausting the output budget on reasoning. |

The [simple setup guide](VULTR_SETUP.md) describes a **fresh** Caddy/domain/HTTPS installation. The live instance currently uses Nginx and plain HTTP. Do not blindly rerun preparation scripts or replace the proxy on an existing host. Use [the advanced guide](VULTR_ADVANCED.md) for infrastructure changes.

For a normal controller code/frontend update, run in its existing checkout after reviewing any local changes:

```bash
cd /root/Geoscope
git status --short
git pull --ff-only
docker compose -f deploy/controller.compose.yaml up -d --build
docker compose -f deploy/controller.compose.yaml ps
docker compose -f deploy/controller.compose.yaml logs --tail=100 controller
```

For worker changes, compare the repository and installed modules first, account for local differences, and confirm no jobs are active. The supported full installer updates dependencies, sandbox image, installed code, and the service while preserving an existing environment file:

```bash
cd /root/Geoscope
git status --short
git pull --ff-only
sudo bash scripts/install-worker.sh
sudo systemctl status parkscope-worker --no-pager
sudo journalctl -u parkscope-worker -n 100 --no-pager
```

A small source-only fix can update the exact changed modules under `/opt/parkscope/app` with owner `root`, group `parkscope`, mode `0640`, then restart the worker; copy all affected dependencies together. The last reference update used this approach. Do not copy controller-only changes or overwrite unreviewed installed differences.

Worker readiness/preflight without printing environment contents:

```bash
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/worker-preflight.py'
docker ps --filter label=park-agent.managed=true --format '{{.Names}} {{.Status}}'
```

Public checks that do not start an inference job:

```bash
curl --fail http://149.28.204.217/ -o /dev/null
curl --fail http://149.28.204.217/api/worker-status
```

If the trusted sandbox **image build** again fails with PyPI name-resolution errors, follow the Step 4 recovery in the setup guide. Host-network image builds are supported only for that installation step; never grant runtime networking or fall back from gVisor to runc for agent jobs. Do not use `docker compose down -v` to update the application; it removes persistent run data.

## Development and verification commands

From the repository root, the [README](../README.md#quick-start-sf-mock-demo) contains the local fixed-reference demo commands. For separate development processes after configuring `.env`:

```powershell
# Terminal 1: configured FastAPI controller
.\.venv\Scripts\python.exe -m uvicorn app.controller:app --env-file .env --host 127.0.0.1 --port 8000

# Terminal 2: React/Vite; proxies /api to 127.0.0.1:8000
npm --prefix web run dev
```

Set `PUBLIC_ORIGIN=http://127.0.0.1:5173` for this Vite flow. Credentials stay in the backend environment; there is no token field in the UI. Do not leave development processes running after a test unless requested.

```powershell
npm --prefix web test
npm --prefix web run build
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
$env:APP_DATA_DIR = ".\local-data"
.\.venv\Scripts\python.exe -m pytest -q --basetemp=tmp/pytest-local
```

The last full backend suite used a Linux environment with Shapely and PyProj. This workstation's system Python 3.14 lacked PyProj; do not interpret missing GIS dependencies as application regressions. A local `geoscope-verification:local` Docker image was used for offline verification, but it is a workstation convenience and is not published or guaranteed on a new machine.

Rebuild the downloaded data without network, or deliberately refresh the small extract:

```powershell
# Recreate normalized records from the bundled raw response
python scripts/fetch_sf_osm_services.py --prepare-only
python scripts/generate_sf_mock_scenario.py

# Optional refresh: replaces the bundled service snapshot
python scripts/fetch_sf_osm_services.py
python scripts/generate_sf_mock_scenario.py
```

Review source dates, hashes, counts, and expected scenario results before committing refreshed data. The primary Overpass endpoint and other mirrors timed out during the last fetch; `overpass.private.coffee` returned the saved response. No live Overpass call is needed to run a deployed analysis.

## Code map and recent fixes

| Location | Responsibility |
| --- | --- |
| `web/src/App.jsx` | Task controls, readiness, polling, result cards, facility counts, invalidation, downloads. |
| `web/src/components/LeafletMap.jsx` | Layer styles/labels, selection, drawn rectangles, compare-pin locking, legends, resize handling. |
| `web/src/components/ScenarioViewer.jsx`, `web/src/scenario.js` | Checked-footprint scene, aligned street tiles, camera/scale, provenance, cleanup/fallbacks. |
| `app/controller.py` | API/auth orchestration, run inputs, Vultr calls, exact generation/repair contracts, saved artifacts. |
| `app/scenario_program.py` | Fixed scenario placement, baseline, facility counts, ranking, and result schema. |
| `app/reference.py`, `app/scenario_reference.py` | Trusted reference programs submitted to isolated execution. |
| `app/worker.py`, `app/sandbox.py` | Worker API, container isolation, reference comparisons, artifact validation, cleanup. |
| `app/access.py`, `app/datasets.py` | Signed guest ownership/origin checks and input/dataset validation. |
| `scripts/`, `deploy/`, `tests/` | Snapshot generation, installers/preflight, deployment examples, regression checks. |

Recent resolved failures: empty/truncated inference output, DeepSeek reasoning consuming the code budget, generated scripts assuming the wrong request wrapper or obstruction-layer name, missing sandbox `re` import, unhelpful worker errors, stale readiness/coordinate defaults, population mode requiring preloaded zones, and placement-grid ambiguity. The last placement failure used bbox edges instead of 5×5 **cell centers**. Generation and repair now specify `(col + 0.5) / 5` and `(row + 0.5) / 5`; the corrected live scenario passed without a repair.

The worker compares generated metrics and geometry to an independent fixed calculation. Keep generation/repair instructions synchronized with the reference schema; never loosen verification merely to pass incorrect generated output. A natural-language summary is model text and does not receive the same numerical/geometry guarantee.

## Remaining work and priorities

1. **Complete browser acceptance.** Restore the browser automation runtime first, then test the deployed release at desktop and narrow widths. Check population mode/drawing/run submission, plot labels and marker-to-card selection, selected-site zoom, both 3D camera views, tile fallback, compare-pin locking/result invalidation, and downloads. Inspect console errors and capture screenshots. Unit tests mock DOM/WebGL and cannot replace this pass.
2. **Finish domain/HTTPS deployment.** The current public URL is plain HTTP. Coordinate the existing Nginx setup and `PUBLIC_ORIGIN`; verify the final origin and guest session/write behavior after the change. Keep worker traffic private.
3. **Improve summary precision.** Saved LLM explanations sometimes call the entire hybrid dataset synthetic, describe observed facilities ambiguously, or include irrelevant scenario caveats in a population result. Structured metrics and source labels are the reliable output. Make prompts mode-specific and preserve per-layer provenance when refining summaries.
4. **Improve data quality for real planning.** Obtain observed parcels, obstruction coverage, availability/use evidence, and finer population units before claiming real constructibility or precise hyperlocal resident counts. OSM services alone do not validate land. Consider deduplicating facility records and checking status as a separate sourced task.
5. **Record a final demo/containment acceptance run.** Retain the checked artifacts and visual evidence for the deployed revision. Existing live jobs and cleanup passed, but this document does not claim a comprehensive security audit or that every historical adversarial probe was rerun against the latest deployment.

Preserve the existing React/FastAPI split, Vultr inference path, separate worker, strict sandbox checks, environment-only credentials, real facility attribution, and explicit simulated-land labels. The authorized development workflow used a Luna-high executor with an Astra-xhigh advisor; that workflow does not grant permission to message other user chats or expose credentials.
