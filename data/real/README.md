# Official San Francisco sample

`sf-parks-census.geojson` contains 244 Census tracts with 2020 population and
226 selected San Francisco Recreation and Parks properties. It contains no
synthetic population or invented park geometry. `manifest.json` records source
URLs, retrieval times, SHA-256 hashes, filters, geometry repairs, and limitations.

The input snapshots are retained under `raw/`. Run `prepare_snapshot.py` with
Shapely 2.0.7 to reproduce the normalized combined file from those snapshots.
Population joins use the Census GEOID; every one of the 244 tract rows matched.
The resulting 2020 population sum is 873,965. Geometry validation found seven
selected park shapes requiring `make_valid`; all repairs are named in the
manifest. The combined output passes the app's upload structure validation.

The parks inventory and 2020 population have different dates. This inventory
does not cover all agencies or identify entrances, opening hours, fees, or
access restrictions. Analysis uses a tract representative point and straight-line
distance to park geometry, so it is an exploratory access proxy, not walking
time or a detailed estimate of households served. Candidate sites are hypothetical
points, not assessed development proposals.

Data preparation was verified in a restricted Docker container using trusted
code. That verification is separate from the application's gVisor execution
boundary and is not evidence that live gVisor containment tests passed.
