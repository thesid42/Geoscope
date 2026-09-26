import copy
import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import controller
from app.access import COOKIE_NAME
from app.datasets import DEMO

ORIGIN = "https://geoscope.example.test"
TOKEN = "server-only-test-secret-0123456789abcdef"


@pytest.fixture
def guests(tmp_path, monkeypatch):
    data = tmp_path / "data"; data.mkdir()
    uploads = data / "datasets"; uploads.mkdir()
    monkeypatch.setenv("APP_ACCESS_TOKEN", TOKEN)
    monkeypatch.setenv("PUBLIC_ANALYSIS_ENABLED", "true")
    monkeypatch.setenv("PUBLIC_ORIGIN", ORIGIN)
    monkeypatch.setenv("APP_DATA_DIR", str(data))
    monkeypatch.setattr(controller, "settings", replace(controller.settings, data_dir=data, worker_url="http://worker.invalid", worker_token="unused-test", vultr_api_key="test-server-only", vultr_model_id="test-model"))
    monkeypatch.setattr(controller, "DATASET_DIR", uploads)
    monkeypatch.setattr(controller, "DATASETS", {"demo": copy.deepcopy(DEMO)})
    monkeypatch.setattr(controller, "DATASET_OWNERS", {})
    monkeypatch.setattr(controller, "RUNS", {})
    monkeypatch.setattr(controller.app.state, "demo_mode", False, raising=False)

    async def mock_inner(run, *_):
        run["status"] = "completed"
        folder = data / run["id"]
        (folder / "result.geojson").write_text('{"type":"FeatureCollection","features":[]}')
        (folder / "result.json").write_text('{"mode":"access","metrics":{}}')
        controller._save_run(run)
    monkeypatch.setattr(controller, "_run_agent_inner", mock_inner)
    a, b = TestClient(controller.app, base_url=ORIGIN), TestClient(controller.app, base_url=ORIGIN)
    for client in (a,b):
        response = client.get("/api/config")
        assert response.status_code == 200
        assert response.json()["analysis_enabled"] is True
        assert TOKEN not in response.text and "test-server-only" not in response.text
        assert response.headers["cache-control"] == "no-store"
    yield a,b
    a.close(); b.close()


def upload(client):
    response = client.post("/api/datasets", headers={"Origin": ORIGIN}, files={"file": ("fixture.geojson", json.dumps(DEMO).encode(), "application/geo+json")})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def start(client, dataset_id="demo"):
    return client.post("/api/runs", headers={"Origin": ORIGIN}, json={"dataset_id": dataset_id, "analysis_mode": "access", "question": "Compare access in this test dataset."})


def test_guest_isolation_for_uploads_runs_maps_and_artifacts(guests):
    a,b = guests
    dataset_id = upload(a)
    response = start(a, dataset_id); assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    for path in (f"/api/datasets/{dataset_id}", f"/api/runs/{run_id}", f"/api/runs/{run_id}/map", f"/api/runs/{run_id}/artifacts/result.json"):
        own = a.get(path)
        assert own.status_code == 200 and own.headers["cache-control"] == "no-store"
        assert b.get(path).status_code == 404
        assert b.get(path, headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
    assert start(b, dataset_id).status_code == 404
    assert "owner" not in a.get(f"/api/runs/{run_id}").json()


def test_cookie_writes_require_origin_before_parsing(guests):
    a,_ = guests
    for headers in ({}, {"Origin": "https://unrelated.example"}):
        response = a.post("/api/runs", headers=headers, content="bad-json")
        assert response.status_code == 403
    assert a.post("/api/runs", headers={"Origin": ORIGIN}, content="bad-json").status_code == 422


def test_owners_survive_fresh_controller_process(guests):
    a,_ = guests
    dataset_id = upload(a)
    run_id = start(a, dataset_id).json()["id"]
    owner = controller.RUNS[run_id]["owner"]
    code = "from app import controller; import json; print(json.dumps([controller.DATASET_OWNERS[%r], controller.RUNS[%r]['owner']]))" % (dataset_id, run_id)
    result = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], env=os.environ.copy(), capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == [owner, owner]


def test_public_disable_does_not_leave_cookie_write_access(guests, monkeypatch):
    a,_ = guests
    monkeypatch.setenv("PUBLIC_ANALYSIS_ENABLED", "false")
    assert not a.get("/api/config").json()["analysis_enabled"]
    assert start(a).status_code == 401
    assert a.post("/api/runs", headers={"Authorization": f"Bearer {TOKEN}"}, json={"question":"A private API access analysis."}).status_code == 202


@pytest.mark.parametrize("update", [
    {}, {"study_area":[-122.44,37.75,-122.40,37.79], "building":{"width_m":True}},
    {"study_area":[-122.44,37.75,-122.40,37.79], "building":{"height_m":100}},
    {"study_area":[-122.44,37.75,-122.40,37.79], "service_type":"unsupported"},
    {"study_area":[-122.44,37.75,-122.40,37.79]},
])
def test_scenario_invalid_inputs_rejected_before_worker(guests, update):
    a,_ = guests
    response = a.post("/api/runs", headers={"Origin":ORIGIN}, json={"dataset_id":"demo", "analysis_mode":"scenario", "question":"Find candidate clinic plots nearby.", **update})
    assert response.status_code == 422
    assert controller.RUNS == {}
