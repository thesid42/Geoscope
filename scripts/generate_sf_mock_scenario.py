#!/usr/bin/env python3
"""Rebuild the clearly synthetic San Francisco land-fit scenario."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "real" / "sf-parks-census.geojson"
SOURCE_MANIFEST = ROOT / "data" / "real" / "manifest.json"
SERVICE_SNAPSHOT = ROOT / "data" / "real-scenario" / "sf-osm-services.geojson"
SERVICE_MANIFEST = ROOT / "data" / "real-scenario" / "sf-osm-services-manifest.json"
OUT_DIR = ROOT / "data" / "real-scenario"
OUT_FILE = OUT_DIR / "sf-mock.geojson"
MANIFEST_FILE = OUT_DIR / "manifest.json"
SIMULATED_BOUNDS = [-122.433, 37.758, -122.417, 37.776]  # synthetic fixture region, west/south/east/north
# Full tract polygons are preserved, so the GeoJSON bbox must cover their full extent too.
BOUNDS = [-122.435794, 37.755295, -122.416567, 37.775432]
SCENARIO_AS_OF = "2026-09-26"

# Real 2020 Census population features copied without changing their source properties or geometries.
POPULATION_GEOIDS = {
    "06075016801", "06075016802", "06075016900", "06075020101", "06075020102",
    "06075020201", "06075020202", "06075020300", "06075020601", "06075020702",
    "06075020801", "06075020802",
}
ALLOWED = ["clinic", "library", "school", "community_center"]
LAND_SOURCE = "Simulated parcel for SF mock demo; not an actual availability record"

# Fixture parcels are modeled rectangles in meters at real SF coordinates, not recorded legal parcels.
SITES = [
    {"id": "sfmock-fit-01", "name": "Mock candidate A · Mission North", "center": [-122.4305, 37.7706], "size_m": [60, 50], "expected_fit": "fit"},
    {"id": "sfmock-fit-02", "name": "Mock candidate B · Mission Central", "center": [-122.4252, 37.7687], "size_m": [60, 50], "expected_fit": "fit"},
    {"id": "sfmock-fit-03", "name": "Mock candidate C · Mission East", "center": [-122.4200, 37.7727], "size_m": [60, 50], "expected_fit": "fit"},
    {"id": "sfmock-fit-04", "name": "Mock candidate D · Mission South", "center": [-122.4192, 37.7650], "size_m": [60, 50], "expected_fit": "fit"},
    {"id": "sfmock-building-blocked", "name": "Mock candidate E · building obstruction", "center": [-122.4308, 37.7628], "size_m": [60, 50], "expected_fit": "blocked_by_building"},
    {"id": "sfmock-restricted", "name": "Mock candidate F · restricted area", "center": [-122.4260, 37.7603], "size_m": [60, 50], "expected_fit": "restricted"},
    {"id": "sfmock-too-small", "name": "Mock candidate G · undersized lot", "center": [-122.4205, 37.7605], "size_m": [29, 23], "expected_fit": "too_small"},
]


def rectangle(center: list[float], width_m: float, height_m: float) -> dict[str, Any]:
    lon, lat = center
    dlon = width_m / (111_320.0 * math.cos(math.radians(lat)))
    dlat = height_m / 110_574.0
    ring = [
        [lon - dlon / 2, lat - dlat / 2], [lon + dlon / 2, lat - dlat / 2],
        [lon + dlon / 2, lat + dlat / 2], [lon - dlon / 2, lat + dlat / 2],
        [lon - dlon / 2, lat - dlat / 2],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


def feature(fid: str, properties: dict[str, Any], geometry: dict[str, Any]) -> dict[str, Any]:
    return {"type": "Feature", "id": fid, "properties": properties, "geometry": geometry}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def build() -> tuple[dict[str, Any], dict[str, Any]]:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    source_manifest = json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))
    service_snapshot = json.loads(SERVICE_SNAPSHOT.read_text(encoding="utf-8"))
    service_manifest = json.loads(SERVICE_MANIFEST.read_text(encoding="utf-8"))
    service_features = service_snapshot.get("features", [])
    if not isinstance(service_features, list) or any(f.get("properties", {}).get("layer") != "service" for f in service_features):
        raise SystemExit("OSM service snapshot must contain only layer=service features")
    by_geoid = {str(f.get("properties", {}).get("geoid")): f for f in source["features"] if f.get("properties", {}).get("layer") == "population"}
    missing = POPULATION_GEOIDS - by_geoid.keys()
    if missing:
        raise SystemExit(f"Bundled official SF population snapshot is missing selected GEOIDs: {sorted(missing)}")
    population = [by_geoid[key] for key in sorted(POPULATION_GEOIDS)]

    features: list[dict[str, Any]] = []
    # Source features are deep-copied through JSON and otherwise remain unmodified.
    features.extend(json.loads(json.dumps(population)))
    for site in SITES:
        site_geometry = rectangle(site["center"], *site["size_m"])
        features.append(feature(site["id"], {
            "layer": "candidate_site", "site_id": site["id"], "name": site["name"],
            "land_status": "available", "scenario_expected_fit": site["expected_fit"],
            "allowed_services": ALLOWED,
            "source": LAND_SOURCE,
            "scenario_only": True,
            "nominal_lot_width_m": site["size_m"][0], "nominal_lot_depth_m": site["size_m"][1],
            "required_building_width_m": 24, "required_building_depth_m": 18,
            "setback_m": 3,
        }, site_geometry))
        if site["expected_fit"] == "blocked_by_building":
            features.append(feature("sfmock-building-obstruction-01", {
                "layer": "building", "name": "Simulated existing building obstruction",
                "height_m": 8.4, "source": "Simulated building footprint for SF mock demo; not an observed building record",
                "scenario_only": True,
            }, rectangle(site["center"], 56, 46)))
        if site["expected_fit"] == "restricted":
            features.append(feature("sfmock-restricted-area-01", {
                "layer": "restricted", "name": "Simulated no-build area",
                "restriction_type": "mock_site_constraint",
                "source": "Simulated restriction for SF mock demo; not a legal or environmental restriction record",
                "scenario_only": True,
            }, rectangle(site["center"], 60, 50)))

    # Observed source records are copied verbatim from a compact, attributed OSM extract.
    features.extend(json.loads(json.dumps(service_features)))
    all_coords: list[list[float]] = []
    def collect_coords(value: Any) -> None:
        if isinstance(value, list) and len(value) >= 2 and all(isinstance(x, (int, float)) for x in value[:2]):
            all_coords.append(value[:2])
        elif isinstance(value, list):
            for item in value:
                collect_coords(item)
    for item in features:
        collect_coords(item["geometry"]["coordinates"])
    scenario_bounds = [min(x for x, _ in all_coords), min(y for _, y in all_coords), max(x for x, _ in all_coords), max(y for _, y in all_coords)]

    geojson = {
        "type": "FeatureCollection",
        "name": "San Francisco land-fit scenario (mock)",
        "bbox": scenario_bounds,
        "scenario_status": "MOCK_SIMULATION",
        "observed_population": {
            "source_dataset": "San Francisco parks + 2020 Census official snapshot",
            "source_file": "data/real/sf-parks-census.geojson",
            "source_sha256": sha256(SOURCE),
            "population_geoids": sorted(POPULATION_GEOIDS),
            "population_year": 2020,
            "synthetic": False,
        },
        "service_inventory": service_snapshot["service_inventory"],
        "land_inventory": {
            "source": "SF mock-simulation rectangles, obstructions, and restrictions; no parcel/availability records used",
            "as_of": SCENARIO_AS_OF,
            "building_coverage": "complete_for_candidate_sites",
            "restriction_coverage": "complete_for_candidate_sites",
            "land_status_semantics": "available means available only in this synthetic fixture; it is not evidence of real ownership, vacancy, legal availability, or buildability",
            "footprint_width_m": 24,
            "footprint_depth_m": 18,
            "setback_m": 3,
            "site_geometry_is_simulated": True,
        },
        "features": features,
    }
    selected_pop = sum(int(f["properties"]["population"]) for f in population)
    manifest = {
        "scenario_id": "sf-land-fit-mock",
        "scenario_status": "MOCK_SIMULATION",
        "generated_by": "scripts/generate_sf_mock_scenario.py",
        "generated_on": date.today().isoformat(),
        "bounds_wsen": scenario_bounds,
        "simulated_fixture_bounds_wsen": SIMULATED_BOUNDS,
        "population_source": {
            "dataset_id": "sf-parks-census",
            "file": "data/real/sf-parks-census.geojson",
            "sha256": sha256(SOURCE),
            "snapshot_sha256_from_source_manifest": source_manifest.get("sha256"),
            "source_manifest": "data/real/manifest.json",
            "official_source_urls": [s["url"] for s in source_manifest.get("sources", [])],
            "selected_geoid_count": len(population),
            "selected_population_sum_2020": selected_pop,
            "selected_geoids": sorted(POPULATION_GEOIDS),
            "method": "Copy the 12 listed official population tract features verbatim from the bundled normalized snapshot; no simulated population values are added.",
        },
        "service_source": {
            "dataset_id": "sf-osm-services",
            "raw_file": "data/real-scenario/sf-osm-services-raw.json",
            "raw_bytes": (OUT_DIR / "sf-osm-services-raw.json").stat().st_size,
            "raw_sha256": sha256(OUT_DIR / "sf-osm-services-raw.json"),
            "normalized_file": "data/real-scenario/sf-osm-services.geojson",
            "normalized_sha256": sha256(SERVICE_SNAPSHOT),
            "source_manifest": "data/real-scenario/sf-osm-services-manifest.json",
            "source_timestamp": service_manifest["osm_data_timestamp"],
            "counts_by_service_type": service_manifest["normalized"]["counts_by_service_type"],
            "completeness_by_type": service_snapshot["service_inventory"]["completeness_by_type"],
            "attribution": service_manifest["attribution"],
            "license": service_manifest["license"],
        },
        "simulated_features": {
            "candidate_sites": len(SITES),
            "expected_fit_cases": {x["expected_fit"]: sum(y["expected_fit"] == x["expected_fit"] for y in SITES) for x in SITES},
            "candidate_geometry_method": "Axis-aligned rectangles created from nominal meter dimensions at the specified San Francisco lon/lat centers using local degree approximations.",
            "buildings": "One simulated 56m x 46m footprint overlaps the building-blocked lot; no actual footprint source is represented.",
            "restrictions": "One simulated restriction covers the restricted test lot; no legal/environmental restriction is represented.",
            "synthetic_service_points": 0,
            "all_land_features_simulated": True,
            "availability_claim": "None. Candidate land_status is fixture logic only; city ownership and availability are unknown.",
        },
        "output_file": OUT_FILE.name,
        "output_sha256": None,
    }
    return geojson, manifest


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    data, manifest = build()
    OUT_FILE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    manifest["output_sha256"] = sha256(OUT_FILE)
    MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_FILE.relative_to(ROOT)} ({len(data['features'])} features; {manifest['population_source']['selected_population_sum_2020']:,} observed 2020 population).")
    print("Candidate land, buildings, and restrictions are simulated; service features are mapped OSM records. No real land availability is claimed.")


if __name__ == "__main__":
    main()
