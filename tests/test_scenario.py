import copy
import json

import pytest
from pyproj import Transformer
from shapely.geometry import Point, Polygon, MultiPolygon, box, shape, mapping
from shapely.ops import transform

from app.scenario import BuildingSpec, validate_land_dataset, validate_study_area
from app.scenario_program import calculate
from app.sandbox import SandboxFailure, _verify_map, _verify_result

PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:32610", always_xy=True).transform
INVERSE = Transformer.from_crs("EPSG:32610", "EPSG:4326", always_xy=True).transform
X, Y = 500000, 4180000


def feature(identifier, layer, geometry, **properties):
    return {"type": "Feature", "id": identifier, "geometry": mapping(transform(INVERSE, geometry)),
            "properties": {"layer": layer, **properties}}


def fixture():
    bounds = list(transform(INVERSE, box(X-500, Y-500, X+500, Y+500)).bounds)
    return {"type": "FeatureCollection", "analysis_mode": "scenario", "study_area": bounds,
            "service_type": "clinic", "threshold_m": 100, "projected_crs": "EPSG:32610",
            "building": BuildingSpec().model_dump(),
            "land_inventory": {"building_coverage": "complete_for_candidate_sites", "restriction_coverage": "complete_for_candidate_sites", "source": "Test survey", "as_of": "2026-09-26"},
            "features": [feature("population", "population", Point(X, Y), population=125.5),
                         feature("plot-a", "candidate_site", box(X-45, Y-45, X+45, Y+45), land_status="available", allowed_services=["clinic", "library"], source="Test plot record")]}


def test_verified_footprint_setback_and_coverage_are_computed_in_metres():
    req = fixture()
    result, mapped = calculate(req)
    m = result["metrics"]
    assert m["population_total"] == 125.5 and m["service_features"] == 0
    assert m["baseline"]["weighted_mean_nearest_m"] is None
    assert m["inventory_status"] == "no matching service inventory supplied"
    assert m["eligible_sites"] == 1
    candidate = m["candidates"][0]
    footprint = transform(PROJECT, shape(candidate["footprint"]))
    parcel = transform(PROJECT, shape(req["features"][1]["geometry"]))
    assert parcel.covers(footprint.buffer(2.99, join_style=2))
    assert footprint.area == pytest.approx(24*18, abs=1e-5)
    assert candidate["newly_served_population"] == 125.5
    assert candidate["land_check"]["plot_fit"] is True
    assert mapped["features"][0]["properties"]["nearest_m"] is None
    _verify_map(json.dumps(mapped).encode(), json.dumps(mapped).encode(), req)


@pytest.mark.parametrize("layer", ["building", "restricted"])
def test_obstruction_overlapping_whole_plot_excludes_placement(layer):
    req = fixture()
    req["features"].append(feature("blocker", layer, box(X-50, Y-50, X+50, Y+50)))
    result, _ = calculate(req)
    assert result["metrics"]["candidates"] == []
    assert result["comparison"]["preferred_candidate"] is None
    assert "bounded search" in result["metrics"]["site_checks"][0]["reason"]


def test_fit_rejects_holes_and_multipolygon_gaps():
    for geom in [Polygon(box(X-40,Y-40,X+40,Y+40).exterior.coords, [box(X-37,Y-37,X+37,Y+37).exterior.coords]),
                 MultiPolygon([box(X-40,Y-40,X-35,Y+40), box(X+35,Y-40,X+40,Y+40)])]:
        req = fixture()
        req["features"][1]["geometry"] = mapping(transform(INVERSE, geom))
        assert calculate(req)[0]["metrics"]["eligible_sites"] == 0


def test_larger_building_can_make_previously_eligible_plot_fail():
    req = fixture()
    assert calculate(req)[0]["metrics"]["eligible_sites"] == 1
    req["building"].update(width_m=100, depth_m=100)
    assert calculate(req)[0]["metrics"]["eligible_sites"] == 0


def test_footprint_must_fit_area_even_if_anchor_fits_plot():
    req = fixture()
    req["study_area"] = list(transform(INVERSE, box(X-10,Y-40,X+10,Y+40)).bounds)
    assert calculate(req)[0]["metrics"]["eligible_sites"] == 0


def test_parks_never_count_as_clinics_and_external_clinics_still_count():
    req = fixture()
    req["threshold_m"] = 800
    req["features"].append(feature("park", "park", Point(X, Y)))
    assert calculate(req)[0]["metrics"]["service_features"] == 0
    req["features"].append(feature("outside-clinic", "service", Point(X+600,Y), service_type="clinic"))
    m = calculate(req)[0]["metrics"]
    assert m["service_features"] == 1
    assert m["baseline"]["served_population"] == 125.5
    assert m["candidates"][0]["newly_served_population"] == 0


@pytest.mark.parametrize("change", [{"land_status": "unknown"}, {"allowed_services": ["library"]}, {"source": ""}])
def test_record_must_support_availability_and_service_use(change):
    req = fixture()
    req["features"][1]["properties"].update(change)
    assert calculate(req)[0]["metrics"]["eligible_sites"] == 0


def test_equal_sites_rank_deterministically_by_id():
    req = fixture()
    second = copy.deepcopy(req["features"][1]); second["id"] = "plot-0"
    req["features"].append(second)
    result = calculate(req)[0]
    assert [c["id"] for c in result["metrics"]["candidates"]] == ["plot-0", "plot-a"]
    assert result == calculate(req)[0]


def test_empty_area_and_zero_population_are_explicit_errors():
    req = fixture(); req["features"][0]["properties"]["population"] = 0
    with pytest.raises(ValueError, match="positive population"):
        calculate(req)
    req = fixture(); req["study_area"] = list(transform(INVERSE, box(X+200,Y+200,X+300,Y+300)).bounds)
    with pytest.raises(ValueError, match="no population"):
        calculate(req)


def test_land_metadata_and_duplicate_ids_fail_validation():
    req = fixture()
    validate_land_dataset(req)
    req["features"].append(copy.deepcopy(req["features"][1]))
    with pytest.raises(ValueError, match="unique"):
        validate_land_dataset(req)
    req = fixture(); req["land_inventory"]["building_coverage"] = "unknown"
    with pytest.raises(ValueError, match="coverage"):
        validate_land_dataset(req)


@pytest.mark.parametrize("bounds", [[0,0,0,1], [0,0,1,1], [False,0,0.01,0.01], [0,0,float("nan"),0.01], [179,0,-179,0.01]])
def test_study_area_is_bounded_and_finite(bounds):
    with pytest.raises(ValueError):
        validate_study_area(bounds)


def test_verified_output_rejects_moved_footprint_and_changed_evidence():
    result, mapped = calculate(fixture())
    _verify_result(result, result)
    for mutation in ("footprint", "record", "rank"):
        changed = copy.deepcopy(result)
        candidate = changed["metrics"]["candidates"][0]
        if mutation == "footprint":
            candidate["footprint"]["coordinates"][0][0][0] += .0001
        elif mutation == "record":
            candidate["land_check"]["source"] = "invented record"
        else:
            changed["comparison"]["preferred_candidate"] = "different-site"
        with pytest.raises(SandboxFailure):
            _verify_result(changed, result)
    changed_map = copy.deepcopy(mapped)
    changed_map["features"][0]["properties"]["nearest_m"] = 0
    with pytest.raises(SandboxFailure, match="unknown baseline"):
        _verify_map(json.dumps(changed_map).encode(), json.dumps(mapped).encode(), fixture())


def test_narrow_plot_uses_ninety_degree_rotation():
    req = fixture()
    req["features"][1]["geometry"] = mapping(transform(INVERSE, box(X-13,Y-18,X+13,Y+18)))
    candidate = calculate(req)[0]["metrics"]["candidates"][0]
    assert candidate["land_check"]["rotation_deg"] == 90
    minx,miny,maxx,maxy = transform(PROJECT,shape(candidate["footprint"])).bounds
    assert maxx-minx == pytest.approx(18, abs=1e-5)
    assert maxy-miny == pytest.approx(24, abs=1e-5)


def test_bundled_sf_mock_has_expected_fit_and_exclusion_results():
    from pathlib import Path
    req = json.loads((Path(__file__).resolve().parents[1] / "data/real-scenario/sf-mock.geojson").read_text())
    req.update(analysis_mode="scenario", study_area=[-122.433,37.758,-122.417,37.776], service_type="clinic", threshold_m=400, projected_crs="EPSG:32610", building=BuildingSpec().model_dump())
    m = calculate(req)[0]["metrics"]
    assert req["scenario_status"] == "MOCK_SIMULATION"
    assert m["sites_evaluated"] == 7 and m["eligible_sites"] == 4
    assert [c["id"] for c in m["candidates"]] == ["sfmock-fit-04", "sfmock-fit-01", "sfmock-fit-03"]
    assert [c["newly_served_population"] for c in m["candidates"]] == [6224,4282,3841]
    assert {c["id"] for c in m["site_checks"] if c["status"] == "excluded"} == {"sfmock-building-blocked", "sfmock-restricted", "sfmock-too-small"}
