#!/usr/bin/env python3
"""Fetch and normalize compact OSM building/road context around SF mock sites."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

from pyproj import Transformer
from shapely.geometry import LineString, Polygon, mapping
from shapely.ops import transform

try:
    from .sf_scenario_sites import SITES, STUDY_BOUNDS_WEST_SOUTH_EAST_NORTH
except ImportError:  # Direct script execution.
    from sf_scenario_sites import SITES, STUDY_BOUNDS_WEST_SOUTH_EAST_NORTH

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "real-scenario"
RAW_PATH = OUT_DIR / "sf-osm-land-context-raw.json"
GEOJSON_PATH = OUT_DIR / "sf-osm-land-context.geojson"
MANIFEST_PATH = OUT_DIR / "sf-osm-land-context-manifest.json"
ENDPOINTS = (
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
RADIUS_M = 120
QUERY = "[out:json][timeout:60];(" + "".join(
    f'way["building"](around:{RADIUS_M},{site["center"][1]},{site["center"][0]});'
    f'way["highway"](around:{RADIUS_M},{site["center"][1]},{site["center"][0]});'
    for site in SITES
) + ");out geom tags;"
ATTRIBUTION = chr(0x00A9) + " OpenStreetMap contributors"
OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright"
ODBL = "https://opendatacommons.org/licenses/odbl/1-0/"
PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:32610", always_xy=True).transform
UNPROJECT = Transformer.from_crs("EPSG:32610", "EPSG:4326", always_xy=True).transform
ROAD_WIDTH_M = {
    "motorway": 24, "trunk": 20, "primary": 18, "secondary": 16,
    "tertiary": 14, "residential": 10, "unclassified": 10,
    "living_street": 8, "pedestrian": 8, "service": 7,
    "cycleway": 4, "footway": 3, "path": 2, "steps": 3, "track": 4,
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(timeout: int) -> tuple[bytes, str]:
    errors = []
    for endpoint in ENDPOINTS:
        request = urllib.request.Request(
            endpoint + "?" + urllib.parse.urlencode({"data": QUERY}),
            headers={"User-Agent": "GeoScopeSFLandContext/1.0 (OpenStreetMap Overpass extract)"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                raw = response.read()
            payload = json.loads(raw)
            if not isinstance(payload.get("elements"), list) or not payload.get("osm3s", {}).get("timestamp_osm_base"):
                raise ValueError("Overpass response is missing elements or OSM base timestamp")
            return raw, endpoint
        except Exception as exc:
            errors.append(f"{endpoint}: {type(exc).__name__}: {exc}")
    raise RuntimeError("All Overpass endpoints failed: " + "; ".join(errors))


def _number(value) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(?:m|meter|meters)?\s*", value, re.I)
        if match:
            return float(match.group(1))
    return None


def _way_polygon(element: dict) -> Polygon | None:
    coordinates = [(item.get("lon"), item.get("lat")) for item in element.get("geometry") or []]
    if len(coordinates) < 4 or any(not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)) for lon, lat in coordinates):
        return None
    polygon = Polygon(coordinates)
    if not polygon.is_valid:
        polygon = polygon.buffer(0)
    return polygon if not polygon.is_empty and polygon.geom_type in {"Polygon", "MultiPolygon"} else None


def _road_polygon(element: dict, tags: dict) -> tuple[object, float] | None:
    coordinates = [(item.get("lon"), item.get("lat")) for item in element.get("geometry") or []]
    if len(coordinates) < 2 or any(not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)) for lon, lat in coordinates):
        return None
    width = _number(tags.get("width"))
    if width is None or not 1 <= width <= 50:
        width = float(ROAD_WIDTH_M.get(str(tags.get("highway")), 8))
    projected = transform(PROJECT, LineString(coordinates))
    buffered = projected.buffer(width / 2, cap_style=2, join_style=2)
    if buffered.is_empty:
        return None
    return transform(UNPROJECT, buffered), width


def normalized(raw_bytes: bytes, endpoint: str) -> tuple[dict, dict]:
    raw = json.loads(raw_bytes)
    timestamp = raw["osm3s"]["timestamp_osm_base"]
    features = []
    counts = Counter()
    seen = set()
    for element in raw["elements"]:
        if element.get("type") != "way" or not isinstance(element.get("id"), int):
            continue
        osm_id = element["id"]
        tags = element.get("tags") if isinstance(element.get("tags"), dict) else {}
        source = f"{ATTRIBUTION}; OSM way/{osm_id} (ODbL), snapshot {timestamp}"
        common = {
            "source": source, "osm_type": "way", "osm_id": osm_id,
            "osm_url": f"https://www.openstreetmap.org/way/{osm_id}",
            "source_timestamp": timestamp, "scenario_only": False,
        }
        if "building" in tags and ("building", osm_id) not in seen:
            seen.add(("building", osm_id))
            polygon = _way_polygon(element)
            if polygon is not None:
                properties = {
                    **common, "layer": "building", "name": tags.get("name") or "Mapped building footprint",
                    "osm_building": tags.get("building"), "context_scope": "candidate-site building check",
                }
                height = _number(tags.get("height"))
                if height is not None and 0 < height <= 150:
                    properties["height_m"] = height
                features.append({"type": "Feature", "id": f"osm-land-building-{osm_id}", "properties": properties, "geometry": mapping(polygon)})
                counts["buildings"] += 1
        if "highway" in tags and ("road", osm_id) not in seen:
            seen.add(("road", osm_id))
            road = _road_polygon(element, tags)
            if road is not None:
                polygon, width = road
                features.append({
                    "type": "Feature", "id": f"osm-land-road-{osm_id}",
                    "properties": {
                        **common, "layer": "restricted", "name": tags.get("name") or "Mapped transport corridor",
                        "restriction_type": "mapped_road_corridor", "osm_highway": tags.get("highway"),
                        "modeled_width_m": width, "context_scope": "candidate-site road check",
                    },
                    "geometry": mapping(polygon),
                })
                counts["road_corridors"] += 1

    geojson = {
        "type": "FeatureCollection", "name": "SF OSM building and transport context around mock sites",
        "bbox": STUDY_BOUNDS_WEST_SOUTH_EAST_NORTH, "features": features,
        "land_context_inventory": {
            "source": f"OpenStreetMap via Overpass API ({endpoint})", "as_of": timestamp[:10],
            "source_timestamp": timestamp, "radius_m": RADIUS_M,
            "coverage": "mapped ways near the seven simulated candidate sites; community-mapped and not certified complete",
            "road_method": "OSM highway centerlines buffered by tagged width or documented class default",
            "license": "Open Database License (ODbL) 1.0", "attribution": ATTRIBUTION,
            "attribution_url": OSM_COPYRIGHT,
        },
    }
    manifest = {
        "dataset_id": "sf-osm-land-context", "downloaded_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "endpoint": endpoint, "query": QUERY, "candidate_site_ids": [site["id"] for site in SITES],
        "query_radius_m": RADIUS_M, "osm_data_timestamp": timestamp,
        "attribution": ATTRIBUTION, "attribution_url": OSM_COPYRIGHT,
        "license": "Open Database License (ODbL) 1.0", "license_url": ODBL,
        "raw": {"file": RAW_PATH.name, "bytes": len(raw_bytes), "sha256": digest(raw_bytes)},
        "normalized": {"file": GEOJSON_PATH.name, "feature_count": len(features), "counts": dict(sorted(counts.items()))},
        "road_width_defaults_m": ROAD_WIDTH_M,
        "method": "Deduplicate OSM ways returned within 120 m of each simulated site. Preserve mapped building polygons. Convert mapped highway centerlines to polygonal restricted corridors using tagged width when usable, otherwise the documented class default.",
        "limitations": [
            "OpenStreetMap is community-mapped and may omit, simplify, or contain stale buildings and transport features.",
            "Buffered road corridors are planning-screen proxies, not surveyed curb or right-of-way boundaries.",
            "Candidate plots remain simulated and this context does not establish vacancy, ownership, permission, or constructibility.",
        ],
    }
    return geojson, manifest


def write_files(raw_bytes: bytes, endpoint: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    geojson, manifest = normalized(raw_bytes, endpoint)
    geo_bytes = (json.dumps(geojson, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    manifest["normalized"].update(bytes=len(geo_bytes), sha256=digest(geo_bytes))
    RAW_PATH.write_bytes(raw_bytes)
    GEOJSON_PATH.write_bytes(geo_bytes)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Raw OSM land context: {len(raw_bytes):,} bytes")
    print(f"Normalized land context: {len(geo_bytes):,} bytes, {len(geojson['features'])} features")
    print("Counts:", json.dumps(manifest["normalized"]["counts"], sort_keys=True))
    print("OSM base timestamp:", manifest["osm_data_timestamp"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true", help="normalize the bundled raw response without network access")
    parser.add_argument("--raw-input", type=Path, help="normalize this downloaded Overpass response, then bundle it as the raw snapshot")
    parser.add_argument("--timeout", type=int, default=90, help="seconds per Overpass endpoint request")
    args = parser.parse_args()
    if args.prepare_only and args.raw_input:
        parser.error("choose either --prepare-only or --raw-input")
    if args.raw_input:
        raw_bytes = args.raw_input.read_bytes()
        endpoint = ENDPOINTS[0]
    elif args.prepare_only:
        raw_bytes = RAW_PATH.read_bytes()
        try:
            endpoint = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["endpoint"]
        except (OSError, ValueError, KeyError, TypeError):
            endpoint = ENDPOINTS[0]
    else:
        raw_bytes, endpoint = fetch(args.timeout)
    write_files(raw_bytes, endpoint)


if __name__ == "__main__":
    main()
