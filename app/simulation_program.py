"""Bounded design toolkit. GIS execution happens only inside the worker sandbox.

The model may select a strategy and submit different layouts. The verifier
reconstructs each submitted layout and recomputes all claims in a fresh sandbox.
"""
import json
import math
import hashlib
from pathlib import Path
from pyproj import Transformer
from shapely.affinity import rotate
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import transform, unary_union
from shapely.prepared import prep

VERSION = "design-walk-v1"
FLOOR_HEIGHT_M = 3.5
OPEN_WIDTH_M = 4.0
STRATEGIES = ("balanced", "open_space", "low_rise")
SERVICES = ("clinic", "library", "school", "community_center")
PROPOSAL_KEYS = {"site_id", "longitude", "latitude", "width_m", "depth_m", "rotation_deg", "floors"}


def validate_proposals(proposals):
    if not isinstance(proposals, list) or len(proposals) > 12:
        raise ValueError("Supply at most 12 bounded design proposals.")
    seen = set()
    for row in proposals:
        if not isinstance(row, dict) or set(row) != PROPOSAL_KEYS:
            raise ValueError("Design proposals must contain only the allowed placement parameters.")
        if not isinstance(row["site_id"], str) or not 1 <= len(row["site_id"]) <= 80 or row["site_id"] in seen:
            raise ValueError("Each proposal needs a unique source plot ID.")
        seen.add(row["site_id"])
        for key, low, high in (("longitude", -180, 180), ("latitude", -80, 84), ("width_m", 5, 100), ("depth_m", 5, 100), ("rotation_deg", 0, 360)):
            val = row[key]
            if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val) or not low <= val <= high:
                raise ValueError("Invalid design placement parameter: " + key)
        if type(row["floors"]) is not int or not 1 <= row["floors"] <= 6:
            raise ValueError("Floors must be an integer from 1 to 6.")
    return proposals


def context(request):
    project = Transformer.from_crs("EPSG:4326", request["projected_crs"], always_xy=True).transform
    inverse = Transformer.from_crs(request["projected_crs"], "EPSG:4326", always_xy=True).transform
    area = transform(project, box(*request["study_area"]))
    spec = request["design"]
    for key, low, high in (("target_floor_area_m2",100,5000), ("max_floors",1,6), ("min_open_space_pct",10,85), ("setback_m",0,20)):
        value = spec.get(key)
        if isinstance(value,bool) or not isinstance(value,(float,int)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError("Invalid design goal: " + key)
    if type(spec["max_floors"]) is not int:
        raise ValueError("Maximum floors must be an integer.")
    inventory = request["land_inventory"]
    if any(inventory.get(k) != "complete_for_candidate_sites" for k in ("building_coverage","road_coverage","restriction_coverage")):
        raise ValueError("Incomplete supplied land obstruction coverage")
    sites, obstacles, services = [], [], []
    counts = {kind: 0 for kind in SERVICES}
    for f in request["features"]:
        geom = shape(f["geometry"])
        if geom.is_empty or not geom.is_valid:
            raise ValueError("Invalid supplied geometry")
        geom = transform(project, geom)
        props = f["properties"]
        if props["layer"] == "candidate_site":
            sites.append((f,geom))
        elif props["layer"] in ("building","restricted"):
            obstacles.append(geom)
        elif props["layer"] == "service":
            if props.get("service_type") in counts and area.covers(geom.representative_point()):
                counts[props["service_type"]] += 1
            if props.get("service_type") == request["service_type"]:
                services.append((f,geom))
    ids = [f.get("id") for f,g in sites]
    if not 1 <= len(sites) <= 100 or any(not isinstance(i,str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Supply 1 to 100 uniquely identified plots")
    obstruction = unary_union(obstacles)
    return {"project":project,"inverse":inverse,"area":area,"spec":spec,"sites":sites,
            "obstruction":obstruction,"obstruction_prepared":prep(obstruction),"services":services,"counts":counts}


def eligible_record(f, parcel, ctx, request):
    props = f["properties"]
    return (props.get("land_status") == "available" and isinstance(props.get("source"),str)
            and props["source"].strip() and isinstance(props.get("allowed_services"),list) and request["service_type"] in props["allowed_services"]
            and parcel.geom_type in ("Polygon","MultiPolygon") and ctx["area"].intersects(parcel))


def open_reserve(parcel, footprint, ctx):
    clear_land = parcel.intersection(ctx["area"]).difference(ctx["obstruction"])
    pieces = list(clear_land.geoms) if clear_land.geom_type == "MultiPolygon" else [clear_land]
    connected = [p for p in pieces if p.geom_type == "Polygon" and p.covers(footprint)]
    # Land across an obstacle or on a disconnected tax-lot fragment cannot serve
    # as the proposal's usable outdoor reserve.
    usable_land = unary_union(connected)
    raw = usable_land.difference(footprint)
    # A geometric width proxy, not a landscape, accessibility or drainage approval.
    usable = raw.buffer(-OPEN_WIDTH_M/2).buffer(OPEN_WIDTH_M/2).intersection(raw)
    parts = list(usable.geoms) if usable.geom_type == "MultiPolygon" else [usable] if usable.geom_type == "Polygon" else []
    parts = [p for p in parts if not p.is_empty and p.area > 0]
    largest = max(parts, key=lambda p:(p.area, p.wkt)) if parts else None
    return raw, largest


def footprint_for(row, ctx):
    x,y = ctx["project"](row["longitude"], row["latitude"])
    return rotate(box(x-row["width_m"]/2,y-row["depth_m"]/2,x+row["width_m"]/2,y+row["depth_m"]/2), row["rotation_deg"], origin=(x,y))


def check_layout(row, f, parcel, ctx, request):
    spec = ctx["spec"]
    if not eligible_record(f,parcel,ctx,request):
        raise ValueError("The supplied land record cannot support proposal " + row["site_id"])
    footprint = footprint_for(row,ctx)
    if row["floors"] > spec["max_floors"] or footprint.area*row["floors"] + .001 < spec["target_floor_area_m2"]:
        raise ValueError("Proposal does not meet the required floor area or floor limit")
    clearance = footprint.buffer(spec["setback_m"],join_style=2)
    if not parcel.covers(clearance) or not ctx["area"].covers(clearance) or clearance.intersects(ctx["obstruction"]):
        raise ValueError("Proposal fails parcel, setback, area or obstruction checks")
    raw, reserve = open_reserve(parcel,footprint,ctx)
    if reserve is None or reserve.area/parcel.area*100 + 1e-7 < spec["min_open_space_pct"]:
        raise ValueError("Proposal does not preserve the required connected usable open space")
    return footprint, raw, reserve


def search_layouts(request, strategy="balanced"):
    """Explore a bounded rectangle family; one alternative per supplied plot."""
    if strategy not in STRATEGIES:
        raise ValueError("Unknown design strategy")
    ctx = context(request); spec = ctx["spec"]; proposals = []
    for f,parcel in ctx["sites"]:
        if not eligible_record(f,parcel,ctx,request):
            continue
        buildable = parcel.intersection(ctx["area"]).difference(ctx["obstruction"])
        if buildable.area <= 0:
            continue
        anchors = [buildable.representative_point(),buildable.centroid]
        parts = list(buildable.geoms) if buildable.geom_type == "MultiPolygon" else [buildable]
        for part in sorted(parts,key=lambda p:-p.area)[:2]:
            if part.geom_type != "Polygon":
                continue
            a,b,c,d = part.bounds
            anchors += [Point(a+(col+.5)*(c-a)/3,b+(row+.5)*(d-b)/3) for row in range(3) for col in range(3)]
        ring = list(parcel.minimum_rotated_rectangle.exterior.coords)
        angle = math.degrees(math.atan2(ring[1][1]-ring[0][1],ring[1][0]-ring[0][0])) % 180
        rotations = sorted(set([0.,45.,90.,135.,round(angle,6),round((angle+90)%180,6)]))
        parcel_check, area_check = prep(parcel), prep(ctx["area"])
        trials = []
        for floors in range(1,spec["max_floors"]+1):
            for aspect in (.7,1.,1.4):
                # Tiny area margin compensates for CRS round trips without undersizing.
                width = math.sqrt((spec["target_floor_area_m2"]+.01)/floors*aspect)
                depth = (spec["target_floor_area_m2"]+.01)/floors/width
                if not (5 <= min(width,depth) and max(width,depth) <= 100):
                    continue
                if buildable.area-width*depth < parcel.area*spec["min_open_space_pct"]/100:
                    continue
                for point in anchors[:20]:
                    for rotation in rotations:
                        footprint = rotate(box(point.x-width/2,point.y-depth/2,point.x+width/2,point.y+depth/2),rotation,origin=(point.x,point.y))
                        clearance = footprint.buffer(spec["setback_m"],join_style=2)
                        if not parcel_check.covers(clearance) or not area_check.covers(clearance) or ctx["obstruction_prepared"].intersects(clearance):
                            continue
                        # Retain a bounded shortlist favouring edge placement, then measure reserve.
                        edge = point.distance(parcel.boundary)
                        lon,lat = ctx["inverse"](point.x,point.y)
                        row = {"site_id":f["id"],"longitude":lon,"latitude":lat,"width_m":width,"depth_m":depth,"rotation_deg":rotation,"floors":floors}
                        trials.append((floors,edge,rotation,lon,lat,row))
        # Test several placements per floor count, avoiding thousands of costly buffers.
        shortlist = []
        for floors in range(1,spec["max_floors"]+1):
            shortlist.extend(sorted((t for t in trials if t[0]==floors),key=lambda t:t[:5])[:8])
        best = None
        for trial in shortlist:
            row = trial[-1]
            try:
                footprint,raw,reserve = check_layout(row,f,parcel,ctx,request)
            except ValueError:
                continue
            pct = reserve.area/parcel.area*100
            score = (row["floors"],-pct) if strategy=="low_rise" else (-pct,row["floors"]) if strategy=="open_space" else (-(pct-6*(row["floors"]-1)),row["floors"])
            key = (*score,row["rotation_deg"],row["longitude"],row["latitude"])
            if best is None or key < best[0]:
                best = (key,row)
        if best:
            origin = parcel.representative_point()
            gap = min((origin.distance(g) for _,g in ctx["services"]),default=0)
            proposals.append((-gap,-parcel.area,f["id"],best[1]))
    return [p[-1] for p in sorted(proposals,key=lambda p:p[:3])[:12]]


def _walking(request,candidates):
    # Resolve the same read-only toolkit in local tests and in python -I sandboxes.
    try:
        from app.walking import compare_walk_access
    except ModuleNotFoundError:
        import importlib.util
        spec = importlib.util.spec_from_file_location("geoscope_walking","/input/walking.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        compare_walk_access = module.compare_walk_access
    return compare_walk_access(request,candidates)


def evaluate_proposals(request, proposals, strategy="balanced"):
    validate_proposals(proposals)
    if strategy not in STRATEGIES:
        raise ValueError("Unknown design strategy")
    ctx=context(request); spec=ctx["spec"]; by_id={f["id"]:(f,g) for f,g in ctx["sites"]}
    candidates=[]
    for row in proposals:
        if row["site_id"] not in by_id:
            raise ValueError("Unknown source plot in design proposal")
        f,parcel=by_id[row["site_id"]]
        footprint,raw,reserve=check_layout(row,f,parcel,ctx,request)
        origin=parcel.representative_point(); gap=min((origin.distance(g) for _,g in ctx["services"]),default=None)
        candidates.append({"id":row["site_id"],"longitude":row["longitude"],"latitude":row["latitude"],
            "plot_area_m2":parcel.area,"nearest_existing_service_m":gap,
            "services_within_threshold":sum(origin.distance(g)<=request["threshold_m"] for _,g in ctx["services"]),
            "footprint":mapping(transform(ctx["inverse"],footprint)),"open_space":mapping(transform(ctx["inverse"],reserve)),
            "building":{"width_m":row["width_m"],"depth_m":row["depth_m"],"height_m":row["floors"]*FLOOR_HEIGHT_M,"setback_m":spec["setback_m"]},
            "design":{"floors":row["floors"],"floor_height_m":FLOOR_HEIGHT_M,"gross_floor_area_m2":footprint.area*row["floors"],
                "footprint_area_m2":footprint.area,"total_open_area_m2":raw.area,"usable_open_area_m2":reserve.area,
                "usable_open_space_pct":reserve.area/parcel.area*100,"min_open_space_pct":spec["min_open_space_pct"],
                "open_space_width_proxy_m":OPEN_WIDTH_M,"strategy":strategy},
            "land_check":{"source":f["properties"]["source"],"land_status":"available","allowed_service":True,
                "plot_fit":True,"area_fit":True,"no_building_overlap":True,"no_road_overlap":True,"no_restriction_overlap":True,
                "setback_m":spec["setback_m"],"rotation_deg":row["rotation_deg"],"footprint_area_m2":footprint.area}})
    access=_walking(request,candidates)
    for candidate,comparison in zip(candidates,access):
        candidate["access"]=comparison
    # Walking benefits remain outcomes, not an invented precise demand objective.
    candidates.sort(key=lambda c:(-(c["nearest_existing_service_m"] or 0),-c["design"]["usable_open_space_pct"],c["id"]))
    selected={c["id"] for c in candidates}
    checks=[{"id":f["id"],"status":"eligible" if f["id"] in selected else "not_proposed",
        "reason":"Submitted layout passed floor-area, open-space and land checks." if f["id"] in selected else "No layout submitted for this plot; this is not proof that no design can fit.",
        "source":f["properties"].get("source","")} for f,g in ctx["sites"]]
    basis="best among submitted layouts: greatest mapped-service gap, then connected usable open-space percentage, then plot ID"
    metrics={"analysis_crs":request["projected_crs"],"threshold_m":request["threshold_m"],"service_type":request["service_type"],
        "study_area":request["study_area"],"service_features":len(ctx["services"]),"sites_evaluated":len(proposals),
        "sites_available":len(ctx["sites"]),"eligible_sites":len(candidates),"site_checks":checks,"land_inventory":request["land_inventory"],
        "candidates":candidates[:3],"building":request.get("building"),"design":spec,"toolkit_version":VERSION,"toolkit_sha256":hashlib.sha256(Path(__file__).read_bytes() + Path(__file__).with_name("walking.py").read_bytes()).hexdigest(),"design_strategy":strategy,
        "baseline_scope":"supplied matching service features","inventory_status":"matching services supplied" if ctx["services"] else "no matching service inventory supplied",
        "ranking_basis":basis,"existing_services_in_area":ctx["counts"][request["service_type"]],"existing_service_counts":ctx["counts"],
        "service_inventory":request.get("service_inventory",{"source":"Supplied mapped records; completeness unknown"}),
        "design_limits":"Rectangular massing only. 3.5 m per floor. Open space is a connected 4 m geometric-width proxy; it is reserved, not planted or certified permeable. No carbon, energy, zoning or construction certification."}
    result={"mode":"scenario","metrics":metrics,"comparison":{"preferred_candidate":candidates[0]["id"] if candidates else None,"basis":basis},
            "design_proposals":proposals,"design_strategy":strategy}
    # Keep source service map contract; design/open space/routes live in verified metrics.
    preferred=by_id[candidates[0]["id"]][1].representative_point() if candidates else None
    mapped=[]
    for f,g in ctx["services"]:
        distance=preferred.distance(g) if preferred is not None else None
        mapped.append({**f,"properties":{**f["properties"],"nearest_m":distance,"underserved":distance is None or distance>request["threshold_m"]}})
    return json.loads(json.dumps(result,allow_nan=False)),{"type":"FeatureCollection","features":mapped}


def inspect_design(request):
    ctx=context(request)
    return {"mode":"scenario","metrics":{"toolkit_version":VERSION,"design":ctx["spec"],"sites_available":len(ctx["sites"]),
        "existing_service_counts":ctx["counts"],"walking_network_available":bool(request.get("walk_network")),
        "method":"Agent selects a bounded strategy and proposes layouts. A separate sandbox reconstructs geometry and recomputes open space and walking metrics for submitted proposals."}}
