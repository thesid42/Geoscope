#!/usr/bin/env python3
"""Exercise the configured real worker; every check is observed from its API/host."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

default_url = f"http://{os.getenv('WORKER_BIND_IP', '127.0.0.1')}:8100"
url = os.getenv("WORKER_URL", default_url).rstrip("/")
token = os.getenv("WORKER_TOKEN", "")
if not token:
    raise SystemExit("Set WORKER_TOKEN in the worker's protected environment before running this demo.")
APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))
from app.datasets import DEMO
from app.reference import REFERENCE_CODE

valid_data = {**DEMO, "analysis_mode": "access", "projected_crs": "EPSG:32610", "threshold_m": 400}
reference_source = json.dumps(REFERENCE_CODE)


def call(path: str, payload=None):
    req = urllib.request.Request(url + path, data=json.dumps(payload).encode() if payload is not None else None,
        method="POST" if payload is not None else "GET", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=110) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def managed_ids() -> set[str]:
    out = subprocess.check_output(["docker", "ps", "-aq", "--filter", "label=park-agent.managed=true"], text=True)
    return set(out.split())


before = managed_ids()
status, health = call("/health")
if status != 200 or not health.get("ok") or "runsc" not in health.get("sandbox", "").lower():
    raise SystemExit(f"Worker health does not prove gVisor is ready: HTTP {status}, {health}")
print(f"PASS worker readiness: {health['sandbox']}")

success_script = '''import hashlib, json, pathlib
p = pathlib.Path("/input/request.json")
before_hash = hashlib.sha256(p.read_bytes()).hexdigest()
read_only = False
try:
    with p.open("ab") as f: f.write(b"x")
except OSError:
    read_only = True
network_blocked = False
try:
    import socket
    socket.create_connection(("1.1.1.1", 443), timeout=2)
except OSError:
    network_blocked = True
if not read_only or not network_blocked:
    raise RuntimeError("containment assertion failed: read_only=%r network_blocked=%r" % (read_only, network_blocked))
after_hash = hashlib.sha256(p.read_bytes()).hexdigest()
if before_hash != after_hash:
    raise RuntimeError("input SHA-256 changed")
print("geoscope-containment-probe:read-only=true,sha256-unchanged=true,no-network=true")
reference_source = REFERENCE_SOURCE_PLACEHOLDER
exec(compile(reference_source, "<trusted-reference>", "exec"), {})
'''
success_script = success_script.replace("REFERENCE_SOURCE_PLACEHOLDER", reference_source)
payload = {"code": success_script, "data": valid_data, "timeout_seconds": 15}
status, response = call("/execute", payload)
if status != 200:
    raise SystemExit(f"Containment smoke analysis failed: HTTP {status}: {response}")
result = response.get("result", {})
if "geoscope-containment-probe:read-only=true,sha256-unchanged=true,no-network=true" not in response.get("stdout", ""):
    raise SystemExit(f"Worker did not return the fixed containment probe marker: {response.get('stdout')!r}")
if not isinstance(result, dict) or result.get("mode") != "access":
    raise SystemExit(f"Worker returned an invalid GIS reference result: {result}")
print("PASS fixed probe observed read-only input, unchanged input SHA-256, and blocked outbound networking; GIS reference output was validated.")

timeout_script = "import time; time.sleep(30)"
status, timeout = call("/execute", {"code": timeout_script, "data": valid_data, "timeout_seconds": 15})
detail = timeout.get("detail", {})
if status != 422 or not isinstance(detail, dict) or not detail.get("timed_out"):
    raise SystemExit(f"Worker did not report the expected enforced timeout: HTTP {status}: {timeout}")
print("PASS 15-second execution timeout was enforced and reported by the worker.")

healthy_script = f"exec(compile({reference_source}, '<trusted-reference>', 'exec'), {{}})"
status, recovered = call("/execute", {"code": healthy_script, "data": valid_data, "timeout_seconds": 15})
if status != 200 or not isinstance(recovered.get("result"), dict) or recovered["result"].get("mode") != "access":
    raise SystemExit(f"Worker did not accept a healthy job after timeout cleanup: HTTP {status}: {recovered}")
print("PASS a subsequent healthy job completed after timeout cleanup.")

after = managed_ids()
if after != before:
    raise SystemExit(f"Managed job containers remain or changed unexpectedly: before={before}, after={after}")
print("PASS no managed job containers remain after successful and timed-out jobs.")
print("This run is evidence from the configured worker. Save this output with timestamp, host identity, and commit for the submission demo record.")
