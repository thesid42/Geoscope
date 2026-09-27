"""Trusted GIS dependency smoke. No generated script or cloud/containment claim."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path.cwd()))
from app.scenario_program import calculate
from shapely.geometry import shape
from shapely.ops import transform
from pyproj import Transformer

request = json.loads(Path("data/real-scenario/sf-mock.geojson").read_text())
request.update(analysis_mode="scenario", study_area=[-122.433,37.758,-122.417,37.776], service_type="clinic", threshold_m=400, projected_crs="EPSG:32610", building={"width_m":24,"depth_m":18,"height_m":12,"setback_m":3})
result, mapped = calculate(request)
m = result["metrics"]
assert m["eligible_sites"] == 4 and len(m["candidates"]) == 3
assert [c["id"] for c in m["candidates"]] == ["sfmock-fit-01", "sfmock-fit-02", "sfmock-fit-03"]
assert [round(c["nearest_existing_service_m"], 1) for c in m["candidates"]] == [415.3, 306.1, 184.0]
assert m["ranking_basis"].startswith("greatest distance to nearest existing matching service")
project = Transformer.from_crs("EPSG:4326","EPSG:32610",always_xy=True).transform
sites = {f["id"]:f for f in request["features"] if f["properties"]["layer"]=="candidate_site"}
for c in m["candidates"]:
    footprint = transform(project,shape(c["footprint"]))
    parcel = transform(project,shape(sites[c["id"]]["geometry"]))
    assert abs(footprint.area-432)<1e-4
    assert parcel.covers(footprint.buffer(2.99,join_style=2))
# Each primary facility type ranks at least one eligible site with a mapped-service gap.
expected = {
    "clinic": ("sfmock-fit-01", 415.3),
    "library": ("sfmock-fit-02", 778.5),
    "school": ("sfmock-fit-01", 384.0),
    "community_center": ("sfmock-fit-01", 520.4),
}
for service_type, (preferred, nearest) in expected.items():
    payload = dict(request)
    payload["service_type"] = service_type
    metrics = calculate(payload)[0]["metrics"]
    assert metrics["eligible_sites"] >= 1
    top = metrics["candidates"][0]
    assert top["id"] == preferred
    assert round(top["nearest_existing_service_m"], 1) == nearest
    assert top["nearest_existing_service_m"] > (350 if service_type == "school" else 400)
request["building"].update(width_m=100,depth_m=100)
assert calculate(request)[0]["metrics"]["eligible_sites"] == 0
print(json.dumps({"trusted_scenario_reference":"passed", "eligible_sites":4, "checked_candidates":3, "facility_types_checked":4, "oversized_building_excluded":True, "generated_code_executed":False}))
