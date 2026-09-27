# Geoscope application handoff

Recorded September 27, 2026. Tested and deployed **application commit `1191c38`** on `main`; documentation commits may be newer.

## Start here

- Public application: [Geoscope](http://149.28.204.217/).
- Repository: [thesid42/Geoscope](https://github.com/thesid42/Geoscope), public.
- React/Vite, FastAPI, Leaflet, Three.js, Vultr Serverless Inference, a separate worker and gVisor containers over a private Vultr VPC. No NetBird integration.
- Default workflow: **Design & compare**. Choose an area and facility; the agent searches a building layout and reports reserved open space and walking outcomes. Use Before/After to switch the map and 3D scene.
- Backend/frontend tests, production build, real gVisor checks and two live agent runs passed. **Visual browser acceptance remains outstanding** because automation fails before navigation.
- Secrets stay in the existing server environment files. Do not put passwords, provider keys, worker tokens or app secrets in Git.

## Implemented behavior

| Workflow | Inputs and outcome |
| --- | --- |
| Design & compare (`scenario` with `design`) | Area, facility, floor-area goal, maximum floors, open-space target, setback and walking budget. Agent selects a bounded strategy, searches placements/proportions/rotations/floors, then submits up to 12 designs. A fresh sandbox independently recomputes them; up to three checked alternatives appear. |
| Fixed-footprint scenario (`design` omitted/null) | Existing width/depth/height/setback workflow remains compatible; checks source land and obstacles and ranks eligible plots. |
| Population estimate (`exposure`) | Estimates whole Census weights whose projected representative points fall in the drawn area. |
| Nearby services (`access`) | Straight-line proximity to supplied services. |
| Compare locations (`compare`) | Compares A/B against the supplied service inventory. |

All four API modes remain enabled. The local `verification/scenario_demo_server.py` supports scenarios using fixed calculations only; it does not call an LLM or claim cloud containment.

### Agent design and walking

Defaults are **900 m2 gross floor area, at most 3 floors, 40% connected usable open space, 3 m setback, and a 10-minute walk at 1.2 m/s**. Supported facility types are clinic, library, school and community center. Park proximity remains an access/compare workflow.

The agent chooses `balanced`, `open_space` or `low_rise` from the analyst question. Structured goals cannot be weakened by the question or generated script. Every footprint plus setback must fit the supplied parcel/area and avoid supplied buildings, road corridors and restrictions. Open reserve must be on the same connected unobstructed land component as the building; a 4 m geometric-width proxy removes narrow fragments. The percentage denominator is the whole source parcel. This is reserved land, not a measured carbon, energy, permeability or planning certification.

Designs rank by mapped-service gap, then usable open-space percentage, then plot ID. These are the best submitted alternatives, not a global optimum. Walking outcomes are shown separately so a geometrically valid site can still show no access benefit. No submitted design does not prove that all possible buildings are infeasible.

The before/after calculation uses the same population origins on an offline pedestrian graph. Network connectors and facility entrances are inferred. Known unchanged origins remain in the comparable cohort, missing baseline stays unknown, and unsupported network coverage reports unavailable. The UI exposes the compared/unmatched population, walking times, coverage, source dates and assumptions. Input edits clear stale results.

See [DESIGN_SIMULATION.md](DESIGN_SIMULATION.md) for the full API contract, geometry checks, search limits and verification boundary.

### Map and 3D scene

Ranked Site 1/2/3 markers select matching result cards. The selected plot has its own color; only its proposed building and open reserve appear in After. Before hides the proposal and retains the surrounding context. Population-point colors and example routes change with the selected phase. The 3D mass uses the verified footprint, candidate-specific height/floors, and highlighted open reserve.

Existing street tiles, mapped buildings/services, north and approximate metric-scale cues remain. Unknown surrounding building heights stay flat; imagery does not participate in land verification. Tile/WebGL failures have fallback states. No browser visual inspection of this release has been completed.

## Data and expected default results

| Data | Current scope |
| --- | --- |
| SF scenario (`localdemo`) | 1,247 features: 12 observed Census tracts, 75 mapped OSM facilities, 7 simulated plots, 690 mapped building footprints and 463 buffered road/footpath corridors. Candidate land is simulated. |
| East Harlem (`nycland`) | Official MapPLUTO vacant-classified lots, supplied buildings/streets, Census population and FacDB facilities. Source vacancy/use declarations do not establish current availability, ownership or permission to build. |
| SF walking snapshot | 20,834 nodes / 25,969 edges; OSM source timestamp 2026-05-06T03:25:00Z. |
| East Harlem walking snapshot | 28,427 nodes / 35,594 edges; OSM timestamp 2026-09-27T15:50:06Z. |

Both pedestrian extracts have roughly 850 m rectangular buffers. The runtime checks the actual available buffer for the requested walking budget. Preparation dates, exact bounds, hashes, filters, ODbL attribution and refresh commands are in [data/walk](../data/walk/README.md). Offline runtime needs no Overpass access. The SF source is older than its September download date.

Default areas: SF `[-122.433, 37.758, -122.417, 37.776]`; East Harlem `[-73.955, 40.790, -73.930, 40.812]`, west/south/east/north. SF's selected area contains 12 mapped clinics, 1 library, 13 schools and 7 community centers. Counts are mapped records, not a certified directory. Missing inventory does not prove absence.

The SF parks/Census and five-borough NYC parks/facility datasets remain available for basic access/population/compare tasks. Walking snapshots attach only to their matching bundled land scenario. Uploaded datasets without a trusted staged network retain design results with walking explicitly unavailable.

## Verification evidence

- **194 backend tests passed** on Python 3.12 with GIS dependencies; **50 frontend tests passed**; production build passed. Existing Starlette/HTTPX deprecation and Three.js bundle-size advisories remain.
- Both cities passed `verification/design_sandbox_smoke.py` in real worker gVisor containers, including independent verification. Fixed-script SF took 4.39 seconds and NYC 9.39 seconds. This checks containment/integration, not model decision-making.
- Live SF library run `bf968aac0ac245c78f50922a8e87248b`: first attempt, agent chose `balanced`; preferred design has 3 floors and 77.8% connected reserve. Modeled coverage rose from 6,530 to 14,687 population weight; mean walk fell from 12.856 to 11.550 minutes.
- Live NYC clinic run `048da08b633e4d168dff41838d25fd43`: first attempt, agent chose `low_rise`; preferred design has 2 floors and 79.7% reserve. Coverage and mean time remained unchanged. Another checked alternative reduced mean time from 4.062 to 3.878 minutes with no additional coverage.
- Both live outputs are reference verified with `verification_kind: submitted_design_recomputed`. JSON, GeoJSON, script and trace downloads passed; public HTML/JS/CSS and worker readiness passed; no `park-agent.managed=true` containers remained.
- Installed worker Python modules match the release checkout. Controller and worker environment files, proxy and persistent volume were preserved.
- Browser automation exits during Windows sandbox initialization before a page opens. DOM/geometry tests do not establish actual rendered appearance.

Ignored local evidence: `tmp/live-smoke/design-sf*` and `design-nyc*`. These session-owned run IDs are not public artifact links. Whole Census weights are coarse estimates, not exact resident counts or predicted facility demand. [VERIFICATION.md](../VERIFICATION.md) keeps historical checks separately.

## Deployment and operations

| Component | Current layout |
| --- | --- |
| Controller | Vultr VM 149.28.204.217, public HTTP through Nginx; checkout `/root/Geoscope`. |
| Controller container | `deploy-controller-1`, image `geoscope-controller:local`, port `127.0.0.1:8000`; FastAPI serves the compiled React app. |
| Controller configuration | `/root/Geoscope/deploy/controller.env`; persistent `/data` is the named `controller-data` volume. |
| Worker | Vultr VM 140.82.51.227; private VPC endpoint on 8100; systemd `parkscope-worker`. |
| Installed code/config | `/opt/parkscope/app`, `/opt/parkscope/venv`, `/etc/parkscope/worker.env`; service user `parkscope`. A git pull alone does not update installed code. |
| Sandbox | `parkscope-sandbox:local`, mandatory gVisor/runsc, no network, non-root, read-only root/inputs, bounded resources/output and verified cleanup. |
| Inference | Vultr Serverless Inference; deployed DeepSeek configuration remains server-side. |

Both worker and controller need the new toolkit. The controller image includes `data/walk`; worker changes include `simulation_program.py`, `simulation_runtime.py`, `walking.py`, `sandbox.py` and `reference.py`. Existing sandbox Shapely/PyProj dependencies are sufficient. Previous installed worker code was backed up at `/root/geoscope-release-backup-1191c38/app`.

For an existing controller update, first account for local changes:

```bash
cd /root/Geoscope
git status --short
git pull --ff-only
docker compose -f deploy/controller.compose.yaml up -d --build
docker compose -f deploy/controller.compose.yaml ps
```

For worker updates, compare installed modules and confirm no active jobs. The full installer preserves an existing environment file:

```bash
cd /root/Geoscope
git status --short
git pull --ff-only
sudo bash scripts/install-worker.sh
sudo systemctl status parkscope-worker --no-pager
```

A reviewed source-only update may copy all affected modules together as `root:parkscope`, mode `0640`, and restart the worker. Keep unreviewed installed changes and existing secrets intact.

```bash
sudo -u parkscope bash -c 'set -a; source /etc/parkscope/worker.env; set +a; /opt/parkscope/venv/bin/python /opt/parkscope/scripts/worker-preflight.py'
docker ps --all --filter label=park-agent.managed=true --format '{{.Names}} {{.Status}}'
curl --fail http://149.28.204.217/api/worker-status
```

The [simple setup guide](VULTR_SETUP.md) describes a fresh installation. Do not replace the existing Nginx proxy or delete the run volume when updating. Host-network image builds are an installation DNS workaround only; agent containers must remain network-disabled. A domain and HTTPS remain outstanding.

## Development and verification commands

Use [README quick start](../README.md#quick-start-local-scenario-preview) for the single-process fixed-reference preview. Separate development servers require configured backend environment values:

```powershell
# Terminal 1
.\.venv\Scripts\python.exe -m uvicorn app.controller:app --env-file .env --host 127.0.0.1 --port 8000
# Terminal 2
npm --prefix web run dev
```

For Vite, set `PUBLIC_ORIGIN=http://127.0.0.1:5173`. Credentials stay in the backend environment. No local application servers were left running after this release.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
$env:APP_DATA_DIR = ".\local-data"
.\.venv\Scripts\python.exe -m pytest -q --basetemp=tmp/pytest-local
npm --prefix web test
npm --prefix web run build
```

The workspace now has Python 3.12 in `.venv` with GIS dependencies. System Python 3.14 lacks those packages; use the venv. On the Linux worker, run `python -m verification.design_sandbox_smoke sf nyc` from a prepared checkout to repeat fixed-script gVisor integration.

## Code map and remaining work

- `app/controller.py`: binds authoritative inputs/snapshots, calls Vultr, handles bounded repair and saves artifacts.
- `app/simulation_program.py`: bounded design search, geometry/reserve checks and verified outcomes.
- `app/walking.py`: offline graph, same-cohort walking metrics, route/sample output and unknown-data handling.
- `app/simulation_runtime.py`: model toolkit contract, proposal allowlist and trusted loader.
- `app/sandbox.py`: isolated execution and fresh independent recomputation of submitted designs.
- `web/src/App.jsx`, `scenario.js`, `components/LeafletMap.jsx`, `components/ScenarioViewer.jsx`: goals, outcomes, selection and Before/After display.
- `scripts/fetch_walk_networks.py`, `data/walk`: controlled data refresh and provenance.

Remaining work: browser acceptance at desktop/narrow widths; domain/HTTPS; finer population and verified entrances/access, land-use and availability evidence for real planning. New requests should preserve containment, environment-only credentials, explicit simulated-land labels and measured-versus-assumed distinctions. A natural-language explanation remains model text; structured geometry and metrics receive independent verification.
