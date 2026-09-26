"""Rebuild the bundled SF sample from the adjacent official raw snapshots.

Trusted preparation utility, never an agent-generated program. Requires Shapely.
Run: python data/real/prepare_snapshot.py
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import shapely
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.validation import make_valid


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
PARK_TYPES = {
    "Neighborhood Park or Playground", "Mini Park", "Regional Park",
    "Civic Plaza or Square", "Parkway",
}
SOURCES = [
    {
        "id": "sf_recpark", "raw_file": "raw/parks.geojson",
        "title": "San Francisco Recreation and Parks Properties",
        "url": "https://data.sfgov.org/resource/gtr9-ntp6.geojson?$limit=5000&$order=property_id",
        "metadata_url": "https://data.sf.gov/Culture-and-Recreation/Recreation-and-Parks-Properties/gtr9-ntp6/about_data",
        "license": "Open Data Commons Public Domain Dedication and License (PDDL)",
        "vintage": "Live inventory snapshot; row data_as_of dates retained",
    },
    {
        "id": "sf_tracts_2020", "raw_file": "raw/tracts.geojson",
        "title": "Census 2020: Tracts for San Francisco",
        "url": "https://data.sfgov.org/resource/tmph-tgz9.geojson?$limit=1000&$order=geoid",
        "metadata_url": "https://data.sf.gov/Geographic-Locations-and-Boundaries/Census-2020-Tracts-for-San-Francisco/tmph-tgz9/1000",
        "license": "Open Data Commons Public Domain Dedication and License (PDDL)",
        "vintage": "2020 Census tracts; source row data_as_of 2021-02-01",
    },
    {
        "id": "census2020_population", "raw_file": "raw/population.json",
        "title": "U.S. Census Bureau TIGERweb Census2020 Census Tracts POP100",
        "url": "https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/tigerWMS_Census2020/MapServer/6/query?where=STATE%3D%2706%27%20AND%20COUNTY%3D%27075%27&outFields=GEOID,NAME,POP100&returnGeometry=false&f=json",
        "metadata_url": "https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/tigerWMS_Census2020/MapServer/6",
        "license": "U.S. Census Bureau public data; source attribution retained",
        "vintage": "2020 Census POP100 total population; January 1, 2020 tract boundaries",
    },
]


def read(name):
    return json.loads((RAW / name).read_bytes())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def polygon_parts(geom):
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in {"MultiPolygon", "GeometryCollection"}:
        return [part for child in geom.geoms for part in polygon_parts(child)]
    return []


def main():
    parks_raw, tracts_raw, population_raw = read("parks.geojson"), read("tracts.geojson"), read("population.json")
    assert not population_raw.get("exceededTransferLimit"), "Census response was truncated"
    population = {row["attributes"]["GEOID"]: row["attributes"]["POP100"] for row in population_raw["features"]}
    assert len(population) == len(population_raw["features"]), "Duplicate Census GEOIDs"
    excluded, repaired, parks = Counter(), [], []
    for feature in parks_raw["features"]:
        p = feature["properties"]
        if p.get("city") != "San Francisco":
            excluded["outside San Francisco"] += 1
            continue
        if p.get("propertytype") not in PARK_TYPES:
            excluded["property type: " + str(p.get("propertytype"))] += 1
            continue
        geom = shape(feature["geometry"]) if feature.get("geometry") else None
        if geom is None or geom.is_empty:
            excluded["empty geometry"] += 1
            continue
        if not geom.is_valid:
            parts = polygon_parts(make_valid(geom))
            if not parts:
                excluded["unrepairable geometry"] += 1
                continue
            geom = parts[0] if len(parts) == 1 else MultiPolygon(parts)
            assert geom.is_valid, f"Repair invalid for {p['property_id']}"
            repaired.append({"id": p["property_id"], "name": p["property_name"]})
        parks.append({
            "type": "Feature", "id": "park-" + p["property_id"],
            "properties": {
                "layer": "park", "id": p["property_id"], "name": p["property_name"],
                "property_type": p["propertytype"], "source": "sf_recpark",
                "data_as_of": p.get("data_as_of"),
            }, "geometry": mapping(geom),
        })
    tracts = []
    for feature in tracts_raw["features"]:
        p = feature["properties"]
        geom = shape(feature["geometry"])
        assert geom.is_valid and not geom.is_empty, f"Invalid tract {p['geoid']}"
        value = population[p["geoid"]]
        assert isinstance(value, (int, float)) and value >= 0 and float(value).is_integer()
        tracts.append({
            "type": "Feature", "id": "tract-" + p["geoid"],
            "properties": {
                "layer": "population", "id": p["geoid"], "geoid": p["geoid"],
                "name": p["namelsad"], "population": int(value), "population_year": 2020,
                "source": "sf_tracts_2020 + census2020_population",
            }, "geometry": mapping(geom),
        })
    assert {f["properties"]["geoid"] for f in tracts} == set(population), "Tract join mismatch"
    combined = {
        "type": "FeatureCollection", "name": "San Francisco parks and 2020 Census population (official snapshot)",
        "features": tracts + parks,
    }
    target = ROOT / "sf-parks-census.geojson"
    target.write_text(json.dumps(combined, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    for source in SOURCES:
        path = ROOT / source["raw_file"]
        source.update({"sha256": digest(path), "bytes": path.stat().st_size,
                       "retrieved_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()})
    manifest = {
        "id": "sf-parks-census", "kind": "official_snapshot", "synthetic": False,
        "title": combined["name"], "crs": "EPSG:4326", "sources": SOURCES,
        "dataset_file": target.name, "sha256": digest(target), "bytes": target.stat().st_size,
        "counts": {"source_park_properties": len(parks_raw["features"]), "park_features": len(parks),
                   "population_features": len(tracts), "total_population_2020": sum(f["properties"]["population"] for f in tracts),
                   "missing_population_joins": 0, "excluded_park_properties": dict(excluded),
                   "repaired_park_geometries": repaired},
        "preparation": {"script": "data/real/prepare_snapshot.py", "shapely_version": shapely.__version__,
                        "park_selection": "city == San Francisco and propertytype in " + ", ".join(sorted(PARK_TYPES)),
                        "geometry_repair": "Shapely make_valid; retain polygon components only; no simplification",
                        "population_join": "Exact GEOID match between SF 2020 tracts and Census2020 POP100; all 244 matched"},
        "limitations": [
            "2020 population and a later parks inventory snapshot are different vintages; this is an exploratory illustration, not a current population estimate.",
            "Park coverage includes selected SF Recreation and Parks property types only. Federal, state, private, and other agency parks can be absent.",
            "Property boundaries do not identify entrances, hours, fees, accessibility, or public access restrictions; regional parks may include golf areas.",
            "Distances use one representative point per census tract and straight-line distance to park geometry, not routes or walking time. Population is assigned to that point as an approximation.",
            "Candidate coordinates describe hypothetical point sites; no site feasibility, ownership, or building suitability has been established.",
        ],
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"dataset": str(target), "sha256": manifest["sha256"], "counts": manifest["counts"]}))


if __name__ == "__main__":
    main()
