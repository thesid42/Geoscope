from __future__ import annotations

import json
import math
from typing import Any


DEMO: dict[str, Any] = {
    "type": "FeatureCollection",
    "name": "Harborview demo (synthetic)",
    "features": [
        {"type":"Feature","id":"b-01","properties":{"layer":"population","population":1200,"name":"North End"},"geometry":{"type":"Point","coordinates":[-122.3375,47.6190]}},
        {"type":"Feature","id":"b-02","properties":{"layer":"population","population":850,"name":"Market Steps"},"geometry":{"type":"Point","coordinates":[-122.3300,47.6165]}},
        {"type":"Feature","id":"b-03","properties":{"layer":"population","population":1750,"name":"Central Blocks"},"geometry":{"type":"Point","coordinates":[-122.3230,47.6130]}},
        {"type":"Feature","id":"b-04","properties":{"layer":"population","population":950,"name":"East Ridge"},"geometry":{"type":"Point","coordinates":[-122.3155,47.6180]}},
        {"type":"Feature","id":"b-05","properties":{"layer":"population","population":1400,"name":"South Basin"},"geometry":{"type":"Point","coordinates":[-122.3190,47.6070]}},
        {"type":"Feature","id":"b-06","properties":{"layer":"population","population":700,"name":"West Shore"},"geometry":{"type":"Point","coordinates":[-122.3430,47.6105]}},
        {"type":"Feature","id":"p-01","properties":{"layer":"park","name":"Cedar Green"},"geometry":{"type":"Polygon","coordinates":[[[-122.3390,47.6195],[-122.3365,47.6195],[-122.3365,47.6175],[-122.3390,47.6175],[-122.3390,47.6195]]]}},
        {"type":"Feature","id":"p-02","properties":{"layer":"park","name":"Harbor Lawn"},"geometry":{"type":"Polygon","coordinates":[[[-122.3255,47.6105],[-122.3225,47.6105],[-122.3225,47.6085],[-122.3255,47.6085],[-122.3255,47.6105]]]}},
        {"type":"Feature","id":"z-01","properties":{"layer":"zone","name":"Example study zone","source":"fabricated"},"geometry":{"type":"Polygon","coordinates":[[[-122.3325,47.6175],[-122.3210,47.6175],[-122.3210,47.6120],[-122.3325,47.6120],[-122.3325,47.6175]]]}}
    ]
}


def validate_geojson(data: Any, max_features: int = 100_000) -> dict[str, Any]:
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise ValueError("Upload must be a GeoJSON FeatureCollection.")
    stack = [data]
    while stack:
        item = stack.pop()
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError("GeoJSON cannot contain NaN or infinite numbers.")
        if isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, (list, tuple)):
            stack.extend(item)
    if "crs" in data:
        crs = data["crs"]
        crs_properties = crs.get("properties") if isinstance(crs, dict) else None
        if not isinstance(crs_properties, dict):
            raise ValueError("GeoJSON CRS properties must be an object with a supported name.")
        name = str(crs_properties.get("name", ""))
        if not any(name.upper().endswith(suffix) for suffix in ("EPSG:4326", "EPSG::4326", "CRS84", "OGC:CRS84")):
            raise ValueError("GeoJSON CRS must be EPSG:4326 / CRS84; reproject the file before upload.")
    features = data.get("features")
    if not isinstance(features, list) or not features or len(features) > max_features:
        raise ValueError("FeatureCollection must contain between 1 and the configured maximum number of features.")
    coordinate_count = 0
    for i, feature in enumerate(features):
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError(f"Feature {i + 1} is not a GeoJSON Feature.")
        geom = feature.get("geometry")
        props = feature.get("properties")
        if not isinstance(geom, dict) or not isinstance(props, dict):
            raise ValueError(f"Feature {i + 1} needs geometry and properties.")
        if props.get("layer") not in {"population", "service", "park", "zone"}:
            raise ValueError(f"Feature {i + 1} must set properties.layer to population, service, park, or zone.")
        if geom.get("type") not in {"Point", "Polygon", "MultiPolygon"}:
            raise ValueError(f"Feature {i + 1} geometry must be Point, Polygon, or MultiPolygon.")
        coords = geom.get("coordinates")
        points = [coords] if geom["type"] == "Point" else _coordinate_leaves(coords)
        if not points:
            raise ValueError(f"Feature {i + 1} has empty coordinates.")
        for p in points:
            coordinate_count += 1
            if coordinate_count > 2_000_000:
                raise ValueError("Dataset exceeds the coordinate limit (2 million positions). Simplify geometries before upload.")
            if not isinstance(p, (list, tuple)) or len(p) < 2:
                raise ValueError(f"Feature {i + 1} has malformed coordinates.")
            if len(p) not in (2, 3) or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in p):
                raise ValueError(f"Feature {i + 1} coordinates must be numeric longitude, latitude, and optional elevation.")
            lon, lat = float(p[0]), float(p[1])
            if any(not math.isfinite(float(v)) for v in p) or not (-180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError(f"Feature {i + 1} coordinates must be finite EPSG:4326 longitude/latitude.")
        if props["layer"] == "population":
            pop = props.get("population")
            if isinstance(pop, bool) or not isinstance(pop, (int, float)) or not math.isfinite(pop) or pop < 0:
                raise ValueError(f"Population feature {i + 1} needs a non-negative numeric population property.")
        if geom["type"] == "Polygon":
            _validate_polygon(coords, i + 1)
        elif geom["type"] == "MultiPolygon":
            if not isinstance(coords, list) or not coords:
                raise ValueError(f"Feature {i + 1} MultiPolygon coordinates must not be empty.")
            for polygon in coords:
                _validate_polygon(polygon, i + 1)
        elif not isinstance(coords, (list, tuple)) or len(coords) not in (2, 3):
            raise ValueError(f"Feature {i + 1} Point coordinates must contain longitude, latitude, and optional elevation.")
        role = "service" if props["layer"] == "park" else props["layer"]
        if role == "zone" and geom["type"] not in {"Polygon", "MultiPolygon"}:
            raise ValueError(f"Zone feature {i + 1} must be Polygon or MultiPolygon.")
    if not any(f["properties"]["layer"] == "population" for f in features):
        raise ValueError("Dataset needs at least one population feature.")
    return data


def _coordinate_leaves(value: Any) -> list[Any]:
    out: list[Any] = []
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, (list, tuple)) and len(item) >= 2 and all(isinstance(x, (int, float)) for x in item[:2]):
            out.append(item)
        elif isinstance(item, (list, tuple)):
            stack.extend(reversed(item))
    return out


def _validate_polygon(rings: Any, index: int) -> None:
    if not isinstance(rings, list) or not rings:
        raise ValueError(f"Feature {index} polygon must contain a linear ring.")
    for ring in rings:
        if not isinstance(ring, list) or len(ring) < 4 or any(not isinstance(p, (list, tuple)) or len(p) not in (2, 3) for p in ring):
            raise ValueError(f"Feature {index} polygon rings must contain at least four positions.")
        for position in ring:
            if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in position):
                raise ValueError(f"Feature {index} polygon coordinates must be numeric longitude, latitude, and optional elevation.")
            if any(not math.isfinite(float(value)) for value in position):
                raise ValueError(f"Feature {index} polygon coordinates must be finite EPSG:4326 values.")
            lon, lat = float(position[0]), float(position[1])
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                raise ValueError(f"Feature {index} polygon coordinates must be finite EPSG:4326 longitude/latitude.")
        if ring[0][:2] != ring[-1][:2]:
            raise ValueError(f"Feature {index} polygon rings must be closed.")


def inspect_schema(data: dict[str, Any]) -> dict[str, Any]:
    features = data["features"]
    populations = [f for f in features if f["properties"]["layer"] == "population"]
    parks = [f for f in features if f["properties"]["layer"] in {"park", "service"}]
    zones = [f for f in features if f["properties"]["layer"] == "zone"]
    field_types: dict[str, set[str]] = {}
    for feature in populations:
        for key, value in feature["properties"].items():
            field_types.setdefault(key, set()).add(type(value).__name__)
    return {
        "crs": "EPSG:4326",
        "population_features": len(populations),
        "service_features": len(parks),
        "zone_features": len(zones),
        "population_fields": {key: sorted(kinds) for key, kinds in field_types.items()},
        "geometry_types": sorted({f["geometry"]["type"] for f in features}),
        "representative_points": "population layer accepts Polygon/MultiPolygon and Point; analysis uses each geometry's representative point",
        "geometry_validation": "Topology validity is checked inside the isolated analysis worker before model-generated code runs.",
    }
