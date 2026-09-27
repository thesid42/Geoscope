# Official New York City sample

`nyc-facilities-census.geojson` is a five-borough official snapshot: 2,325
Census 2020 tracts with TIGERweb POP100, 1,868 selected NYC Parks properties,
and 3,734 Facilities Database points tagged as clinic, library, school, or
community center. Population, park polygons, and facility points are observed
records. No synthetic population or invented facility locations are added.
`manifest.json` records source URLs, retrieval times, SHA-256 hashes, filters,
geometry repairs, and limitations.

The 2020 citywide population sum is 8,804,190. Two TIGERweb water tracts
(`36047990100`, `36081990100`) have no matching NYC tract polygon and are
omitted. Park and tract polygons are topology-preserved and simplified at
0.00012 degrees (~13 m) so the combined file stays practical to load.

Compared with the San Francisco parks-and-census sample, this file adds typed
service points (hospitals/clinics, public libraries, public and charter K-12
schools, and community centers), borough and neighborhood names, park type and
acreage, and operator/oversight fields.

Rebuild from the adjacent raw downloads with Shapely:

```
python data/real-nyc/prepare_snapshot.py
```

Refresh the official raw files, then rebuild:

```
python data/real-nyc/prepare_snapshot.py --fetch
```

This inventory is an exploratory access proxy. Parks, FacDB, and 2020
population have different vintages. Distances use one representative point per
tract and straight-line distance, not walking time. Facility points are not
building footprints, hours, or a certified complete directory.
