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
assert [c["id"] for c in m["candidates"]] == ["sfmock-fit-04", "sfmock-fit-01", "sfmock-fit-03"]
assert [c["newly_served_population"] for c in m["candidates"]] == [6224, 4282, 3841]
project = Transformer.from_crs("EPSG:4326","EPSG:32610",always_xy=True).transform
sites = {f["id"]:f for f in request["features"] if f["properties"]["layer"]=="candidate_site"}
for c in m["candidates"]:
    footprint = transform(project,shape(c["footprint"]))
    parcel = transform(project,shape(sites[c["id"]]["geometry"]))
    assert abs(footprint.area-432)<1e-4
    assert parcel.covers(footprint.buffer(2.99,join_style=2))
request["building"].update(width_m=100,depth_m=100)
assert calculate(request)[0]["metrics"]["eligible_sites"] == 0
print(json.dumps({"trusted_scenario_reference":"passed", "eligible_sites":4, "checked_candidates":3, "oversized_building_excluded":True, "generated_code_executed":False}))
