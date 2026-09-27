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

## Default facility demos

Study area `[-73.955, 40.790, -73.930, 40.812]`, building 24 × 18 × 12 m, setback 3 m, threshold 400 m. Ranking is service gap → plot area → site ID (not population).

| Facility type | Expectation |
| --- | --- |
| Clinic | ≥1 eligible lot; preferred lot often has a large mapped-clinic gap (~750 m+) |
| Library | ≥1 eligible lot; libraries are sparse, so gaps are typically large |
| School | ≥1 eligible lot; FacDB schools are dense, so nearest distances are shorter |
| Community center | ≥1 eligible lot; gaps are moderate |

Park is not a scenario service type here; parks in this extract remain available for access/compare workflows via the citywide NYC snapshot.
