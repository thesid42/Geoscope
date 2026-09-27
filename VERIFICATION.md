# Verification record

## Current deployment snapshot (2026-09-26 Pacific / 2026-09-27 UTC)

The latest application release, `55e8a63`, is deployed on Vultr. **138 backend tests, 30 frontend tests, the production build, and live population/scenario analyses passed**. Live scenario run `813e604c322449d79f6e9b686f6c1840` was reference verified on its third bounded execution attempt after two generated-script repairs. The 1,085-feature scenario dataset includes 75 observed OSM facility records, 556 mapped building footprints, 435 buffered road/footpath corridors, real Census population, and simulated candidate land. Public assets and worker readiness were checked, installed worker module hashes matched the repository, and managed sandbox containers were cleaned up.

**The revised UI and street-context 3D view still need visual browser acceptance.** Browser automation exits during Windows sandbox initialization before navigation. The public deployment currently uses HTTP through Nginx; domain/HTTPS is outstanding.

See [the handoff](docs/HANDOFF.md#verification-evidence) for run IDs, commands, provenance, limits, and remaining work. Everything below is a **historical record** of earlier revisions; statements that deployment was pending, older test totals, and fully synthetic service fixtures describe those earlier checks.

## Private VPC deployment update (2026-09-26)

- Removed the VPN integration scripts, installation steps, policy tests, and service dependency. The worker now uses `WORKER_BIND_IP` and a Python startup preflight that requires an assigned RFC1918 IPv4 address, Docker, gVisor, the sandbox image, and a worker token.
- Full backend regression: **107 passed in Linux**, using a temporary source copy and the existing local dependency images with network disabled. **62 focused checks passed on Windows**. The system Windows Python lacked `pyproj`, so the full suite ran in Linux.
- Eight offline mocked preparation checks passed for both roles and failure guards; neither preparation path invokes the removed VPN client. Four mocked installer checks passed for default/host build networking, invalid settings, and failure before service installation. Deployment shell syntax, embedded Python, and 15 documentation links/anchors passed.
- The retained `SANDBOX_BUILD_NETWORK=host` option affects only the trusted image build. Analysis runtime network isolation remains covered by the sandbox contract tests. No browser checks or application servers were started; no remote VM, firewall, or client was changed. Live VPC/firewall, inference, and gVisor acceptance checks remain pending.


This file records checks actually performed. A passing test using mocked infrastructure does not demonstrate that cloud deployment or sandbox containment works.

## Hyperlocal land scenarios — 2026-09-26

- **15 frontend tests passed**, including token-free HTTP requests, scenario-only mock startup/submission, checked mock 3D eligibility, stale-result invalidation, safe map tooltips, and real Three.js footprint geometry construction. The production build passes; the lazy Three.js chunk has the standard >500 kB bundle-size advisory.
- **99 backend tests passed** on Windows: parcel/area/setback containment, obstructions, holes and MultiPolygon gaps, rotated buildings, typed service filtering, deterministic rankings, tampered footprint/evidence rejection, strict area limits, signed cookies, CSRF, cross-guest isolation and owner recovery in a fresh process.
- The actual SF fixture yields four eligible plots out of seven for the default 24 × 18 m footprint with a 3 m setback; modeled building-blocked, restricted and undersized plots are excluded. At 100 × 100 m no plot qualifies. Twelve unchanged 2020 population tracts are observed inputs; land and service features are simulated with separate provenance.
- `verification/scenario_http_smoke.py` exercised live loopback HTTP requests for clinic and library proposals, downloads and maps, cross-guest denials and missing-Origin rejection. Output is saved in `verification/scenario-smoke.json`; this is an explicitly labeled local fixed-reference mock, not an LLM or cloud run.
- `verification/scenario_reference_smoke.py` passed in the pinned Python 3.12 / Shapely 2.0.7 / PyProj 3.7.0 image with no network and read-only mounts. Rankings, areas, setbacks and large-footprint exclusions match host results. Only fixed trusted code executed under runc; this is dependency validation, not gVisor containment evidence.
- The UI access-key field and bearer storage/header flow were removed. APP_ACCESS_TOKEN, provider keys and worker credentials stay server-side. Public browser use requires environment opt-in and uses HttpOnly signed guest sessions; this is intentionally public guest access with ownership isolation, not a private login system.
- The final multi-stage Docker build passed from the npm lockfile. Packaged HTTP smoke served the React entrypoint, CSS, and lazy Three.js viewer chunk under a read-only, non-root, no-network runtime; unconfigured live analysis remained disabled.
- No browser checks were performed. Three.js visual appearance and GPU rendering were not inspected in a browser. Live Vultr/gVisor/private-network verification remains pending infrastructure.

## React migration — 2026-09-26

- Frontend converted to React 19.3 with Vite 8.3; Leaflet is bundled through npm. FastAPI remains the backend. The lockfile is committed; node_modules and dist are excluded from Git.
- Clean npm install, production build, and **9 Vitest/Testing Library tests passed**. Tests use a simulated DOM and a mocked Leaflet adapter. They cover request cancellation, pending submission controls, normalized authentication, null metrics, error states, map lifecycle, and safe popup text. Advisor independently reran the same 9 tests and found no blocking findings.
- **40 backend tests passed on Windows and Linux**, including three new frontend-serving tests: API availability before building, entrypoint caching, and compiled-asset lookup/source isolation. Python discovery is restricted to tests/ so it does not traverse Node dependencies or temporary output.
- The final multi-stage Docker image built successfully from the lockfile. The Python runtime contains compiled frontend assets; the Node build environment stays in the build stage.
- `verification/frontend_smoke.py` passed against the actual packaged app with no network and a read-only root: generated JavaScript/CSS URLs returned 200, raw source/package paths returned 404, and existing configuration/data APIs remained available. The 470-feature official dataset is intact. The only Linux test warning was Starlette's existing TestClient HTTPX deprecation.
- **No browser checks were performed for this migration**, as requested. Earlier browser checks and the stored screenshot below describe the previous static frontend. Live Vultr, gVisor, and private-network checks remain pending.

## Environment inspected

- Workspace: E:\Projects\Agent Arena, Windows/PowerShell.
- System Python 3.14: FastAPI, Uvicorn, HTTPX, Pydantic, pytest present.
- Docker Desktop 4.53.0, Linux engine 29.0.1 reachable through an approved read-only inspection.
- Docker runtimes: runc and nvidia; runsc/gVisor is absent.
- No cloud-deployment configuration found among relevant environment variable names during those earlier checks. Unrelated credentials were not used.

## Initial implementation test suite (before React migration)

- Final suite: **37 passed on Windows and 37 passed on Linux** on 2026-09-26. Covers controller HTTP behavior, bounded agent repair with mocked services, malformed/nonfinite data, reference verification, worker configuration/cleanup, and the former VPN policy management (since removed).
- Windows used Python 3.14 and workspace-local pytest temporary directories. Linux used Python 3.12 with FastAPI 0.141.1, Starlette 1.7.0, HTTPX 0.28.1, and Pydantic 2.13.5 in the controller image. The only Linux warning was Starlette's TestClient HTTPX deprecation.
- No unit/integration test contacted a real inference provider or changed a real VPN policy. Full real geometry calculations and artifact-plumbing checks are listed separately below.

## Completed checks

- Built `parkscope-sandbox:local` from `Dockerfile.sandbox` successfully using Python 3.12, Shapely 2.0.7, and PyProj 3.7.0.
- Ran a fixed, trusted Linux library smoke check in that image: a 0.001-degree northward displacement near San Francisco measured 110.951 metres in UTM zone 10. Imports and numeric expectation passed. This used runc for packaging verification only; no agent-generated code was executed.
- Independently checked all three official source-file SHA-256 hashes against the real-data manifest, unique feature IDs, 244 population tracts, 226 selected park geometries, and total 2020 population 873,965.
- Review findings were fixed: structural and nonfinite input validation, artifact permissions/storage bounds, Docker security-option normalization, cleanup diagnostics, and a quarantine latch that refuses subsequent work after unconfirmed cleanup. Regression checks pass. An actual disposable Docker inspection confirmed the `no-new-privileges` spelling; both true spellings are accepted and false is rejected.
- Built `geoscope-controller:local` and exercised its actual packaged application under Linux as UID 10001, with a read-only root, no network, and bounded writable `/data` and `/tmp`. The GeoScope page, 470-feature official dataset, and disabled unconfigured-analysis state passed.
- `verification/reference_smoke.py` independently checked known distances, weighted access, candidate ranking, overlapping-zone union membership, and zero-population handling against the fixed reference code. All passed in the Linux dependency image. This was not a live agent run.
- Advisor ran `verification/extractor_smoke.py`: six actual Linux artifact-plumbing checks passed, including a >1 MiB round trip and rejection of symlink, hardlink, FIFO, oversized single file, and oversized combined outputs. See `verification/extractor-smoke.json`. These checks used runc explicitly and do not establish gVisor containment.
- Historical VPN policy tests passed (9 of the then-37 tests; these obsolete tests are now removed), including official API-shaped group references, failed-verification behavior, and two-stage policy reuse/disable. API traffic is mocked; no real account policy was changed.
- Python syntax compilation and JavaScript syntax checks passed. Both shell deployment scripts passed Linux `bash -n`, and Docker Compose parsed with the supplied example configuration.
- Final controller image rebuild and packaged startup smoke passed after advisor signoff: UID 10001, read-only root, no network, 470 official dataset features, and analysis disabled when services are unconfigured.
- Browser preview verified San Francisco and synthetic datasets, map rendering, correct dataset-specific candidate coordinates, three mode selections, conditional controls, the source-manifest link, and the disabled unconfigured run state. A 390-pixel responsive check showed no horizontal overflow; no JavaScript errors were recorded. Initial dataset-loading race and hidden-control CSS defects were fixed.
- Advisor verified that the API result and downloadable JSON contain the same checked metrics envelope, without extra unverified model headlines or claims. Natural-language summaries are model text; numerical/map verification is the fixed-reference check.
- Final advisor review found no remaining blocking implementation findings. Live infrastructure checks remain pending below.

- The explicitly labeled `verification/ui_fixture_server.py` drove the real controller/UI with fixed substitute worker and model responses. Access, candidate comparison, zero-population `N/A`, and success-to-failure clearing passed. Artifact HTTP delivery returned 200, and one actual downloaded JSON file matched its fixture. The browser automation's download-event wait timed out despite that file being saved; repeated download events were not reliable. These are UI checks only, not live inference or containment evidence.
- Final UI changes guard dataset readiness and stale map responses, delay revoking download URLs, and display download errors. JavaScript syntax and the final keyboard run passed after these changes. The fixture was stopped after QA; it is separate from production and must stay on loopback.
## Simplified deployment setup (2026-09-26)

- The new `scripts/prepare-vultr.sh` and all 35 Bash command blocks in the short/advanced guides passed syntax checks; three embedded Python snippets parsed and 16 local links/anchors resolved.
- Eight checks passed in a disposable offline container with package/service commands mocked: controller and worker preparation, invalid-role rejection, unsupported-OS rejection, non-root rejection, preservation of existing containers, package failure, and failed gVisor probe handling.
- These checks did not install packages on a Vultr VM, start application servers, enroll VPN peers, or prove live gVisor execution. The deployment acceptance checks below remain required.

## Requires actual deployment

- Live inference with a model available to the user's Vultr account.
- Real gVisor job execution, blocked outbound networking, immutable inputs, enforced timeout/resource limits, and cleanup.
- VPC host firewall permits the controller and denies other hosts; worker binds only its assigned private address.
- Public HTTPS URL, end-to-end analysis, and recorded containment demo.

## Review protocol

The executor implements and tests; the advisor reviews the trust boundaries and correctness; the primary agent checks the user-facing application independently. Findings are fixed and relevant tests rerun. Final reporting will identify unavailable live checks explicitly.
