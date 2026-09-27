import copy

import pytest
from pyproj import Transformer
from shapely.geometry import Point, Polygon, box, mapping
from shapely.ops import transform

from app.walking import compare_walk_access

PROJECT = Transformer.from_crs("EPSG:32610", "EPSG:4326", always_xy=True).transform
INVERSE = Transformer.from_crs("EPSG:4326", "EPSG:32610", always_xy=True).transform
X, Y = 500000, 4180000


def ll(x, y=Y):
    return PROJECT(x, y)


def feature(identifier, layer, geometry, **props):
    return {"type": "Feature", "id": identifier, "properties": {"layer": layer, **props},
            "geometry": mapping(transform(ll, geometry))}


def make_request(include_service=True):
    bounds = list(transform(PROJECT, box(X - 1000, Y - 500, X + 2000, Y + 500)).bounds)
    nodes = [{"id": str(x), "longitude": ll(X + x)[0], "latitude": ll(X + x)[1]}
             for x in (0, 250, 500, 750, 850, 1000, 1250)]
    edges = [{"u": str(a), "v": str(b)} for a, b in zip((0, 250, 500, 750, 850, 1000), (250, 500, 750, 850, 1000, 1250))]
    network_bounds=list(transform(PROJECT,box(X-4000,Y-4000,X+5000,Y+4000)).bounds)
    network = {"nodes": nodes, "edges": edges, "bounds": network_bounds,
               "source": "OpenStreetMap test extract", "as_of": "2026-09-26"}
    features = [feature("pop-a", "population", Point(X + 1000, Y), population=100)]
    if include_service:
        features.append(feature("clinic-a", "service", Point(X, Y), service_type="clinic"))
    return {"features": features, "study_area": bounds, "projected_crs": "EPSG:32610",
            "service_type": "clinic", "walk_network": network,
            "walk": {"minutes": 10, "speed_mps": 1.2, "max_snap_m": 100}}


def candidate(x0=900, x1=950, site_id="site-a"):
    return {"id": site_id, "longitude": ll(X + (x0+x1)/2)[0], "latitude": ll(X)[1],
            "footprint": mapping(transform(ll, box(X+x0, Y-20, X+x1, Y+20)))}


def test_proposal_improves_network_access_and_returns_capped_route_geojson():
    request = make_request()
    rows = compare_walk_access(request, [candidate(), candidate(0, 50, "site-b")])
    first, second = rows
    assert [r["status"] for r in rows] == ["available", "available"]
    assert first["baseline_known"] is True
    assert first["before_served_population"] == 0
    assert first["after_served_population"] == 100
    assert first["newly_served_population"] == 100
    assert first["before_mean_minutes"] > first["after_mean_minutes"]
    assert first["routes"] and first["routes"][0]["geometry"]["type"] == "LineString"
    assert {r["properties"]["phase"] for r in first["routes"]} == {"before", "after"}
    assert second["newly_served_population"] == 0


def test_missing_inventory_has_unknown_baseline_and_no_gain_claim():
    request = make_request(include_service=False)
    result = compare_walk_access(request, [candidate()])[0]
    assert result["status"] == "available"
    assert result["baseline_known"] is False
    assert result["before_served_population"] is None
    assert result["newly_served_population"] is None
    assert result["after_served_population"] == 100
    assert result["routes"][0]["properties"]["phase"] == "after"


def test_disconnected_demand_is_unknown_not_zero_or_newly_served():
    request = make_request()
    request["features"].append(feature("isolated-pop", "population", Point(X + 1500, Y), population=25))
    # Disconnect the rightmost component, which includes the new site vicinity.
    request["walk_network"]["edges"] = [e for e in request["walk_network"]["edges"] if e["u"] != "1000"]
    result = compare_walk_access(request, [candidate()])[0]
    isolated = next(s for s in result["samples"] if s["id"] == "isolated-pop")
    assert isolated["status"] == "unknown"
    assert isolated["before_minutes"] is None and isolated["after_minutes"] is None
    assert result["newly_served_population"] == 100
    assert result["unmatched_population"] == 25


def test_candidate_connector_blocked_by_building_is_unavailable():
    request = make_request()
    request["features"].append(feature("wall", "building", box(X+899, Y-21, X+1101, Y+21)))
    # Only boundary node x=850 is within 100 m; its connector crosses the wall.
    site = candidate(900, 1100)
    result = compare_walk_access(request, [site])[0]
    assert result["status"] == "unavailable"
    assert "clear mapped connector" in result["reason"]


def test_missing_network_fails_closed_and_candidate_order_is_preserved():
    request = make_request()
    request.pop("walk_network")
    sites = [candidate(site_id="one"), candidate(site_id="two")]
    rows = compare_walk_access(request, sites)
    assert len(rows) == 2
    assert [r["status"] for r in rows] == ["unavailable", "unavailable"]


def test_limits_fractional_weights_and_recomputes_edge_lengths():
    request = make_request()
    request["features"][0]["properties"]["population"] = 0.6
    request["features"].append(feature("pop-b", "population", Point(X+750, Y), population=0.6))
    for edge in request["walk_network"]["edges"]:
        edge["length_m"] = 1  # Validated as a hint, but ignored in routing.
    result = compare_walk_access(request, [candidate()])[0]
    assert result["estimated_population_total"] == pytest.approx(1.2)
    assert result["compared_population"] == pytest.approx(1.2)
    assert result["after_served_population"] == pytest.approx(1.2)


@pytest.mark.parametrize("bad", [0, 0.1, True, float("inf")])
def test_walk_setting_bounds_are_rejected(bad):
    request = make_request()
    request["walk"]["minutes"] = bad
    with pytest.raises(ValueError):
        compare_walk_access(request, [candidate()])






def test_insufficient_edge_padding_is_unavailable_not_a_truncated_comparison():
    request=make_request();request["walk_network"]["bounds"]=request["study_area"]
    row=compare_walk_access(request,[candidate()])[0]
    assert row["status"]=="unavailable" and "edge padding" in row["reason"]
    assert row["newly_served_population"] is None


def test_known_baseline_is_unchanged_when_proposal_is_disconnected():
    request=make_request()
    # Separate population+baseline on the left from the proposed site on the right.
    request["features"][0]=feature("pop-a","population",Point(X+250,Y),population=100)
    request["walk_network"]["edges"]=[e for e in request["walk_network"]["edges"] if e["u"]!="500"]
    row=compare_walk_access(request,[candidate()])[0]
    assert row["compared_population"]==100
    assert row["before_mean_minutes"]==row["after_mean_minutes"]
    assert row["before_served_population"]==row["after_served_population"]==100
    assert row["newly_served_population"]==0


def test_unknown_baseline_has_known_proposal_after_map_but_no_gain_claim():
    request=make_request(include_service=False)
    row=compare_walk_access(request,[candidate()])[0]
    assert row["samples"][0]["before_minutes"] is None
    assert row["samples"][0]["after_minutes"] is not None
    assert row["samples"][0]["status"]=="proposal_only"
    assert row["before_served_population"] is None and row["newly_served_population"] is None


def test_no_comparable_origins_returns_null_comparison_totals_not_false_zero():
    request=make_request();request["walk_network"]["edges"]=[e for e in request["walk_network"]["edges"] if e["u"]!="500"]
    row=compare_walk_access(request,[candidate()])[0]
    assert row["baseline_known"] and row["compared_population"]==0
    assert row["before_served_population"] is None
    assert row["after_served_population"] is None
    assert row["newly_served_population"] is None
    assert row["samples"][0]["after_minutes"] is not None
