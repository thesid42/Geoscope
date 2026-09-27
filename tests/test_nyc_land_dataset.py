from __future__ import annotations

import json
from pathlib import Path

from app.datasets import inspect_schema, validate_geojson
from app.scenario import validate_land_dataset
from app.scenario_program import calculate


ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "data" / "real-nyc-land" / "nyc-east-harlem-land.geojson"


def test_east_harlem_land_is_official_and_scenario_ready():
    dataset = validate_geojson(json.loads(PATH.read_text(encoding="utf-8")))
    schema = inspect_schema(dataset)
    sites = validate_land_dataset(dataset)
    assert dataset["scenario_status"] == "OFFICIAL_EXTRACT"
    assert dataset["land_inventory"]["site_geometry_is_simulated"] is False
    assert 1 <= schema["candidate_site_features"] <= 100
    assert schema["candidate_site_features"] == len(sites)
    assert schema["population_features"] > 0
    assert all(site["properties"]["landuse"] == "11" for site in sites)
    assert all(site["properties"]["source"].startswith("NYC DCP MapPLUTO") for site in sites)
    request = dict(dataset)
    request.update(
        analysis_mode="scenario",
        study_area=[-73.955, 40.790, -73.930, 40.812],
        service_type="clinic",
        threshold_m=400,
        projected_crs="EPSG:32618",
        building={"width_m": 24, "depth_m": 18, "height_m": 12, "setback_m": 3},
    )
    result, _mapped = calculate(request)
    assert result["metrics"]["eligible_sites"] >= 1
    assert result["metrics"]["sites_evaluated"] == len(sites)
    assert result["metrics"]["existing_service_counts"]["clinic"] > 0
