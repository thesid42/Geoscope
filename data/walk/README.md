# Offline pedestrian network snapshots

Files data/walk/sf.json and data/walk/nyc.json are compact pedestrian graph snapshots fetched from public Overpass API instances. They preserve shared OpenStreetMap node IDs and consecutive way segments so the runtime routes over mapped topology rather than straight-line links. Each adjacent-node edge length is recomputed in the selected projected CRS by the trusted walking kernel.

The snapshots cover the SF and East Harlem study extents with roughly 850 m rectangular buffers. Their exact bounds, Overpass data timestamp, preparation timestamp, filters, counts, raw-response digest, compact-file SHA-256, source endpoint, and license are in the corresponding *-manifest.json files. The runtime checks that the study area lies inside the network bounds and refuses a walking time whose maximum radius exceeds the staged buffer. It never downloads street data at run time.

Refresh both snapshots from a network-enabled trusted machine:

    python scripts/fetch_walk_networks.py --area all

Refresh one region with --area sf or --area nyc. The fetcher tries the listed public Overpass instances, fails if none responds, and refuses to truncate a graph above 40,000 nodes or 80,000 edge segments. It clips boundary-crossing segments so no stored edge references a node outside the declared snapshot bounds.

The filter excludes motorways, trunk roads, construction/proposed/abandoned roads, restricted/private/no-foot ways, and explicitly one-way-foot ways. The graph is undirected: general motor-vehicle one-way tags do not prohibit walking. Each snapshot identifies these choices and any exclusions in its manifest.

OpenStreetMap data is © OpenStreetMap contributors and available under the Open Database License (ODbL) 1.0. Attribution: https://www.openstreetmap.org/copyright. License: https://opendatacommons.org/licenses/odbl/1-0/. Overpass QL uses the documented out body; >; out skel qt; pattern to retain ways and shared member nodes: https://wiki.openstreetmap.org/wiki/OverpassQL.

These are approximate pedestrian proximity networks, not route instructions. OSM tags/connectivity do not prove a path is safe or currently open. The graph has no verified facility entrances, crosswalk delay, traffic signal timing, slope, closures, or step-free accessibility. Demand is represented by population feature representative points; facility and proposed parcel connections are straight-line snaps to nearby network nodes, bounded by the requested snap distance.
