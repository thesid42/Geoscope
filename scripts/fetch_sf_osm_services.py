#!/usr/bin/env python3
"""Fetch and normalize an explicitly scoped OpenStreetMap service snapshot for SF demo."""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.error
import urllib.parse
import ssl
import urllib.request

try:
    import certifi
except ImportError:  # pragma: no cover
    certifi = None

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "real-scenario"
RAW_PATH = OUT_DIR / "sf-osm-services-raw.json"
GEOJSON_PATH = OUT_DIR / "sf-osm-services.geojson"
MANIFEST_PATH = OUT_DIR / "sf-osm-services-manifest.json"
BOUNDS_WEST_SOUTH_EAST_NORTH = [-122.44, 37.753, -122.409, 37.781]
SOUTH, WEST, NORTH, EAST = 37.753, -122.44, 37.781, -122.409
ENDPOINTS = (
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
QUERY = (
    "[out:json][timeout:45];("
    f'nwr["amenity"~"^(clinic|library|school|community_centre)$"]({SOUTH},{WEST},{NORTH},{EAST});'
    f'nwr["healthcare"="clinic"]({SOUTH},{WEST},{NORTH},{EAST});'
    ");out center tags;"
)
SERVICE_TYPES = {
    "clinic": "clinic", "library": "library", "school": "school",
    "community_centre": "community_center",
}
ATTRIBUTION = chr(0x00A9) + " OpenStreetMap contributors"
OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright"
ODBL = "https://opendatacommons.org/licenses/odbl/1-0/"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(timeout: int) -> tuple[bytes, str]:
    errors = []
    for endpoint in ENDPOINTS:
        url = endpoint + "?" + urllib.parse.urlencode({"data": QUERY})
        req = urllib.request.Request(url, headers={"User-Agent": "GeoScopeSFScenario/1.0 (OpenStreetMap Overpass extract)"})
        try:
            ssl_context = ssl.create_default_context(cafile=certifi.where()) if certifi else None
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                raw = response.read()
            parsed = json.loads(raw)
            if not isinstance(parsed.get("elements"), list) or not parsed.get("osm3s", {}).get("timestamp_osm_base"):
                raise ValueError("Overpass response is missing elements or OSM base timestamp")
            return raw, endpoint
        except Exception as exc:
            errors.append(f"{endpoint}: {type(exc).__name__}: {exc}")
    raise RuntimeError("All Overpass endpoints failed: " + "; ".join(errors))


def normalized(raw_bytes: bytes, endpoint: str) -> tuple[dict, dict]:
    raw = json.loads(raw_bytes)
    source_timestamp = raw["osm3s"]["timestamp_osm_base"]
    features = []
    seen = set()
    excluded = Counter()
    counts = Counter()
    for element in raw["elements"]:
        osm_type, osm_id = element.get("type"), element.get("id")
        if osm_type not in {"node", "way", "relation"} or not isinstance(osm_id, int):
            excluded["invalid_osm_identity"] += 1
            continue
        identity = (osm_type, osm_id)
        if identity in seen:
            excluded["duplicate_osm_identity"] += 1
            continue
        seen.add(identity)
        tags = element.get("tags") if isinstance(element.get("tags"), dict) else {}
        amenity, healthcare = tags.get("amenity"), tags.get("healthcare")
        # OSM lifecycle tags mean the site is not an operating facility; do not count it.
        lifecycle = any(
            tags.get(key) not in (None, "", "no", "false", "0")
            for key in ("disused", "abandoned", "demolished")
        ) or any(key.startswith(("disused:", "abandoned:", "demolished:")) for key in tags) or (
            isinstance(amenity, str) and amenity.startswith(("disused:", "abandoned:", "demolished:"))
        )
        if lifecycle:
            excluded["lifecycle_tagged"] += 1
            continue
        if amenity in SERVICE_TYPES:
            service_type = SERVICE_TYPES[amenity]
        elif healthcare == "clinic":
            service_type = "clinic"
        else:
            excluded["unsupported_tags"] += 1
            continue
        if osm_type == "node":
            lon, lat = element.get("lon"), element.get("lat")
        else:
            center = element.get("center") or {}
            lon, lat = center.get("lon"), center.get("lat")
        if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            excluded["missing_point_or_center"] += 1
            continue
        props = {
            "layer": "service", "service_type": service_type,
            "name": tags.get("name") or tags.get("official_name") or "Unnamed mapped facility",
            "source": f"{ATTRIBUTION}; OSM {osm_type}/{osm_id} (ODbL)",
            "osm_type": osm_type, "osm_id": osm_id,
            "osm_url": f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
            "source_timestamp": source_timestamp,
            "location_method": "node coordinate" if osm_type == "node" else "Overpass element center",
        }
        if amenity is not None:
            props["osm_amenity"] = amenity
        if healthcare is not None:
            props["osm_healthcare"] = healthcare
        for key in ("opening_hours", "website", "phone", "operator"):
            if isinstance(tags.get(key), str):
                props[key] = tags[key]
        features.append({
            "type": "Feature", "id": f"osm-{osm_type}-{osm_id}",
            "properties": props,
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
        })
        counts[service_type] += 1
    inventory = {
        "source": f"OpenStreetMap via Overpass API ({endpoint})",
        "as_of": source_timestamp[:10],
        "source_timestamp": source_timestamp,
        "record_counts_scope": "OSM features with the query tags, placed at node coordinates or Overpass way/relation centers; this extract is not a definitive directory",
        "completeness_by_type": {kind: "mapped_extract_not_complete" for kind in SERVICE_TYPES.values()},
        "license": "Open Database License (ODbL) 1.0",
        "attribution": ATTRIBUTION,
        "attribution_url": OSM_COPYRIGHT,
    }
    geojson = {
        "type": "FeatureCollection", "name": "San Francisco OSM mapped service features (snapshot)",
        "bbox": BOUNDS_WEST_SOUTH_EAST_NORTH,
        "service_inventory": inventory,
        "features": features,
    }
    manifest = {
        "dataset_id": "sf-osm-services",
        "downloaded_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "endpoint": endpoint, "query": QUERY,
        "query_bbox_wsen": BOUNDS_WEST_SOUTH_EAST_NORTH,
        "osm_data_timestamp": source_timestamp,
        "attribution": ATTRIBUTION,
        "attribution_url": OSM_COPYRIGHT,
        "license": "Open Database License (ODbL) 1.0",
        "license_url": ODBL,
        "raw": {"file": RAW_PATH.name, "bytes": len(raw_bytes), "sha256": digest(raw_bytes)},
        "normalized": {"file": GEOJSON_PATH.name, "feature_count": len(features), "counts_by_service_type": dict(sorted(counts.items())), "excluded_records": dict(sorted(excluded.items()))},
        "method": "One feature per unique OSM node/way/relation. Point nodes retain their coordinates; ways and relations use the center returned by Overpass. Amenity clinic/library/school/community_centre and healthcare=clinic are mapped to GeoScope service types. Explicit lifecycle-tagged facilities are excluded.",
        "limitations": [
            "OpenStreetMap is community-mapped, not an official or exhaustive directory; zero records never establishes absence.",
            "Way and relation locations use Overpass center, not exact entrances or surveyed service points.",
            "A tagged facility may have stale operating status unless explicitly lifecycle-tagged; verify before real-world decisions.",
            "OSM school and community centre tags identify mapped facility features, not building counts.",
        ],
        "raw_sha256": digest(raw_bytes),
    }
    return geojson, manifest


def write_files(raw_bytes: bytes, endpoint: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    geojson, manifest = normalized(raw_bytes, endpoint)
    geo_bytes = (json.dumps(geojson, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    manifest["normalized"]["bytes"] = len(geo_bytes)
    manifest["normalized"]["sha256"] = digest(geo_bytes)
    RAW_PATH.write_bytes(raw_bytes)
    GEOJSON_PATH.write_bytes(geo_bytes)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Raw OSM response: {len(raw_bytes):,} bytes ({len(raw_bytes)/1024:.1f} KiB)")
    print(f"Normalized GeoJSON: {len(geo_bytes):,} bytes ({len(geo_bytes)/1024:.1f} KiB), {len(geojson['features'])} facilities")
    print("Counts:", json.dumps(manifest["normalized"]["counts_by_service_type"], sort_keys=True))
    print("OSM base timestamp:", manifest["osm_data_timestamp"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true", help="normalize the bundled raw response without network access")
    parser.add_argument("--timeout", type=int, default=65, help="seconds per Overpass endpoint request (default: 65)")
    args = parser.parse_args()
    if args.prepare_only:
        raw_bytes = RAW_PATH.read_bytes()
        # Preserve the endpoint associated with the current bundled snapshot.
        try:
            endpoint = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["endpoint"]
        except (OSError, ValueError, KeyError, TypeError):
            endpoint = ENDPOINTS[0]
    else:
        raw_bytes, endpoint = fetch(args.timeout)
    write_files(raw_bytes, endpoint)


if __name__ == "__main__":
    main()
