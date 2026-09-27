"""Build an official East Harlem land-fit extract from NYC open data.

Trusted preparation utility. Requires Shapely and pyproj.
Run: python data/real-nyc-land/prepare_snapshot.py --fetch
"""
from __future__ import annotations

import argparse
import hashlib
import json
import ssl
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

import shapely
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, MultiPolygon, mapping, shape
from shapely.ops import transform, unary_union
from shapely.validation import make_valid


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
STUDY = [-73.955, 40.790, -73.930, 40.812]
CONTEXT_M = 80
MAX_SITES = 80
SIMPLIFY_DEG = 0.00008
USER_AGENT = "Geoscope-data-prep/1.0"
MAPPLUTO = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query"
BUILDINGS = "https://data.cityofnewyork.us/resource/5zhs-2jue.geojson"
STREETS = "https://data.cityofnewyork.us/resource/inkn-q76z.geojson"
NYC_SNAPSHOT = ROOT.parent / "real-nyc" / "nyc-facilities-census.geojson"
PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:32618", always_xy=True).transform
UNPROJECT = Transformer.from_crs("EPSG:32618", "EPSG:4326", always_xy=True).transform
ALLOWED = ["clinic", "library", "school", "community_center"]
LOT_SOURCE = (
    "NYC DCP MapPLUTO vacant land (LandUse 11). This is the official tax-lot classification, "
    "not a finding that the lot is for sale, vacant of all use, or approved for construction."
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=180, context=ssl.create_default_context()) as response:
        return response.read()


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def polygon_parts(geom):
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in {"MultiPolygon", "GeometryCollection"}:
        return [part for child in geom.geoms for part in polygon_parts(child)]
    return []


def cleaned_polygon(geom):
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    if SIMPLIFY_DEG:
        simplified = geom.simplify(SIMPLIFY_DEG, preserve_topology=True)
        if not simplified.is_empty:
            geom = simplified if simplified.is_valid else make_valid(simplified)
    parts = polygon_parts(geom)
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def intersects_box(geom, box):
    west, south, east, north = box
    stack = [geom]
    while stack:
        value = stack.pop()
        if isinstance(value, (list, tuple)) and len(value) >= 2 and isinstance(value[0], (int, float)):
            if west <= float(value[0]) <= east and south <= float(value[1]) <= north:
                return True
        elif isinstance(value, (list, tuple)):
            stack.extend(value)
    return False


def fetch_mappluto_vacant() -> dict:
    features = []
    offset = 0
    while True:
        params = {
            "where": "LandUse='11'",
            "geometry": f"{STUDY[0]},{STUDY[1]},{STUDY[2]},{STUDY[3]}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "Borough,Block,Lot,Address,ZipCode,LandUse,BldgClass,OwnerName,LotArea,LotFront,LotDepth,BuiltFAR,FacilFAR,NumBldgs,YearBuilt,BBL,ZoneDist1",
            "outSR": "4326",
            "f": "geojson",
            "resultRecordCount": "200",
            "resultOffset": str(offset),
        }
        payload = json.loads(fetch(MAPPLUTO + "?" + urllib.parse.urlencode(params)))
        batch = payload.get("features") or []
        features.extend(batch)
        if len(batch) < 200:
            break
        offset += 200
        if offset > 2000:
            break
    return {"type": "FeatureCollection", "features": features}


def fetch_paged_geojson(base: str) -> dict:
    west, south, east, north = STUDY
    features = []
    offset = 0
    while True:
        params = {
            "$where": f"within_box(the_geom,{north},{west},{south},{east})",
            "$limit": "2000",
            "$offset": str(offset),
        }
        payload = json.loads(fetch(base + "?" + urllib.parse.urlencode(params)))
        batch = payload.get("features") or []
        features.extend(batch)
        if len(batch) < 2000:
            break
        offset += 2000
        if offset > 20000:
            break
    return {"type": "FeatureCollection", "features": features}


def fetch_raw() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    write_json(RAW / "mappluto-vacant.geojson", fetch_mappluto_vacant())
    write_json(RAW / "buildings.geojson", fetch_paged_geojson(BUILDINGS))
    write_json(RAW / "streets.geojson", fetch_paged_geojson(STREETS))


def line_parts(geom):
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type == "MultiLineString":
        return list(geom.geoms)
    return []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", action="store_true")
    args = parser.parse_args()
    if args.fetch:
        fetch_raw()

    lots_raw = json.loads((RAW / "mappluto-vacant.geojson").read_text(encoding="utf-8"))
    buildings_raw = json.loads((RAW / "buildings.geojson").read_text(encoding="utf-8"))
    streets_raw = json.loads((RAW / "streets.geojson").read_text(encoding="utf-8"))
    city = json.loads(NYC_SNAPSHOT.read_text(encoding="utf-8"))

    ranked = []
    for feature in lots_raw["features"]:
        props = feature.get("properties") or {}
        geom = cleaned_polygon(shape(feature["geometry"]) if feature.get("geometry") else None)
        if geom is None:
            continue
        area = props.get("LotArea")
        try:
            lot_area = float(area)
        except (TypeError, ValueError):
            lot_area = 0
        ranked.append((lot_area, props, geom))
    ranked.sort(key=lambda item: item[0], reverse=True)
    ranked = ranked[:MAX_SITES]
    lots = []
    for lot_area, props, geom in ranked:
        bbl = str(int(props["BBL"])) if props.get("BBL") not in (None, "") else f"{props.get('Borough')}{props.get('Block')}{props.get('Lot')}"
        lots.append({
            "type": "Feature",
            "id": "lot-" + bbl,
            "properties": {
                "layer": "candidate_site",
                "id": bbl,
                "name": props.get("Address") or f"BBL {bbl}",
                "land_status": "available",
                "allowed_services": ALLOWED,
                "source": LOT_SOURCE,
                "borough": props.get("Borough"),
                "address": props.get("Address"),
                "zipcode": props.get("ZipCode"),
                "landuse": "11",
                "landuse_label": "Vacant land",
                "building_class": props.get("BldgClass"),
                "owner_name": props.get("OwnerName"),
                "lot_area_sqft": lot_area,
                "lot_front_ft": props.get("LotFront"),
                "lot_depth_ft": props.get("LotDepth"),
                "facility_far": props.get("FacilFAR"),
                "zoning": props.get("ZoneDist1"),
                "bbl": bbl,
            },
            "geometry": mapping(geom),
        })
    if not lots:
        raise SystemExit("No MapPLUTO vacant lots in the study area.")

    lot_union = transform(PROJECT, unary_union([shape(f["geometry"]) for f in lots]))
    context = lot_union.buffer(CONTEXT_M)

    buildings, skipped_buildings = [], Counter()
    for feature in buildings_raw["features"]:
        props = feature.get("properties") or {}
        geom = cleaned_polygon(shape(feature["geometry"]) if feature.get("geometry") else None)
        if geom is None:
            skipped_buildings["empty"] += 1
            continue
        if not context.intersects(transform(PROJECT, geom)):
            continue
        bin_id = str(props.get("bin") or props.get("doitt_id") or len(buildings))
        height = props.get("height_roof")
        try:
            height_m = float(height) * 0.3048 if height not in (None, "") else None
        except (TypeError, ValueError):
            height_m = None
        building = {
            "type": "Feature",
            "id": "building-" + bin_id,
            "properties": {
                "layer": "building",
                "id": bin_id,
                "name": f"NYC building BIN {bin_id}",
                "bin": bin_id,
                "bbl": props.get("base_bbl") or props.get("mappluto_bbl"),
                "source": "NYC DoITT Building Footprints",
                "construction_year": props.get("construction_year"),
            },
            "geometry": mapping(geom),
        }
        if height_m and 0 < height_m <= 150:
            building["properties"]["height_m"] = round(height_m, 1)
        buildings.append(building)

    roads, skipped_roads = [], Counter()
    for feature in streets_raw["features"]:
        props = feature.get("properties") or {}
        geom = shape(feature["geometry"]) if feature.get("geometry") else None
        if geom is None or geom.is_empty:
            skipped_roads["empty"] += 1
            continue
        projected = transform(PROJECT, geom)
        if not context.intersects(projected):
            continue
        width_ft = props.get("streetwidth")
        try:
            width_m = float(width_ft) * 0.3048 if width_ft not in (None, "") else 10.0
        except (TypeError, ValueError):
            width_m = 10.0
        width_m = min(max(width_m, 4.0), 40.0)
        buffered = projected.buffer(width_m / 2, cap_style=2, join_style=2)
        if buffered.is_empty:
            skipped_roads["empty buffer"] += 1
            continue
        corridor = cleaned_polygon(transform(UNPROJECT, buffered))
        if corridor is None:
            skipped_roads["unrepairable"] += 1
            continue
        street_id = str(props.get("physicalid") or props.get("objectid") or len(roads))
        roads.append({
            "type": "Feature",
            "id": "road-" + street_id,
            "properties": {
                "layer": "restricted",
                "restriction_type": "mapped_road_corridor",
                "id": street_id,
                "name": "NYC street centerline corridor",
                "source": "NYC Street Centerline (CSCL)",
                "modeled_width_m": round(width_m, 1),
            },
            "geometry": mapping(corridor),
        })

    observed = []
    for feature in city["features"]:
        layer = feature["properties"]["layer"]
        if layer == "service":
            if intersects_box(feature["geometry"]["coordinates"], STUDY):
                observed.append(feature)
        elif layer in {"population", "park"}:
            if intersects_box(feature["geometry"]["coordinates"], STUDY):
                observed.append(feature)

    service_counts = Counter(
        f["properties"]["service_type"] for f in observed if f["properties"]["layer"] == "service"
    )
    combined = {
        "type": "FeatureCollection",
        "name": "East Harlem official vacant lots, buildings, streets, and 2020 Census",
        "bbox": STUDY,
        "scenario_status": "OFFICIAL_EXTRACT",
        "service_inventory": {
            "source": "NYC City Planning Facilities Database extract for the East Harlem study rectangle",
            "as_of": date.today().isoformat(),
            "record_counts_scope": "FacDB clinic, library, school, and community-center points whose coordinates fall in the study rectangle",
            "completeness_by_type": {kind: "official_extract_not_complete" for kind in ALLOWED},
            "license": "NYC Open Data Terms of Use",
        },
        "land_inventory": {
            "source": "NYC DCP MapPLUTO vacant lots, DoITT building footprints, and CSCL street centerlines buffered by tagged street width; complete for the selected lots in this extract",
            "as_of": date.today().isoformat(),
            "building_coverage": "complete_for_candidate_sites",
            "restriction_coverage": "complete_for_candidate_sites",
            "road_coverage": "complete_for_candidate_sites",
            "observed_context_completeness": "official_extract_near_selected_lots",
            "site_geometry_is_simulated": False,
            "land_status_semantics": "land_status=available means MapPLUTO classified the tax lot as vacant land. It is not evidence of sale, permission, environmental clearance, or constructibility.",
        },
        "features": lots + buildings + roads + observed,
    }
    target = ROOT / "nyc-east-harlem-land.geojson"
    target.write_text(json.dumps(combined, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    manifest = {
        "id": "nyc-east-harlem-land",
        "kind": "official_extract",
        "synthetic": False,
        "title": combined["name"],
        "crs": "EPSG:4326",
        "study_area_wsen": STUDY,
        "dataset_file": target.name,
        "sha256": digest(target),
        "bytes": target.stat().st_size,
        "counts": {
            "candidate_site_features": len(lots),
            "building_features": len(buildings),
            "road_corridor_features": len(roads),
            "observed_city_features": len(observed),
            "service_counts": dict(service_counts),
            "source_vacant_lots": len(lots_raw["features"]),
            "source_buildings": len(buildings_raw["features"]),
            "source_streets": len(streets_raw["features"]),
            "skipped_buildings": dict(skipped_buildings),
            "skipped_roads": dict(skipped_roads),
        },
        "sources": [
            {"id": "mappluto", "title": "NYC DCP MapPLUTO vacant land polygons", "url": MAPPLUTO, "filter": "LandUse=11 intersecting East Harlem study rectangle; up to 80 largest lots"},
            {"id": "building_footprints", "title": "NYC DoITT Building Footprints", "url": BUILDINGS, "filter": f"Footprints intersecting an {CONTEXT_M} m buffer of the selected vacant lots"},
            {"id": "cscl", "title": "NYC Street Centerline", "url": STREETS, "filter": f"Centerlines intersecting an {CONTEXT_M} m buffer, buffered by CSCL streetwidth"},
            {"id": "nyc_facilities_census", "title": "Bundled NYC official snapshot", "file": "data/real-nyc/nyc-facilities-census.geojson", "filter": "Population, park, and FacDB service features intersecting the study rectangle"},
        ],
        "preparation": {
            "script": "data/real-nyc-land/prepare_snapshot.py",
            "shapely_version": shapely.__version__,
            "context_buffer_m": CONTEXT_M,
        },
        "limitations": [
            "MapPLUTO LandUse 11 is a tax-lot vacancy class, not a listing of sites offered for a clinic or other facility.",
            "Building footprints and buffered street centerlines are official inventories for this extract, not a construction survey or curb-accurate right-of-way.",
            "Zoning, ownership, contamination, access, and permits are not established.",
            "Only lots and nearby obstructions in this East Harlem rectangle are included.",
        ],
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"dataset": str(target), "bytes": manifest["bytes"], "counts": manifest["counts"]}, indent=2))


if __name__ == "__main__":
    main()
