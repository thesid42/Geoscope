# GeoScope implementation plan

Build a web GIS analyst that answers spatial questions by writing and running analysis code in disposable sandboxes on Vultr. Parks are one demo, not the product boundary. NetBird connects trusted backend hosts; it does not replace the sandbox. This plan uses only this conversation, supplied track material, and fresh technical references.

## Accepted scope update

The user asked to generalize beyond finding or proposing parks during implementation. The shared execution pipeline will support three bounded workflows:

- Service access: distance from population areas to supplied facilities or service locations, with a configurable access threshold.
- Candidate comparison: compare two proposed facility locations against the existing service network.
- Zone coverage: estimate population represented by points inside supplied zones (for example, user-provided risk or planning boundaries). Representative-point membership is explicitly an approximation, not a prediction or exact count of affected residents.

Use generic population/service/zone roles; accept existing park inputs as an alias. Keep the official SF parks/census snapshot and clearly labeled synthetic scenarios for reproducible demos. Do not label fabricated zones as official hazard data.

## Team and workflow

- Executor: GPT-6 Luna, high reasoning — implementation and fixes.
- Advisor: GPT-6 Astra, extra-high reasoning — architecture, security review, acceptance review.
- Coordinator: primary chat — requirements, independent verification, integration, and progress reporting.
- Repeat implementation → tests → advisor review → fixes until all checks possible in the available environment pass.

## Deliverables

1. Public web interface: upload GeoJSON, select a clearly labeled sample dataset and workflow, enter a question and candidate locations when needed, inspect job progress, view a map, download results and evidence.
2. Vultr controller: persistent jobs, bounded admission/concurrency, input validation, agent orchestration, retries, artifact collection, and inference exclusively through Vultr Serverless Inference.
3. Separate worker: authenticated private API that runs inspection and generated analysis only in disposable gVisor containers. Read-only input, no outbound networking or host secrets, bounded CPU/memory/PIDs/runtime/output, verified cleanup, and no unsafe fallback.
4. Analysis: explicit straight-line distance methodology, population-aware service access, optional candidate comparison, population membership within supplied zones, independently checked outputs, reproducible scripts, and source metadata. Synthetic fixtures are labeled; official source downloads are not presented as bundled until actually fetched and checked.
5. NetBird: host-level enrollment and narrowly scoped controller-to-worker policy; worker execution port inaccessible publicly. No NetBird credentials or sockets inside jobs. Self-hosting setup and existing-account configuration supported.
6. Linux/Vultr deployment configuration, environment examples, operational runbook, readiness checks, and containment demo harness.
7. Submission preparation: repository-ready source, public deployment procedure, and recorded-demo script. Publishing a repository, live URL, and cloud-backed demo recording require the corresponding accounts and running infrastructure.

## Acceptance checks

- Unit/integration checks: input limits and malformed geometry, unauthorized worker access, bounded agent retries, artifact allowlisting, job-state persistence, provider endpoint enforcement, and analysis fixture expectations.
- Browser checks: responsive upload/run/status/results interface, clear deployment readiness, readable failure states, artifact links, keyboard-accessible controls, and map rendering.
- Real Linux checks: gVisor availability; successful real analysis; read-only input; blocked outbound access; timeout; resource limits; no residual job containers; original input hashes unchanged; subsequent healthy job succeeds.
- Live cloud checks: Vultr inference, two-VM job round trip, NetBird authorized/unauthorized peer tests, and public web access.
- Tests using substitutes or mocks are reported separately from real sandbox and cloud tests.

## Current environment and dependencies

- Workspace initially contains PDFs and earlier exploratory artifacts, with no application or AGENTS.md found.
- Local machine is Windows. Docker Desktop has a working Linux engine, but only runc/nvidia runtimes are configured; gVisor is not installed. Real containment checks require a suitable gVisor host. Existing Docker configuration will not be silently modified.
- System Python 3.14 already includes FastAPI, Uvicorn, HTTPX, Pydantic, and pytest. Browser tooling is available.
- No Vultr or NetBird credentials were found among relevant environment-variable names; unrelated credentials will not be used.
- Questions about existing Vultr infrastructure and NetBird hosting are pending. Local implementation and verification continue independently.
- New billable cloud provisioning awaits concrete infrastructure/cost choices. Secrets should be configured locally or on the servers, not pasted into project files or logs.

## Progress

- [x] Inspect workspace and start requested advisor/executor team.
- [x] Record scope, security boundary, and acceptance plan.
- [x] Implement controller, worker, analysis, and web interface.
- [x] Add NetBird and Vultr deployment configuration.
- [x] Run local tests and preview browser checks; resolve findings.
- [x] Complete advisor review and regression checks (37 tests on Windows and Linux).
- [ ] Run real gVisor and live Vultr/NetBird acceptance checks when infrastructure is available.


## React migration

The user requested a React frontend while retaining FastAPI, followed by a push to the existing public Geoscope repository. The frontend lives in `web/`, uses Vite and React components, and builds to `web/dist`. FastAPI retains the analysis and worker APIs and serves only compiled frontend assets. Docker builds the frontend in a separate Node stage. Verification uses frontend DOM tests, a production build, backend HTTP tests, and container checks; no further browser checks are performed, per the user's instruction.
