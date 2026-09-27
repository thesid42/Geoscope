from __future__ import annotations

import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NYC_PATH = ROOT / "data" / "real-nyc" / "nyc-facilities-census.geojson"
SF_PATH = ROOT / "data" / "real" / "sf-parks-census.geojson"


def test_nyc_snapshot_is_richer_than_sf_and_passes_upload_rules():
    from app.datasets import inspect_schema, validate_geojson

    dataset = validate_geojson(json.loads(NYC_PATH.read_text(encoding="utf-8")))
    schema = inspect_schema(dataset)
    services = [f for f in dataset["features"] if f["properties"]["layer"] == "service"]
    parks = [f for f in dataset["features"] if f["properties"]["layer"] == "park"]
    service_types = {f["properties"]["service_type"] for f in services}
    assert schema["population_features"] == 2325
    assert schema["service_features"] == 5602
    assert sum(f["properties"]["population"] for f in dataset["features"] if f["properties"]["layer"] == "population") == 8_804_190
    assert service_types == {"clinic", "library", "school", "community_center"}
    assert {f["properties"]["borough"] for f in dataset["features"] if f["properties"]["layer"] == "population"} == {
        "Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island",
    }
    assert any(p["properties"].get("acres") for p in parks)
    if SF_PATH.is_file():
        sf = json.loads(SF_PATH.read_text(encoding="utf-8"))
        assert len(dataset["features"]) > len(sf["features"]) * 10


def test_controller_serves_nyc_dataset_and_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path))
    os.environ["APP_DATA_DIR"] = str(tmp_path)
    from fastapi.testclient import TestClient
    from app import controller

    client = TestClient(controller.app)
    config = client.get("/api/config").json()
    assert config["nyc"]["id"] == "nyc2020"
    assert config["nyc"]["features"] == 7927
    assert config["nyc"]["synthetic"] is False
    dataset = client.get("/api/datasets/nyc2020").json()
    assert dataset["name"].startswith("New York City")
    assert len(dataset["features"]) == 7927
    manifest = client.get("/api/nyc-source-manifest").json()
    assert manifest["id"] == "nyc-facilities-census"
    assert manifest["counts"]["service_counts"]["clinic"] == 1297
