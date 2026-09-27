"""Build the bundled NYC official snapshot from adjacent raw downloads.

Trusted preparation utility, never an agent-generated program. Requires Shapely.
Run: python data/real-nyc/prepare_snapshot.py
Refresh raw files first: python data/real-nyc/prepare_snapshot.py --fetch
"""
from __future__ import annotations

import argparse
import hashlib
import json
import ssl
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import shapely
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.validation import make_valid


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
SIMPLIFY_DEG = 0.00012
USER_AGENT = "Geoscope-data-prep/1.0 (+https://github.com/)"
NYC_COUNTIES = {
    "005": "Bronx",
    "047": "Brooklyn",
    "061": "Manhattan",
    "081": "Queens",
    "085": "Staten Island",
}
PARK_TYPES = {
    "Neighborhood Park",
    "Community Park",
    "Playground",
    "Jointly Operated Playground",
    "Nature Area",
    "Recreational Field/Courts",
    "Flagship Park",
    "Triangle/Plaza",
    "Waterfront Facility",
    "Historic House Park",
    "Garden",
    "Parkway",
}
SERVICE_QUERIES = {
    "clinics.json": ("clinic", "facgroup='HEALTH CARE' AND facsubgrp='HOSPITALS AND CLINICS'"),
    "libraries.json": ("library", "facgroup='LIBRARIES' AND facsubgrp='PUBLIC LIBRARIES'"),
    "schools.json": ("school", "facgroup='SCHOOLS (K-12)' AND facsubgrp in ('PUBLIC K-12 SCHOOLS','CHARTER K-12 SCHOOLS')"),
    "community_centers.json": ("community_center", "facgroup='HUMAN SERVICES' AND facsubgrp='COMMUNITY CENTERS AND COMMUNITY PROGRAMS'"),
}
BOROUGH_NAMES = {"M": "Manhattan", "K": "Brooklyn", "Q": "Queens", "X": "Bronx", "R": "Staten Island"}
SOURCES = [
    {
        "id": "nyc_census_tracts_2020",
        "raw_file": "raw/tracts.geojson",
        "title": "NYC 2020 Census Tracts",
        "url": "https://data.cityofnewyork.us/resource/63ge-mke6.geojson?$limit=5000",
        "metadata_url": "https://data.cityofnewyork.us/City-Government/2020-Census-Tracts/63ge-mke6",
        "license": "NYC Open Data Terms of Use; U.S. Census Bureau geography",
        "vintage": "2020 Census tract polygons with NTA and community-district names",
    },
    {
        "id": "census2020_population_nyc",
        "raw_file": "raw/population.json",
        "title": "U.S. Census Bureau TIGERweb Census2020 Census Tracts POP100 for NYC counties",
        "url": "https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/tigerWMS_Census2020/MapServer/6/query?where=STATE%3D%2736%27%20AND%20COUNTY%20IN%20(%27005%27%2C%27047%27%2C%27061%27%2C%27081%27%2C%27085%27)&outFields=GEOID,NAME,POP100&returnGeometry=false&f=json",
        "metadata_url": "https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/tigerWMS_Census2020/MapServer/6",
        "license": "U.S. Census Bureau public data; source attribution retained",
        "vintage": "2020 Census POP100 total population; January 1, 2020 tract boundaries",
    },
    {
        "id": "nyc_parks_properties",
        "raw_file": "raw/parks.geojson",
        "title": "NYC Parks Properties",
        "url": "https://data.cityofnewyork.us/resource/enfh-gkve.geojson?$limit=5000",
        "metadata_url": "https://data.cityofnewyork.us/Recreation/Parks-Properties/enfh-gkve/about_data",
        "license": "NYC Open Data Terms of Use",
        "vintage": "Live NYC Parks property inventory snapshot; type, acres, borough, and waterfront retained",
    },
    {
        "id": "nyc_facilities_database",
        "raw_file": "raw/facilities.json",
        "title": "NYC City Planning Facilities Database (selected service types)",
        "url": "https://data.cityofnewyork.us/resource/ji82-xba5.json?$limit=20000",
        "metadata_url": "https://data.cityofnewyork.us/City-Government/Facilities-Database/ji82-xba5",
        "license": "NYC Open Data Terms of Use; New York City Department of City Planning",
        "vintage": "Selected FacDB records: hospitals/clinics, public libraries, public and charter K-12 schools, community centers",
    },
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=180, context=context) as response:
        return response.read()


def write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def fetch_raw() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    write_bytes(RAW / "tracts.geojson", fetch(SOURCES[0]["url"]))
    write_bytes(RAW / "parks.geojson", fetch(SOURCES[2]["url"]))
    population_features = []
    for county, name in NYC_COUNTIES.items():
        where = urllib.parse.quote(f"STATE='36' AND COUNTY='{county}'")
        url = (
            "https://tigerweb.geo.census.gov/arcgis/rest/services/Census2020/"
            f"tigerWMS_Census2020/MapServer/6/query?where={where}"
            "&outFields=GEOID,NAME,POP100&returnGeometry=false&f=json"
        )
        payload = json.loads(fetch(url))
        if payload.get("exceededTransferLimit"):
            raise RuntimeError(f"TIGERweb response for {name} was truncated")
        population_features.extend(payload.get("features") or [])
    write_bytes(RAW / "population.json", json.dumps({"features": population_features}, separators=(",", ":")).encode())
    selected = []
    for filename, (_service_type, where) in SERVICE_QUERIES.items():
        url = "https://data.cityofnewyork.us/resource/ji82-xba5.json?" + urllib.parse.urlencode(
            {"$where": where, "$limit": "10000"}
        )
        rows = json.loads(fetch(url))
        if not isinstance(rows, list):
            raise RuntimeError(f"Unexpected FacDB response for {filename}: {rows}")
        write_bytes(RAW / filename, json.dumps(rows, separators=(",", ":")).encode())
        selected.extend(rows)
    write_bytes(RAW / "facilities.json", json.dumps(selected, separators=(",", ":")).encode())


def read_json(name: str):
    return json.loads((RAW / name).read_text(encoding="utf-8"))


def polygon_parts(geom):
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in {"MultiPolygon", "GeometryCollection"}:
        return [part for child in geom.geoms for part in polygon_parts(child)]
    return []


def cleaned_polygon(geom, feature_id: str):
    if geom is None or geom.is_empty:
        return None, False
    repaired = False
    if not geom.is_valid:
        parts = polygon_parts(make_valid(geom))
        if not parts:
            return None, False
        geom = parts[0] if len(parts) == 1 else MultiPolygon(parts)
        if not geom.is_valid:
            raise AssertionError(f"Repair invalid for {feature_id}")
        repaired = True
    if SIMPLIFY_DEG:
        simplified = geom.simplify(SIMPLIFY_DEG, preserve_topology=True)
        if not simplified.is_empty:
            geom = simplified if simplified.is_valid else make_valid(simplified)
    parts = polygon_parts(geom)
    if not parts:
        return None, repaired
    geom = parts[0] if len(parts) == 1 else MultiPolygon(parts)
    return geom, repaired


def finite_point(lon, lat):
    try:
        longitude = float(lon)
        latitude = float(lat)
    except (TypeError, ValueError):
        return None
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        return None
    return [longitude, latitude]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", action="store_true", help="Download official raw snapshots before building.")
    args = parser.parse_args()
    if args.fetch:
        fetch_raw()

    tracts_raw = read_json("tracts.geojson")
    parks_raw = read_json("parks.geojson")
    population_raw = read_json("population.json")
    facilities_raw = read_json("facilities.json")

    population = {}
    for row in population_raw["features"]:
        attrs = row["attributes"] if "attributes" in row else row.get("properties", row)
        geoid = str(attrs["GEOID"])
        value = attrs["POP100"]
        if geoid in population:
            raise AssertionError(f"Duplicate Census GEOID {geoid}")
        population[geoid] = value

    tracts, repaired_tracts = [], []
    for feature in tracts_raw["features"]:
        props = feature["properties"]
        geoid = str(props["geoid"])
        geom, repaired = cleaned_polygon(shape(feature["geometry"]), geoid)
        if geom is None:
            continue
        if geoid not in population:
            continue
        if repaired:
            repaired_tracts.append(geoid)
        value = population[geoid]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or not float(value).is_integer():
            raise AssertionError(f"Invalid population for {geoid}")
        tracts.append({
            "type": "Feature",
            "id": "tract-" + geoid,
            "properties": {
                "layer": "population",
                "id": geoid,
                "geoid": geoid,
                "name": f"{props.get('boroname')} {props.get('ntaname')} · Tract {props.get('ctlabel')}",
                "borough": props.get("boroname"),
                "neighborhood": props.get("ntaname"),
                "community_district": props.get("cdtaname"),
                "population": int(value),
                "population_year": 2020,
                "source": "nyc_census_tracts_2020 + census2020_population_nyc",
            },
            "geometry": mapping(geom),
        })
    missing = set(population) - {f["properties"]["geoid"] for f in tracts}
    extra = {f["properties"]["geoid"] for f in tracts} - set(population)
    if extra:
        raise AssertionError(f"Tract GEOIDs missing Census population: {sorted(extra)[:8]}")

    excluded_parks, repaired_parks, parks = Counter(), [], []
    for feature in parks_raw["features"]:
        props = feature["properties"]
        park_id = str(props.get("omppropid") or props.get("gispropnum") or props.get("objectid"))
        kind = props.get("typecategory")
        if props.get("retired") is True:
            excluded_parks["retired"] += 1
            continue
        if kind not in PARK_TYPES:
            excluded_parks["property type: " + str(kind)] += 1
            continue
        geom, repaired = cleaned_polygon(shape(feature["geometry"]) if feature.get("geometry") else None, park_id)
        if geom is None:
            excluded_parks["empty or unrepairable geometry"] += 1
            continue
        if repaired:
            repaired_parks.append({"id": park_id, "name": props.get("signname") or props.get("name311")})
        acres = props.get("acres")
        try:
            acres_value = float(acres) if acres not in (None, "") else None
        except (TypeError, ValueError):
            acres_value = None
        parks.append({
            "type": "Feature",
            "id": "park-" + park_id,
            "properties": {
                "layer": "park",
                "id": park_id,
                "name": props.get("signname") or props.get("name311") or park_id,
                "property_type": kind,
                "borough": BOROUGH_NAMES.get(str(props.get("borough") or ""), props.get("borough")),
                "acres": acres_value,
                "waterfront": bool(props.get("waterfront")),
                "address": props.get("address") or props.get("location"),
                "zipcode": props.get("zipcode"),
                "source": "nyc_parks_properties",
            },
            "geometry": mapping(geom),
        })

    services, skipped_services = [], Counter()
    seen_uids = set()
    service_lookup = {}
    for filename, (service_type, _where) in SERVICE_QUERIES.items():
        for row in read_json(filename):
            service_lookup[row.get("uid")] = service_type
    for row in facilities_raw:
        uid = row.get("uid")
        if not uid or uid in seen_uids:
            skipped_services["duplicate or missing uid"] += 1
            continue
        seen_uids.add(uid)
        service_type = service_lookup.get(uid)
        if service_type is None:
            skipped_services["unmapped service type"] += 1
            continue
        point = finite_point(row.get("longitude"), row.get("latitude"))
        if point is None:
            skipped_services["missing coordinates"] += 1
            continue
        services.append({
            "type": "Feature",
            "id": f"{service_type}-{uid[:12]}",
            "properties": {
                "layer": "service",
                "id": uid,
                "name": row.get("facname") or uid,
                "service_type": service_type,
                "facility_group": row.get("facgroup"),
                "facility_subgroup": row.get("facsubgrp"),
                "facility_type": row.get("factype"),
                "borough": (row.get("boro") or "").title() or None,
                "address": row.get("address"),
                "zipcode": row.get("zipcode"),
                "operator": row.get("opname"),
                "oversight_agency": row.get("overagency"),
                "neighborhood": row.get("nta2020"),
                "source": "nyc_facilities_database",
            },
            "geometry": {"type": "Point", "coordinates": point},
        })

    combined = {
        "type": "FeatureCollection",
        "name": "New York City parks, facilities, and 2020 Census population (official snapshot)",
        "features": tracts + parks + services,
    }
    target = ROOT / "nyc-facilities-census.geojson"
    target.write_text(json.dumps(combined, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")

    for source in SOURCES:
        path = ROOT / source["raw_file"]
        source.update({
            "sha256": digest(path),
            "bytes": path.stat().st_size,
            "retrieved_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
        })
    service_counts = Counter(f["properties"]["service_type"] for f in services)
    park_type_counts = Counter(f["properties"]["property_type"] for f in parks)
    manifest = {
        "id": "nyc-facilities-census",
        "kind": "official_snapshot",
        "synthetic": False,
        "title": combined["name"],
        "crs": "EPSG:4326",
        "sources": SOURCES,
        "dataset_file": target.name,
        "sha256": digest(target),
        "bytes": target.stat().st_size,
        "counts": {
            "population_features": len(tracts),
            "total_population_2020": sum(f["properties"]["population"] for f in tracts),
            "missing_population_joins": len(missing),
            "tiger_only_water_or_unmatched_geoids": sorted(missing),
            "source_park_properties": len(parks_raw["features"]),
            "park_features": len(parks),
            "park_types": dict(park_type_counts),
            "excluded_park_properties": dict(excluded_parks),
            "repaired_park_geometries": repaired_parks[:40],
            "repaired_tract_geometries": len(repaired_tracts),
            "source_facility_records": len(facilities_raw),
            "service_features": len(services),
            "service_counts": dict(service_counts),
            "skipped_services": dict(skipped_services),
        },
        "preparation": {
            "script": "data/real-nyc/prepare_snapshot.py",
            "shapely_version": shapely.__version__,
            "geometry_repair": "Shapely make_valid; retain polygon components; simplify 0.00012 degrees (~13 m) with topology preserved",
            "park_selection": "retired is not true and typecategory in " + ", ".join(sorted(PARK_TYPES)),
            "population_join": "Exact GEOID match between NYC 2020 tracts and Census2020 POP100 for counties 005, 047, 061, 081, 085",
            "service_selection": "FacDB hospitals/clinics, public libraries, public and charter K-12 schools, and community centers with usable latitude/longitude",
        },
        "limitations": [
            "2020 population, a later Parks inventory, and a later Facilities Database extract are different vintages; this is an exploratory illustration, not a current service-gap finding.",
            "Park coverage includes selected NYC Parks property types only. State, federal, private, and other-agency open space can be absent.",
            "FacDB records are administrative facility points, not building footprints, hours, capacity, or a certified complete directory. Duplicate programs at one address can remain.",
            "Property boundaries and points do not identify entrances, accessibility, fees, or public access restrictions.",
            "Distances use one representative point per census tract and straight-line distance to park polygons or facility points, not walking routes or travel time.",
            "Candidate coordinates describe hypothetical point sites; no site feasibility, ownership, or building suitability has been established.",
        ],
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"dataset": str(target), "sha256": manifest["sha256"], "bytes": manifest["bytes"], "counts": manifest["counts"]}, indent=2))


if __name__ == "__main__":
    main()
