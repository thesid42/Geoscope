"""Test-only browser fixture for the real GeoScope controller and UI.

Run from the repository root with:
    python verification/ui_fixture_server.py

Open http://127.0.0.1:8766 and use access key GEOSCOPE-UI-FIXTURE-8766.
All Vultr and worker HTTP calls are replaced in-process. No generated code is
executed and this server must never be exposed beyond loopback.
"""

from __future__ import annotations

import base64
import copy
import json
import os
import tempfile
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse


TOKEN = "GEOSCOPE-UI-FIXTURE-8766"
FIXTURE_MODEL = "ui-fixture-model"
FIXTURE_WORKER = "http://fixture-worker.invalid"
_fail_next = False
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

# Configure the controller before importing it. The temporary directory is
# isolated per process and removed when the fixture server exits.
_state_root = REPOSITORY_ROOT / "tmp"
_state_root.mkdir(parents=True, exist_ok=True)
_state = tempfile.TemporaryDirectory(prefix="geoscope-ui-fixture-", dir=_state_root)
os.environ.update({
    "APP_ACCESS_TOKEN": TOKEN,
    "APP_DATA_DIR": _state.name,
    "VULTR_SERVERLESS_INFERENCE_API_KEY": "fixture-only-not-a-real-key",
    "VULTR_MODEL_ID": FIXTURE_MODEL,
    "WORKER_URL": FIXTURE_WORKER,
    "WORKER_TOKEN": "fixture-only-worker-token",
})

from app import controller  # noqa: E402

controller.DATASET_DIR = Path(_state.name) / "datasets"
controller.DATASET_DIR.mkdir(parents=True, exist_ok=True)
controller.settings = replace(
    controller.settings,
    data_dir=Path(_state.name),
    vultr_api_key="fixture-only-not-a-real-key",
    vultr_model_id=FIXTURE_MODEL,
    worker_url=FIXTURE_WORKER,
    worker_token="fixture-only-worker-token",
)


class _Response:
    def __init__(self, status_code: int, payload: Any):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return copy.deepcopy(self._payload)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"Fixture HTTP {self.status_code}")


def _map_for(data: dict[str, Any], mode: str) -> dict[str, Any]:
    features = []
    distances = [120.0, 350.0, 620.0, 840.0, 1210.0, 1600.0]
    for feature in data["features"]:
        if feature.get("properties", {}).get("layer") != "population":
            continue
        row = copy.deepcopy(feature)
        if mode == "exposure":
            row["properties"]["inside_zone"] = False
        else:
            index = len(features)
            distance = distances[index % len(distances)]
            row["properties"]["nearest_m"] = distance
            row["properties"]["underserved"] = distance > int(data["threshold_m"])
        features.append(row)
    return {"type": "FeatureCollection", "features": features}


def _population_rows(data: dict[str, Any]):
    return [f for f in data["features"] if f.get("properties", {}).get("layer") == "population"]


def _result_for(data: dict[str, Any]) -> dict[str, Any]:
    mode = data["analysis_mode"]
    if mode == "exposure":
        # Deliberately exercise the UI's zero-population/null-percentage path.
        return {
            "mode": "exposure",
            "metrics": {
                "analysis_crs": data["projected_crs"],
                "population_total": 0,
                "population_features": 6,
                "zone_features": 1,
                "inside_population": 0,
                "outside_population": 0,
                "share_inside_pct": None,
                "inside_feature_count": 0,
            },
        }
    population = _population_rows(data)
    weights = [float(feature.get("properties", {}).get("population", 0)) for feature in population]
    distances = [([120.0, 350.0, 620.0, 840.0, 1210.0, 1600.0][i % 6]) for i in range(len(population))]
    threshold = int(data["threshold_m"])
    total = sum(weights)
    served = sum(weight for weight, distance in zip(weights, distances) if distance <= threshold)
    mean = sum(weight * distance for weight, distance in zip(weights, distances)) / total if total else None
    metrics = {
        "analysis_crs": data["projected_crs"],
        "threshold_m": threshold,
        "population_total": total,
        "population_features": len(population),
        "service_features": sum(1 for f in data["features"] if f.get("properties", {}).get("layer") in {"service", "park"}),
        "baseline": {
            "served_population": served,
            "underserved_population": total - served,
            "weighted_mean_nearest_m": mean,
        },
    }
    result = {"mode": mode, "metrics": metrics}
    if mode == "compare":
        for label, candidate_distances in (("a", [100.0, 250.0, 300.0, 800.0, 1100.0, 1600.0]), ("b", [150.0, 500.0, 750.0, 200.0, 350.0, 1000.0])):
            adjusted = [min(old, candidate_distances[i % 6]) for i, old in enumerate(distances)]
            newly = sum(weight for weight, old, new in zip(weights, distances, adjusted) if old > threshold and new <= threshold)
            served_after = sum(weight for weight, distance in zip(weights, adjusted) if distance <= threshold)
            candidate_mean = sum(weight * distance for weight, distance in zip(weights, adjusted)) / total if total else None
            reduction = sum(weight * (old - new) for weight, old, new in zip(weights, distances, adjusted)) / total if total else None
            metrics[f"candidate_{label}"] = {
                "served_population": served_after,
                "newly_served_population": newly,
                "weighted_mean_nearest_m": candidate_mean,
                "weighted_mean_distance_reduction_m": reduction,
            }
        a_new = metrics["candidate_a"]["newly_served_population"]
        b_new = metrics["candidate_b"]["newly_served_population"]
        preferred = "A" if a_new > b_new else ("B" if b_new > a_new else "Tie")
        result["comparison"] = {
            "preferred_candidate": preferred,
            "basis": "newly served population within the stated straight-line threshold",
        }
    return result


class _FixtureAsyncClient:
    """Drop-in controller HTTP client; it never opens a socket."""

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url: str, **kwargs):
        if url == FIXTURE_WORKER + "/health":
            return _Response(200, {"ok": True, "sandbox": "UI fixture; no sandbox execution"})
        if url == "https://api.vultrinference.com/v1/models":
            return _Response(200, {"data": [{"id": FIXTURE_MODEL}]})
        raise AssertionError(f"Unexpected fixture GET: {url}")

    async def post(self, url: str, **kwargs):
        global _fail_next
        if url == FIXTURE_WORKER + "/inspect":
            request = kwargs.get("json", {})
            data = request.get("data", {})
            if _fail_next:
                _fail_next = False
                return _Response(422, {"detail": "UI fixture requested a deterministic failure before inference."})
            layers = [f.get("properties", {}).get("layer") for f in data.get("features", [])]
            return _Response(200, {"inspection": {
                "geometry_validation": "fixture response; no sandbox was started",
                "population_features": layers.count("population"),
                "service_features": layers.count("service") + layers.count("park"),
                "zone_features": layers.count("zone"),
                "analysis_mode": data.get("analysis_mode"),
            }, "reference_verified": True})
        if url == FIXTURE_WORKER + "/execute":
            data = kwargs.get("json", {}).get("data", {})
            result = _result_for(data)
            result_map = _map_for(data, data["analysis_mode"])
            artifacts = {
                "result.json": base64.b64encode(json.dumps(result, allow_nan=False).encode()).decode(),
                "result.geojson": base64.b64encode(json.dumps(result_map, allow_nan=False).encode()).decode(),
            }
            return _Response(200, {
                "result": result,
                "artifacts": artifacts,
                "stdout": "UI fixture response; generated code was not run.\n",
                "stderr": "",
                "verified_against_reference": True,
            })
        if url == "https://api.vultrinference.com/v1/chat/completions":
            system = kwargs.get("json", {}).get("messages", [{}])[0].get("content", "")
            if "careful GIS analyst" in system:
                content = json.dumps({"steps": ["inspect fixture schema", "request fixed analysis response", "summarize fixture metrics"]})
            elif system.startswith("Write only"):
                content = "# UI fixture only: the mocked worker will not execute this script.\nprint('fixture')"
            elif system.startswith("Repair"):
                content = "# UI fixture only: repair path is not used by the success fixture.\nprint('fixture')"
            else:
                content = "This is a deterministic UI fixture response, not a live analysis or evidence."
            return _Response(200, {"choices": [{"message": {"content": content}}]})
        raise AssertionError(f"Unexpected fixture POST: {url}")


# Replace only this process's controller client. Production code and other
# processes retain the real httpx client.
controller.httpx.AsyncClient = _FixtureAsyncClient


@controller.app.middleware("http")
async def show_fixture_banner(request: Request, call_next):
    response = await call_next(request)
    if request.url.path != "/" or response.status_code != 200:
        return response
    body = b"".join([chunk async for chunk in response.body_iterator]).decode("utf-8")
    fixture_banner = f"""<div style="position:sticky;top:0;z-index:99999;background:#7b1e1e;color:white;padding:10px 16px;text-align:center;font:700 14px system-ui;letter-spacing:.03em">
      UI FIXTURE — no live inference or sandbox execution &nbsp;·&nbsp; Fixed responses only
      <button id="fixture-fail-next" style="margin-left:16px;padding:5px 10px;border:1px solid white;border-radius:4px;background:white;color:#7b1e1e;font-weight:700;cursor:pointer">Arm deterministic failure</button>
      <span id="fixture-failure-state" aria-live="polite"></span>
    </div><script>
    document.addEventListener('DOMContentLoaded',()=>{{const b=document.getElementById('fixture-fail-next');b.addEventListener('click',async()=>{{const r=await fetch('/__fixture/fail-next',{{method:'POST'}});document.getElementById('fixture-failure-state').textContent=r.ok?' · next run will fail':' · could not arm failure';}})}});
    </script>"""
    body = body.replace('<header class="topbar">', fixture_banner + '<header class="topbar">', 1)
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


@controller.app.post("/__fixture/fail-next")
def arm_failure():
    global _fail_next
    _fail_next = True
    return JSONResponse({"armed": True, "message": "The next run will fail during mocked input inspection."})


if __name__ == "__main__":
    print("GeoScope UI fixture only — no live inference or sandbox execution.")
    print("Open: http://127.0.0.1:8766")
    print(f"Analysis access key: {TOKEN}")
    print(f"Isolated state: {_state.name}")
    uvicorn.run(controller.app, host="127.0.0.1", port=8766, log_level="info")
