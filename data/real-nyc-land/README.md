# East Harlem official land extract

`nyc-east-harlem-land.geojson` is a neighborhood extract for facility-site
checks. It is not a mock and does not invent parcels.

- Candidate plots are official [MapPLUTO](https://www.nyc.gov/site/planning/data-maps/open-data/dwn-pluto-mappluto.page) tax lots classified as vacant land (LandUse 11).
- Buildings are official NYC DoITT building footprints near those lots.
- Streets are official CSCL centerlines buffered by tagged street width.
- Population, parks, and clinic/library/school/community-center points come from the bundled citywide NYC snapshot.

`land_status=available` means MapPLUTO classified the lot as vacant land. It
does not mean the lot is for sale, approved, or constructible.

Rebuild after downloading raw extracts:

```
python data/real-nyc-land/prepare_snapshot.py --fetch
```

Or rebuild from `raw/` without network:

```
python data/real-nyc-land/prepare_snapshot.py
```
