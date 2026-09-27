# San Francisco land-fit demo fixture

`sf-mock.geojson` deliberately combines sources with different evidentiary status:

- Twelve 2020 Census population tract features are copied unchanged from the bundled official SF population snapshot at `../real/sf-parks-census.geojson` (40,776 summed population across the selected tracts).
- Seventy-five clinic, library, school, and community-center records come from a bounded OpenStreetMap Overpass extract. This is community-mapped data, not an official or complete facility directory. The exact OSM base timestamp is `2026-05-06T03:25:00Z`.
- Seven candidate plots, one obstructing building footprint, and one restricted area are simulated rectangles. They are not assessor parcels, observed buildings, verified vacant land, or real legal/environmental restrictions. `land_status: available` is fixture logic only and is not a claim of actual availability.

The OSM query covered `[-122.44, 37.753, -122.409, 37.781]` (west, south, east, north). The seven synthetic plots lie in the smaller Mission-area fixture region `[-122.433, 37.758, -122.417, 37.776]`. The full Census tract polygons are retained, so the resulting GeoJSON bbox encloses all features, including tract polygons and facilities outside the smaller plot region.

The facility snapshot has 75 distinct OSM elements after excluding one explicitly disused clinic: 21 clinic, 4 library, 34 school, and 16 community-center records in the query bbox. In the demo study area, `existing_service_counts` counts mapped records by supported service type when the projected representative point falls within the area. The clinic demo therefore reports 12, library 1, school 13, and community center 7. These are counts of supplied OSM records, not all real facilities or architectural building counts. Completeness for every type is `mapped_extract_not_complete`; a zero count would not prove absence. Way and relation geometries use the center returned by Overpass, not exact entrances.

The raw Overpass response is 34,310 bytes (33.5 KiB); the normalized service GeoJSON is 41,358 bytes (40.4 KiB). See `sf-osm-services-manifest.json` for hashes, exact query, endpoint, timestamp, counts, and filtering details. The data is available under the Open Database License (ODbL) 1.0. Attribution: Copyright OpenStreetMap contributors, [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright). The extract may be stale or incomplete; verify a location before making real-world decisions.

Rebuild the normalized service snapshot from the bundled raw response without network access, then rebuild the hybrid scenario:

```powershell
python scripts/fetch_sf_osm_services.py --prepare-only
python scripts/generate_sf_mock_scenario.py
```

To refresh from public Overpass endpoints, run `python scripts/fetch_sf_osm_services.py`; this replaces the raw response and its metadata with a newly timestamped extract. The scenario generator copies the bundled real population and OSM service features, and generates only the explicitly marked mock land/building/restriction geometry.
