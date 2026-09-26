from __future__ import annotations

import copy
import json
import os
from dataclasses import replace
from tempfile import TemporaryDirectory
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_OLD_APP_DATA_DIR = os.environ.get("APP_DATA_DIR")
with TemporaryDirectory(prefix=".http-contract-bootstrap-", dir=_PROJECT_ROOT) as _bootstrap_dir:
    os.environ["APP_DATA_DIR"] = _bootstrap_dir
    try:
        from app import controller
        from app.datasets import DEMO
    finally:
        if _OLD_APP_DATA_DIR is None:
            os.environ.pop("APP_DATA_DIR", None)
        else:
            os.environ["APP_DATA_DIR"] = _OLD_APP_DATA_DIR


TOKEN = "test-http-contract-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    """Isolate persistent/global controller state so no test reaches Vultr or a worker."""
    data_dir = tmp_path / "app-data"
    data_dir.mkdir()
    dataset_dir = data_dir / "datasets"
    dataset_dir.mkdir()
    monkeypatch.setattr(
        controller,
        "settings",
        replace(
            controller.settings,
            data_dir=data_dir,
            worker_url="",
            worker_token="",
            vultr_api_key="",
            vultr_model_id="",
            max_upload_bytes=1024,
        ),
    )
    monkeypatch.setattr(controller, "DATASET_DIR", dataset_dir)
    monkeypatch.setattr(controller, "DATASETS", {"demo": copy.deepcopy(DEMO)})
    monkeypatch.setattr(controller, "RUNS", {})
    monkeypatch.setenv("APP_ACCESS_TOKEN", TOKEN)
    monkeypatch.delenv("VULTR_SERVERLESS_INFERENCE_API_KEY", raising=False)
    return TestClient(controller.app)


def geojson(*features):
    return {"type": "FeatureCollection", "features": list(features)}


def point_feature(feature_id, layer, coordinates, **properties):
    values = {"layer": layer, **properties}
    return {
        "type": "Feature",
        "id": feature_id,
        "properties": values,
        "geometry": {"type": "Point", "coordinates": coordinates},
    }


def small_dataset():
    return geojson(
        point_feature("population-1", "population", [-122.42, 37.77], population=37, source="fixture"),
        point_feature("service-1", "service", [-122.421, 37.771], name="Library"),
    )


def run_payload(**values):
    return {
        "dataset_id": "demo",
        "analysis_mode": "access",
        "question": "Compare access for this small test fixture.",
        **values,
    }


def test_unauthenticated_upload_is_rejected_before_geojson_parsing(client):
    response = client.post(
        "/api/datasets",
        files={"file": ("broken.geojson", b"this is not JSON", "application/geo+json")},
    )

    assert response.status_code == 401
    assert "Unauthorized" in response.text or "access key" in response.text.lower()
    assert list(controller.DATASET_DIR.glob("*.geojson")) == []
    assert list(controller.DATASETS) == ["demo"]


def test_authenticated_upload_can_be_retrieved_with_ids_and_properties_intact(client):
    source = small_dataset()
    response = client.post(
        "/api/datasets",
        headers=AUTH,
        files={"file": ("fixture.geojson", json.dumps(source).encode(), "application/geo+json")},
    )

    assert response.status_code == 200, response.text
    uploaded = response.json()
    dataset_id = uploaded["id"]
    assert uploaded["schema"]["population_features"] == 1
    retrieved = client.get(f"/api/datasets/{dataset_id}")
    assert retrieved.status_code == 200
    assert retrieved.json() == source
    persisted = controller.DATASET_DIR / f"{dataset_id}.geojson"
    assert json.loads(persisted.read_text(encoding="utf-8")) == source


@pytest.mark.parametrize(
    ("dataset", "payload", "message"),
    [
        (
            geojson(point_feature("p1", "population", [-122.42, 37.77], population=1)),
            run_payload(dataset_id="no-services"),
            "service",
        ),
        (
            small_dataset(),
            run_payload(dataset_id="no-zones", analysis_mode="exposure"),
            "zone",
        ),
        (
            copy.deepcopy(DEMO),
            run_payload(analysis_mode="compare"),
            "candidate",
        ),
    ],
)
def test_missing_mode_layers_or_candidates_are_rejected_before_worker_check(client, dataset, payload, message):
    if payload["dataset_id"] != "demo":
        controller.DATASETS[payload["dataset_id"]] = dataset
    response = client.post("/api/runs", headers=AUTH, json=payload)

    assert response.status_code == 422, response.text
    assert message in response.text.lower()
    assert controller.RUNS == {}


def test_valid_run_fails_closed_when_worker_is_unconfigured(client):
    response = client.post("/api/runs", headers=AUTH, json=run_payload())

    assert response.status_code == 503
    assert "worker" in response.text.lower()
    assert controller.RUNS == {}


@pytest.mark.parametrize("name", ["../secret", "analysis-attempt-4.py", "request.json/../../secret", "unknown.bin"])
def test_unsafe_or_unallowlisted_artifact_names_are_denied(client, name):
    run_id = "a" * 32
    response = client.get(f"/api/runs/{run_id}/artifacts/{name}", headers=AUTH)

    assert response.status_code == 404


def test_malformed_geojson_returns_controlled_422(client):
    response = client.post(
        "/api/datasets",
        headers=AUTH,
        files={"file": ("empty.geojson", b'{"type":"FeatureCollection","features":[]}', "application/geo+json")},
    )

    assert response.status_code == 422
    assert "FeatureCollection" in response.text
    assert list(controller.DATASET_DIR.glob("*.geojson")) == []


def test_oversized_upload_returns_controlled_413(client, monkeypatch):
    # Keep the test small while exercising the same max_upload_bytes + 1 read boundary.
    monkeypatch.setattr(controller, "settings", replace(controller.settings, max_upload_bytes=64))
    body = json.dumps(small_dataset()).encode()
    assert len(body) > 64

    response = client.post(
        "/api/datasets",
        headers=AUTH,
        files={"file": ("large.geojson", body, "application/geo+json")},
    )

    assert response.status_code == 413
    assert "limit" in response.text.lower()
    assert list(controller.DATASET_DIR.glob("*.geojson")) == []
