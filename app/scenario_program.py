"""Fixed parcel-fit reference. This entire file runs in a disposable GIS container."""
import json
import math
from pyproj import Transformer
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import transform, unary_union

BASIS = "greatest distance to nearest existing matching service, then largest plot area, then site ID"
SUPPORTED_SERVICES = ("clinic", "library", "school", "community_center")


def calculate(request):
    west, south, east, north = request["study_area"]
    service_type, building = request["service_type"], request["building"]
    threshold = float(request["threshold_m"])
    project = Transformer.from_crs("EPSG:4326", request["projected_crs"], always_xy=True).transform
    unproject = Transformer.from_crs(request["projected_crs"], "EPSG:4326", always_xy=True).transform
    area = transform(project, box(west, south, east, north))
    matching_services, sites, buildings, roads, restrictions = [], [], [], [], []
    existing_service_counts = {kind: 0 for kind in SUPPORTED_SERVICES}
    inventory = request["land_inventory"]
    if any(inventory.get(key) != "complete_for_candidate_sites" for key in ("building_coverage", "road_coverage", "restriction_coverage")):
        raise ValueError("Incomplete supplied land obstruction coverage")
    for index, feature in enumerate(request["features"]):
        geom = shape(feature["geometry"])
        if geom.is_empty or not geom.is_valid:
            raise ValueError("Invalid input geometry at feature " + str(index))
        projected = transform(project, geom)
        props = feature["properties"]
        role = props["layer"]
        if role in ("service", "park"):
            kind = "park" if role == "park" else props.get("service_type")
            # These are counts of supplied mapped records, not a claim that the
            # source inventory is complete. Use the same projected-area predicate
            # for counts and always keep park aliases distinct from service types.
            in_area = area.covers(projected.representative_point())
            if role == "service" and in_area and isinstance(kind, str) and kind in existing_service_counts:
                existing_service_counts[kind] += 1
            if kind == service_type:
                matching_services.append((feature, projected))
        elif role == "candidate_site":
            sites.append((feature, projected))
        elif role == "building":
            buildings.append(projected)
        elif role == "restricted":
            (roads if props.get("restriction_type") == "mapped_road_corridor" else restrictions).append(projected)
    if not 1 <= len(sites) <= 100:
        raise ValueError("Supply between 1 and 100 candidate land plots.")
    ids = [f.get("id") for f, _ in sites]
    if any(not isinstance(v, str) or not v for v in ids) or len(set(ids)) != len(ids):
        raise ValueError("Candidate plot IDs must be unique nonempty strings.")
    buildings_union, roads_union, restricted_union = unary_union(buildings), unary_union(roads), unary_union(restrictions)
    count = lambda value: int(value) if float(value).is_integer() else float(value)
    service_geoms = [geom for _, geom in matching_services]

    def score(parcel):
        # Lot-level gap: always parcel.representative_point(), never the
        # footprint, clearance, or a searched placement anchor.
        origin = parcel.representative_point()
        if service_geoms:
            distances = [origin.distance(geom) for geom in service_geoms]
            nearest = min(distances)
            within = sum(1 for distance in distances if distance <= threshold)
        else:
            nearest, within = None, 0
        return {
            "plot_area_m2": count(parcel.area),
            "nearest_existing_service_m": nearest,
            "services_within_threshold": within,
        }, origin

    candidates, checks = [], []
    for feature, parcel in sites:
        props, site_id = feature["properties"], feature["id"]
        source = props.get("source") if isinstance(props.get("source"), str) else ""
        check = {"id": site_id, "status": "excluded", "reason": "", "source": source}
        checks.append(check)
        if props.get("land_status") != "available" or not source.strip():
            check["reason"] = "Land availability is not supported by the supplied record."
            continue
        allowed = props.get("allowed_services")
        if not isinstance(allowed, list) or service_type not in allowed:
            check["reason"] = "The supplied land record does not permit this service type."
            continue
        if not area.intersects(parcel):
            check["reason"] = "Plot lies outside the selected area."
            continue
        if parcel.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError("Candidate plots must be polygons")
        parts = list(parcel.geoms) if parcel.geom_type == "MultiPolygon" else [parcel]
        anchors = [parcel.representative_point()]
        for part in parts:
            anchors.extend([part.representative_point(), part.centroid])
            minx, miny, maxx, maxy = part.bounds
            for row in range(5):
                for col in range(5):
                    anchors.append(Point(minx+(col+0.5)*(maxx-minx)/5, miny+(row+0.5)*(maxy-miny)/5))
            if len(anchors) >= 81:
                break
        seen, best = set(), None
        for anchor_index, point in enumerate(anchors[:81]):
            key = (round(point.x, 8), round(point.y, 8))
            if key in seen:
                continue
            seen.add(key)
            for rotation in (0, 90):
                width = building["width_m"] if rotation == 0 else building["depth_m"]
                depth = building["depth_m"] if rotation == 0 else building["width_m"]
                footprint = box(point.x-width/2, point.y-depth/2, point.x+width/2, point.y+depth/2)
                clearance = footprint.buffer(building["setback_m"], join_style=2) if building["setback_m"] else footprint
                if not parcel.covers(clearance) or not area.covers(clearance):
                    continue
                if clearance.intersects(buildings_union) or clearance.intersects(roads_union) or clearance.intersects(restricted_union):
                    continue
                metrics, origin = score(parcel)
                rank = (anchor_index, rotation)
                if best is None or rank < best[0]:
                    longitude, latitude = unproject(point.x, point.y)
                    candidate = {"id": site_id, "longitude": longitude, "latitude": latitude, **metrics,
                        "footprint": mapping(transform(unproject, footprint)), "land_check": {
                            "source": source, "land_status": "available", "allowed_service": True,
                            "plot_fit": True, "area_fit": True, "no_building_overlap": True, "no_road_overlap": True, "no_restriction_overlap": True,
                            "setback_m": building["setback_m"], "rotation_deg": rotation,
                            "footprint_area_m2": building["width_m"]*building["depth_m"]}}
                    best = (rank, candidate, origin)
        if best is None:
            check["reason"] = "No fitting footprint found by bounded search with the requested setback, area and obstruction constraints."
        else:
            check.update(status="eligible", reason="Footprint and setback fit the supplied plot, area, land-use record and obstruction inventory.")
            candidates.append(best[1:])
    candidates.sort(key=lambda item: (
        -(item[0]["nearest_existing_service_m"] if item[0]["nearest_existing_service_m"] is not None else math.inf),
        -item[0]["plot_area_m2"], item[0]["id"]))
    ranked = [item[0] for item in candidates]
    preferred_point = candidates[0][1] if candidates else None
    existing_services_in_area = existing_service_counts[service_type]
    service_inventory = request.get("service_inventory")
    if not isinstance(service_inventory, dict):
        service_inventory = {
            "source": "No service inventory provenance supplied",
            "as_of": None,
            "record_counts_scope": "supplied service feature records whose representative point is in the study area",
            "completeness_by_type": {kind: "unknown" for kind in SUPPORTED_SERVICES},
        }
    mapped = []
    for feature, geom in matching_services:
        distance = preferred_point.distance(geom) if preferred_point is not None else None
        row = dict(feature)
        row["properties"] = dict(feature["properties"])
        row["properties"]["nearest_m"] = distance if distance is not None and math.isfinite(distance) else None
        row["properties"]["underserved"] = bool(distance is None or distance > threshold)
        mapped.append(row)
    result = {"mode": "scenario", "metrics": {
        "analysis_crs": request["projected_crs"], "threshold_m": int(threshold), "service_type": service_type,
        "study_area": request["study_area"],
        "service_features": len(matching_services), "existing_services_in_area": existing_services_in_area,
        "existing_service_counts": existing_service_counts, "service_inventory": service_inventory,
        "sites_evaluated": len(sites), "eligible_sites": len(ranked), "site_checks": checks,
        "land_inventory": {key: inventory[key] for key in ("building_coverage", "road_coverage", "restriction_coverage", "source", "as_of")},
        "candidates": ranked[:3], "building": building, "baseline_scope": "supplied matching service features",
        "inventory_status": "matching services supplied" if matching_services else "no matching service inventory supplied", "ranking_basis": BASIS},
        "comparison": {"preferred_candidate": ranked[0]["id"] if ranked else None, "basis": BASIS}}
    # Match the JSON wire representation (mapping() returns tuples).
    return json.loads(json.dumps(result, allow_nan=False)), {"type": "FeatureCollection", "features": mapped}


if __name__ == "__main__":
    with open("/input/request.json", encoding="utf-8") as f:
        result, mapped = calculate(json.load(f))
    with open("/output/result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, allow_nan=False, separators=(",", ":"))
    with open("/output/result.geojson", "w", encoding="utf-8") as f:
        json.dump(mapped, f, allow_nan=False, separators=(",", ":"))
