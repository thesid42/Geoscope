# Live containment demo evidence

Run `scripts/deployment-demo.py` on the dedicated Linux worker after the worker service is running and its protected environment is loaded. The worker must answer `/health` with `ok: true` and a `runsc` readiness message. The harness submits fixed, auditable test probes (not model-generated analysis code) to the real authenticated worker, using the app's validated synthetic access fixture and trusted GIS reference script. It checks that writing the read-only input fails without changing its SHA-256, reaching an external IP fails, a 15-second timeout is enforced after the trusted reference run, a healthy job succeeds after the timeout, and Docker's managed-job container IDs return to their original set.

The output is evidence only for the host and source version on which it ran. Capture the unedited stdout and stderr, UTC timestamp, VM identifier, `docker info --format '{{json .Runtimes}}'`, sandbox image ID, and repository commit. The script intentionally exits nonzero when any assertion fails. Do not replace, synthesize, or relabel output from Windows/runc or mocked APIs as gVisor containment evidence.

Local development checks do not establish live Vultr, VPC, or gVisor containment; no live evidence is checked in. Run the harness as part of the final deployment and attach its actual output to the hackathon demo/submission.
