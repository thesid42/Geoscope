"""Fixed mock-site definitions shared by SF land-context and scenario builders."""

STUDY_BOUNDS_WEST_SOUTH_EAST_NORTH = [-122.433, 37.758, -122.417, 37.776]

# Candidate parcels remain explicitly simulated. The four eligible rectangles were
# selected only after checking the bundled OSM building and transport snapshot, so
# their map/3D footprints do not visibly sit on mapped buildings or roads. This is
# not evidence of ownership, vacancy, zoning approval, or construction suitability.
#
# fit-01 is placed where clinic, library, school, and community-center mapped-service
# gaps are all above the default 400 m threshold, so each facility type has a clear
# gap→area→id ranking demo without restoring population-coverage ranking.
SITES = [
    {
        "id": "sfmock-fit-01", "name": "Mock candidate A · Dolores Southwest",
        "center": [-122.428084, 37.758202], "size_m": [40, 34], "expected_fit": "fit",
    },
    {
        "id": "sfmock-fit-02", "name": "Mock candidate B · Dolores South",
        "center": [-122.426750, 37.760505], "size_m": [40, 34], "expected_fit": "fit",
    },
    {
        "id": "sfmock-fit-03", "name": "Mock candidate C · Mission North",
        "center": [-122.421864, 37.768916], "size_m": [40, 34], "expected_fit": "fit",
    },
    {
        "id": "sfmock-fit-04", "name": "Mock candidate D · Mission South",
        "center": [-122.422432, 37.758968], "size_m": [40, 34], "expected_fit": "fit",
    },
    {
        "id": "sfmock-building-blocked", "name": "Mock candidate E · mapped-building conflict",
        "center": [-122.425200, 37.768700], "size_m": [40, 34], "expected_fit": "blocked_by_mapped_building",
    },
    {
        "id": "sfmock-restricted", "name": "Mock candidate F · mapped-road conflict",
        "center": [-122.419200, 37.765000], "size_m": [40, 34], "expected_fit": "blocked_by_mapped_road",
    },
    {
        "id": "sfmock-too-small", "name": "Mock candidate G · undersized lot",
        "center": [-122.432017, 37.769608], "size_m": [29, 23], "expected_fit": "too_small",
    },
]
