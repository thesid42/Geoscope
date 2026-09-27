# Geoscope

Geoscope is a geospatial analysis app built with **React, FastAPI, Leaflet, and Three.js**. Select a local area, propose a clinic or library, compare candidate plots, and inspect the proposed building in 3D. Land checks cover the whole building footprint, setbacks, plot boundaries, and supplied obstacles before a site is ranked.

The San Francisco demo combines **real Census population and mapped OpenStreetMap facilities, building footprints, and road corridors with simulated candidate plots**. The live application uses **Vultr Serverless Inference, gVisor sandboxes, and a Vultr VPC**. A separate local demo runs fixed-reference calculations without an LLM or cloud worker.

## Current status

The application is deployed at **[Geoscope](http://149.28.204.217/)**. The last verified application release is `55e8a63` (September 26, 2026 Pacific / September 27 UTC).

- All four analysis workflows are enabled on the live controller. Population estimation accepts a drawn area without preloaded zone polygons.
- The interface labels plot boundaries and selected sites, puts outcomes first, and includes street context, service markers, scale, and camera controls in the 3D view.
- Proposal results report mapped facilities already inside the selected area and explicitly identify zero added population coverage.
- Last recorded verification: **138 backend tests, 30 frontend tests, production build, and live population/scenario jobs passed**. The road/building-aware scenario run matched the fixed GIS reference on its third bounded execution attempt.
- **Final visual browser testing is still outstanding.** Browser automation crashes during Windows sandbox initialization before opening the site. DOM/geometry tests and API checks do not establish rendered appearance.
- The current public endpoint uses **HTTP through Nginx**. A domain and HTTPS are still deployment follow-up work.

Start with the **[application handoff](docs/HANDOFF.md)** for deployment paths, verified results, known limitations, and the next work to do. The [verification log](VERIFICATION.md) also retains historical results.

## What you can do

| Workflow | Result |
| --- | --- |
| Facility scenario | Select an area, choose a clinic, library, school, or community centre, and rank up to three eligible plots with a 3D building preview and a verified explanation of each site's land fit, coverage, and ranking. |
| Service access | Estimate population proximity to supplied facilities. |
| Candidate comparison | Compare two proposed locations against an existing service network. |
| Population in an area | Draw a rectangle and estimate population inside it; programmatic requests can also use supplied zone polygons. |

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
2. Use **Draw area on map** to mark two opposite corners, or edit the coordinate bounds.
3. Choose a facility type, optionally adjust building size and clearance, then run the analysis.
4. Select **Site 1**, **Site 2**, or **Site 3** in the results or on the map. Use **Zoom to selected site** for its plot and checked footprint.
5. Switch the 3D view between **Building close-up** and **Neighborhood context** to see the proposal against street imagery, a north arrow, approximate metric scale, and supplied nearby services.
6. Inspect rejected plots and download the calculation artifacts. Changing scenario inputs clears the old result and requires another run.

With the default 24 × 18 m footprint and 3 m setback, **four of seven modeled plots qualify**. The other plots conflict with a mapped building, conflict with a buffered mapped road corridor, or are too small. A 100 × 100 m footprint fits none of them.

The default selected area contains **12 mapped clinics, 1 library, 13 schools, and 7 community centers** in the downloaded inventory. At a 400 m threshold, the first two ranked clinic alternatives each add an estimated population weight of **2,906**; the third adds **zero**. These are independent alternatives using representative-point and straight-line-distance proxies, not verified need or resident counts.

### Data provenance and local execution

| Data or execution | Local SF demo |
| --- | --- |
| Population | 12 unchanged observed 2020 Census tracts from the bundled SF snapshot. |
| Candidate plots | Explicitly simulated rectangles placed at SF coordinates; no ownership or availability claim. |
| Buildings and roads | Bounded OSM way snapshot around the seven plots; road centerlines use tagged widths or documented class defaults to form exclusion corridors. |
| Existing facilities | 75 mapped OpenStreetMap records in a local SF extract; source snapshot dated 2026-05-06. Coverage and operating status are not certified. |
| Land checks | Computed containment, setbacks, declared permitted uses, and collisions against the modeled land inventory. |
| Analysis execution | Fixed trusted local calculations; no LLM, generated-code execution, cloud worker, or gVisor. |
| Real-world availability or permits | Not established by the mock. |

The map uses a blue dashed study boundary, purple candidate plots, a teal selected plot, orange checked building footprints, gray supplied building records, and red restrictions. Map labels match the ranked site cards.

The [downloaded SF facility GeoJSON](data/real-scenario/sf-osm-services.geojson) is **41,358 bytes (41.4 kB)**: 21 clinics, 4 libraries, 34 schools, and 16 community centres across the extract. The original response is **34,310 bytes**; one explicitly disused clinic was excluded. Counts within a selected rectangle will differ. The combined census + simulated land + mapped context demo is **915,961 bytes** and contains 1,085 features. Its compact land-context snapshot contributes 556 mapped building footprints and 435 buffered road/footpath corridors near the seven candidate plots. See the source manifests for query dates, hashes, methods, limitations, and ODbL attribution. Refresh deliberately with the two `fetch_sf_osm_*.py` scripts, then regenerate the scenario fixture.

The 3D scene uses the checked footprint on flat ground. It loads only nine public OpenStreetMap tiles for the current view, with attribution and normal browser caching. Those tile pixels remain display-only; collision checks use the bundled vector building/road snapshot, not imagery. Unknown building heights stay flat and street tile failure preserves the supplied geometry. Height affects its appearance; width, depth, and setback affect site eligibility and placement. See [SF mock provenance](data/real-scenario/README.md) and its [manifest](data/real-scenario/manifest.json).

### Stop the app

Press **Ctrl+C** in the demo terminal. This stops both the API and the served frontend. When using separate FastAPI and Vite development terminals, press **Ctrl+C in each terminal**. Stop a Compose controller with:

```powershell
docker compose --file deploy/controller.compose.yaml down
```

## Production architecture

The live workflow is: **React → FastAPI controller on Vultr → Vultr Serverless Inference → private worker over Vultr VPC → disposable gVisor container → verified results**.

The controller plans, generates analysis code, and makes bounded repair attempts. The separate worker executes generated code and a fixed GIS reference in isolated containers, compares their metrics and geometry, and returns checked artifacts. Sandboxes have no outbound network, read-only input, resource limits, bounded output, and verified cleanup. The worker refuses execution without the required `runsc` runtime; the private VPC connects the trusted hosts and does not replace sandbox isolation. Provider keys and access tokens never enter analysis containers.

The Dockerfile builds React in a Node stage and copies only compiled assets into the FastAPI runtime. The mock server is a separate development entry point, not a fallback when production infrastructure is unavailable.

## Environment configuration

There is **no API-token field in the UI**. Provider and worker credentials stay in the backend environment. `APP_ACCESS_TOKEN` signs opaque HttpOnly guest cookies and also supports private programmatic bearer access; its value is never sent to React.

| Variable | Purpose |
| --- | --- |
| `VULTR_SERVERLESS_INFERENCE_API_KEY` | Backend inference credential. |
| `VULTR_MODEL_ID` | Exact model ID available in the account's Vultr catalog. |
| `WORKER_URL` | Worker URL on its private VPC address. |
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

Scenario datasets also require top-level `land_inventory` with a `source`, ISO `as_of` date, and `building_coverage`, `road_coverage`, and `restriction_coverage` set to `complete_for_candidate_sites`. These are supplied declarations, not independent certification of ownership or permission. Missing obstruction coverage is not assumed clear. The [SF fixture](data/real-scenario/sf-mock.geojson) provides a complete worked input; regenerate it with `python scripts/generate_sf_mock_scenario.py`.

Scenarios accept at most 5,000 features and 100 candidate plots. Each selected-area side must be 20 m–10 km. The search tries up to 81 deterministic anchors per plot at 0°/90°, checking the entire footprint plus setback against the plot, selected area, buildings, mapped road corridors, and other restrictions. It ranks one placement per eligible plot by added population proximity, then weighted mean distance, then site ID. Alternatives are independent proposals. No fit found by this bounded search does not mean that every possible placement is impossible.

The result also reports **Already in this area**: counts of supplied clinic, library, school, and community-center records whose projected geometry representative point falls inside the selected boundary (boundary points count). `existing_services_in_area` is the selected type's count; `existing_service_counts` provides the breakdown. `service_inventory` records source, date, and completeness. Missing metadata is unknown coverage, and zero mapped records never proves that no real facility exists. These are facility records, not a count of distinct architectural structures.

Population analysis accepts `study_area` without pre-existing zones. That rectangle replaces any dataset zones for that run, is saved in the request artifact, and goes through the same isolated agent and fixed-reference verification. The source dataset stays unchanged. Whole population weights are assigned by projected representative point, so estimates are coarse at small scales.

Only matching typed services count toward a scenario baseline, including services outside the selected area. Missing matching inventory means unknown existing access, not verified absence. Distances are straight-line metres in a local projected CRS; routes, terrain, capacity, and travel barriers are not modeled. Whole-tract population allocation is coarse for hyperlocal analysis and is not an exact count of nearby residents.

The UI starts at a 400 m access threshold; the API default is 800 m. General uploads use the configured size/feature limits (20 MiB by default). Bundled data endpoints are `/api/datasets/demo`, `/api/datasets/real`, and `/api/datasets/localdemo`. The original SF parks/Census snapshot remains separate; see [its provenance](data/real/README.md).

## Deployment

Follow the **[six-step Vultr setup](docs/VULTR_SETUP.md)**. One preparation command per VM installs the required packages; the guide covers Vultr VPC, configuration, HTTPS, and live checks. Detailed installation steps and troubleshooting are in the [advanced reference](docs/VULTR_ADVANCED.md).

The current controller serves the built React frontend and FastAPI API behind **Nginx**, with the container bound to `127.0.0.1:8000`. The setup guide describes a fresh domain/HTTPS installation with Caddy; it is not a description of the current HTTP proxy. Preserve the existing proxy when updating the deployed app. See the [handoff](docs/HANDOFF.md#deployment-and-operations) for current update and log commands.

The separate worker listens on its VPC address and executes generated code in disposable gVisor containers. NetBird is no longer part of the application. Keep the worker dedicated because its Docker access grants control of that host. Live verified analysis and sandbox cleanup have been checked; HTTPS and the final visual acceptance pass remain outstanding.

## Verification and project status

Latest recorded checks for `8f8143c`: **137 backend tests (Linux)**, **30 frontend tests**, the Vite production build, controller rebuild, public asset delivery, worker readiness, and two real Vultr agent workflows passed. Frontend tests use a simulated DOM; Three.js geometry and resource cleanup are tested with a mocked WebGL renderer. The final street-context view and revised UI still need a working-browser acceptance pass. See the [handoff evidence](docs/HANDOFF.md#verification-evidence) and [verification log](VERIFICATION.md).

These counts record the last implementation checks, not tests rerun for a documentation-only update.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
npm --prefix web test
npm --prefix web run build
$env:APP_DATA_DIR = ".\local-data"
.\.venv\Scripts\python.exe -m pytest -q --basetemp=tmp/pytest-local
```

With the mock server already running on port 8765, `python verification/scenario_http_smoke.py` checks clinic/library runs, rejected oversized footprints, downloads, and guest isolation without opening a browser.

The SF demo and live Vultr workflow are implemented and deployed. The highest-priority follow-ups are a visual browser pass, HTTPS, more precise population inputs, and observed parcel/obstruction data before making real land-availability claims. [HANDOFF.md](docs/HANDOFF.md) is the current status reference; [PLAN.md](PLAN.md) and older sections of [VERIFICATION.md](VERIFICATION.md) are historical context.
