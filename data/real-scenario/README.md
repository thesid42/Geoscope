# San Francisco mock land-fit scenario

`sf-mock.geojson` is a deliberately mixed-provenance demo fixture. Its 12 population features are copied unchanged from the bundled official 2020 Census-derived San Francisco snapshot at `../real/sf-parks-census.geojson`. The candidate sites, building obstruction, restricted area, and clinic/library points are simulated geometry placed at San Francisco coordinates. They are not assessor parcels, observed buildings, verified vacant land, or real service locations. The fixture does not establish ownership, current availability, zoning, permitting, environmental suitability, or legal buildability.

The simulated scenario contains seven candidate rectangles and both mock service points lie in the Mission-area fixture region `[-122.433, 37.758, -122.417, 37.776]` (west, south, east, north). Census tract polygons are kept whole, so some extend beyond that fixture region; the GeoJSON `bbox` covers their full extent. The candidates are: four unobstructed nominal fit examples, one blocked by a simulated footprint, one overlapped by a simulated restriction, and one too small for the example 24 m by 18 m building with 3 m setbacks. Simulated clinics and libraries are illustrative points. `land_status: available` is fixture input only, never an availability claim.

The top-level `scenario_status` and `land_inventory` metadata explicitly mark coverage as simulated and complete only relative to these fixture candidate sites. `as_of` is the fixed fixture date 2026-09-26. The source manifest records the observed population snapshot provenance and its hash separately from the generated scenario hash.

Regenerate from the bundled source snapshot with:

```powershell
python scripts/generate_sf_mock_scenario.py
```

The script intentionally requires the source GeoJSON and manifest to be present and fails if any selected population GEOID is missing. It writes `sf-mock.geojson` and `manifest.json` in this directory.
