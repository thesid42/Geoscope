# San Francisco land-fit demo fixture

`sf-mock.geojson` deliberately combines sources with different evidentiary status:

- Twelve 2020 Census population tract features are copied unchanged from the bundled official SF population snapshot at `../real/sf-parks-census.geojson` (40,776 summed population across the selected tracts).
- Seventy-five clinic, library, school, and community-center records come from a bounded OpenStreetMap Overpass extract. This is community-mapped data, not an official or complete facility directory. The exact OSM base timestamp is `2026-05-06T03:25:00Z`.
- Seven candidate plots are simulated rectangles. They are not assessor parcels, verified vacant land, or availability records. `land_status: available` is fixture logic only and is not a claim of ownership, vacancy, permission, or constructibility. Eligible fit plots sit on lot-like pockets beside mapped buildings (not Dolores Park lawn or the Church & 20th intersection). Under gap→area→id ranking, `sfmock-fit-01` wins clinic, school, and community center; `sfmock-fit-02` wins library. Clinic/community-center/library preferred gaps clear 400 m; school’s best lot-like site is ~384 m.
- A bounded OpenStreetMap snapshot supplies 690 mapped building footprints and 463 highway/footway centerlines buffered into polygonal road corridors within 120 m of the seven plots. Its OSM base timestamp is `2026-05-31T22:37:44Z` after merging supplemental ways around the relocated southwest plot into the prior extract. The four eligible fixture rectangles avoid those mapped polygons and Dolores Park open space; one test plot intersects a mapped building, one intersects a mapped road corridor, and one is deliberately too small.

The facility OSM query covered `[-122.44, 37.753, -122.409, 37.781]` (west, south, east, north). The land-context query is the union of 120 m searches around each simulated plot. The seven plots lie in the smaller Mission-area fixture region `[-122.433, 37.758, -122.417, 37.776]`. Full Census tract polygons are retained, so the resulting GeoJSON bbox also encloses tract and facility geometry outside the smaller plot region.

The facility snapshot has 75 distinct OSM elements after excluding one explicitly disused clinic: 21 clinic, 4 library, 34 school, and 16 community-center records in the query bbox. In the demo study area, `existing_service_counts` counts mapped records by supported service type when the projected representative point falls within the area. The clinic demo therefore reports 12, library 1, school 13, and community center 7. These are counts of supplied OSM records, not all real facilities or architectural building counts. Completeness for every type is `mapped_extract_not_complete`; a zero count would not prove absence. Way and relation geometries use the center returned by Overpass, not exact entrances.

Facility-site ranking uses greatest straight-line distance to the nearest matching mapped service, then plot area, then site ID. With the default study rectangle and 400 m threshold, preferred sites are `sfmock-fit-01` for clinic (~415 m), school (~384 m), and community center (~520 m), and `sfmock-fit-02` for library (~778 m). Park is not a scenario service type.

The raw Overpass response is 34,310 bytes (33.5 KiB); the normalized service GeoJSON is 41,358 bytes (40.4 KiB). See `sf-osm-services-manifest.json` for hashes, exact query, endpoint, timestamp, counts, and filtering details. The data is available under the Open Database License (ODbL) 1.0. Attribution: Copyright OpenStreetMap contributors, [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright). The extract may be stale or incomplete; verify a location before making real-world decisions.

The raw land-context response is 676,552 bytes and the normalized polygonal context is 993,935 bytes. `sf-osm-land-context-manifest.json` records the query, hashes, road-width defaults, and limitations. Road buffers are screening proxies, not surveyed curb or right-of-way boundaries. OSM can omit or simplify buildings and transport features, so avoiding this snapshot is not proof that a real site is clear. The combined `sf-mock.geojson` is 1,054,640 bytes with 1,247 features.

Rebuild the normalized service snapshot from the bundled raw response without network access, then rebuild the hybrid scenario:

```powershell
python scripts/fetch_sf_osm_services.py --prepare-only
.\.venv\Scripts\python.exe scripts/fetch_sf_osm_land_context.py --prepare-only
.\.venv\Scripts\python.exe scripts/generate_sf_mock_scenario.py
```

To refresh from public Overpass endpoints, run `python scripts/fetch_sf_osm_services.py` and `.\.venv\Scripts\python.exe scripts/fetch_sf_osm_land_context.py`, then regenerate the scenario. Review site intersections, feature counts, timestamps, hashes, and expected metrics before committing refreshed data. The generator copies bundled observed population, mapped services, and mapped building/road context, and generates only the explicitly marked candidate plots.
