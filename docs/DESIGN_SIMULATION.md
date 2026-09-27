# Agent design and walking comparison

The facility workflow now accepts design goals instead of requiring a hand-sized building. Select a facility and area, then choose **Design & compare**. The agent chooses a bounded design strategy and searches placement, rectangle proportions, rotation and floors. Results combine a checked building mass, connected reserved open space, and walking access before/after the proposal. Fixed-footprint checks remain available.

## Inputs and decisions

Default goals: 900 square metres of gross floor area, at most 3 floors, at least 40% of the gross parcel reserved as one usable open-space component, and a 3 m setback. The model may choose `balanced`, `open_space`, or `low_rise` based on the analyst question. These are search preferences; they cannot override the structured goals. Floor height is explicitly assumed to be 3.5 m.

The bounded search tries floor counts, three rectangular aspect ratios, parcel-aligned and fixed rotations, and at most 20 anchors per plot. It measures a limited shortlist per floor count, submits up to 12 distinct plot designs, and displays up to three verified alternatives. Balanced search trades six percentage points of open space per additional floor; open-space preference prioritizes the reserve; low-rise preference prioritizes fewer floors that still meet the goals. This is the best of evaluated alternatives, not proof of a global optimum. No submitted design is a valid outcome, not proof that all possible buildings are infeasible.

Candidate ordering remains based on mapped-service gap, followed by connected usable-open-space percentage and plot ID. Walking results are separate outcomes; coarse Census weights do not drive an implied precise demand ranking.

## What is checked

Every proposed footprint plus setback must fit within the source parcel and selected area and avoid supplied buildings, road corridors and restrictions. Its footprint area multiplied by integer floors must meet the requested floor-area goal. The source record must declare the requested use and land status.

Usable open space excludes the proposal and supplied obstructions. It must occupy the same connected unobstructed land component as the building. A negative 2 m buffer followed by a positive 2 m buffer removes narrow fragments; the largest connected remaining polygon is intersected back with the original open geometry. This is a **4 m geometric-width proxy**. The percentage denominator remains the **whole source parcel**, even where the selected study area clips that parcel. The viewer highlights the measured reserve.

The reserve is proposed open land, not measured landscaping, planting, permeability, carbon savings or energy performance. Neither MapPLUTO vacancy nor supplied use declarations establish ownership, zoning permission or construction approval.

## Walking comparison

A downloaded pedestrian network is staged with the original input. Offline calculations preserve source-node connectivity and compare the same projected population representative points before and after each proposed facility. The default walking budget is 10 minutes at an assumed 1.2 m/s. Route examples and before/after point colours are displayed with the results.

The source inventory, network date, bounded connectors, missing matches, coarse population weights and other assumptions travel with each result. Missing networks, missing baseline services and disconnected origins must remain unknown; there is no straight-line fallback labelled as walking. Follow [walking data provenance](../data/walk/README.md) for filters and snapshot refresh commands.

Population polygons contribute their whole Census weight through one representative point. These are approximate access estimates, not household-level resident counts or predicted clinic demand. Nearby service data outside the supplied inventory may be missing. Network connectors are inferred links, not surveyed entrances; real walkability, crossings, slopes and opening hours remain unverified.

## Execution and containment

1. The controller binds the design goals, study area, dataset and downloaded network. Upload metadata cannot supply authoritative proposals or change these values.
2. Trusted inspection validates geometry in an isolated worker before the model runs.
3. Vultr inference produces a plan and Python experiment script. The script can use the read-only toolkit staged under `/input`, searches designs and computes outcomes inside a disposable gVisor container.
4. The worker accepts only bounded numeric placement parameters, a known plot ID, integer floors and an allowed strategy. It runs a **fresh trusted container** to reconstruct those exact proposals from the original input and recompute all measurements. Invalid layouts and altered metrics are rejected.
5. Canonical verified metrics and geometry are returned to the UI. Input hash, submitted proposals, strategy, toolkit version/hash, script attempts and output artifacts support review.

The original fixed-footprint scenario keeps its original exact-reference verification. No network, secrets, Docker socket or writable toolkit enters generated-code containers. The local mock uses the fixed toolkit explicitly without claiming that an LLM or gVisor ran.

## API example

```json
{
  "dataset_id": "nycland",
  "analysis_mode": "scenario",
  "question": "Design a compact library and preserve useful open space.",
  "service_type": "library",
  "study_area": [-73.955, 40.790, -73.930, 40.812],
  "threshold_m": 400,
  "design": {
    "target_floor_area_m2": 900,
    "max_floors": 3,
    "min_open_space_pct": 40,
    "setback_m": 3
  },
  "walk": {"minutes": 10, "speed_mps": 1.2, "max_snap_m": 100}
}
```

Omit `design` or set it to `null` for the legacy fixed-footprint contract. Bundled walking snapshots attach only to their matching scenario dataset. Uploads without a staged network retain design results and explicitly report walking comparison unavailable.

## Updating a deployment

Both controller and worker must be updated together. The controller image includes `data/walk`. Worker installation must include `simulation_program.py`, `simulation_runtime.py`, and `walking.py` as well as updated `sandbox.py` and `reference.py`; rebuilding only the controller is insufficient. Existing Shapely/PyProj sandbox dependencies are sufficient—no online routing service or new sandbox network permissions are needed.
