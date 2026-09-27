"""GIS-free sandbox staging, proposal admission and model tool contract."""
import json
import math
from pathlib import Path

TOOLKIT_FILES = ("simulation_program.py", "walking.py")
LOADER = """import importlib.util, json
spec = importlib.util.spec_from_file_location('geoscope_design', '/input/simulation_program.py')
toolkit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(toolkit)
with open('/input/request.json', encoding='utf-8') as handle:
    request = json.load(handle)
"""


def reference_script(data):
    if "design_proposals" not in data:
        return LOADER + "result=toolkit.inspect_design(request)\nwith open('/output/result.json','w') as f: json.dump(result,f,allow_nan=False)\n"
    return LOADER + """result, mapped = toolkit.evaluate_proposals(request, request['design_proposals'], request['design_strategy'])
with open('/output/result.json','w') as f: json.dump(result,f,allow_nan=False)
with open('/output/result.geojson','w') as f: json.dump(mapped,f,allow_nan=False)
"""


def bind_proposals(original, result):
    """No model-provided constraints, geometry or executable strings cross this boundary."""
    proposals = result.get("design_proposals") if isinstance(result,dict) else None
    strategy = result.get("design_strategy") if isinstance(result,dict) else None
    if strategy not in ("balanced","open_space","low_rise"):
        raise ValueError("A bounded design strategy is required")
    if not isinstance(proposals,list) or len(proposals)>12:
        raise ValueError("At most 12 design proposals are allowed")
    allowed={"site_id","longitude","latitude","width_m","depth_m","rotation_deg","floors"}
    site_ids={f.get("id") for f in original["features"] if f["properties"]["layer"]=="candidate_site"}
    seen=set()
    for p in proposals:
        if not isinstance(p,dict) or set(p)!=allowed:
            raise ValueError("Unexpected design proposal fields")
        if not isinstance(p["site_id"],str) or p["site_id"] not in site_ids or p["site_id"] in seen:
            raise ValueError("Unknown or duplicate design site")
        seen.add(p["site_id"])
        if type(p["floors"]) is not int or not 1<=p["floors"]<=original["design"]["max_floors"]:
            raise ValueError("Invalid proposed floor count")
        for key,low,high in (("longitude",-180,180),("latitude",-80,84),("width_m",5,100),("depth_m",5,100),("rotation_deg",0,360)):
            value=p[key]
            if isinstance(value,bool) or not isinstance(value,(float,int)) or not math.isfinite(value) or not low<=value<=high:
                raise ValueError("Invalid proposed " + key)
    return {**original,"design_proposals":proposals,"design_strategy":strategy}


SCRIPT_INSTRUCTIONS = """Write only one complete Python script. You are the layout-design agent. Choose a strategy based on the user's intent, search actual layouts, then compute land/open-space and before/after walking outcomes. You run inside a no-network gVisor sandbox. Use the immutable toolkit /input/simulation_program.py via importlib.util.spec_from_file_location; ordinary imports from /input do not work with python -I. Read request=json.load(open('/input/request.json')); structured request.design and request.walk are authoritative. No APIs, subprocesses or invented data.
Toolkit API:
- toolkit.search_layouts(request, strategy) returns at most12 placement dictionaries. Strategies: balanced trades six open-space percentage points per extra floor; open_space maximizes connected reserve; low_rise favors fewer floors meeting the required open reserve. Choose the most relevant strategy; balanced by default. The search explores rectangle proportions, parcel-aligned rotations, placements and floors. You may adapt proposals using the allowed numeric placement fields, but every one must pass the fixed verifier. Never lower the user's goals to make a layout pass.
- toolkit.evaluate_proposals(request, proposals, strategy) returns (result,mapped) by reconstructing footprints from parameters, checking floor area, setbacks, obstructions and minimum connected open space, and computing walking access.
Call search_layouts then evaluate_proposals; save result to /output/result.json and mapped to /output/result.geojson using json.dump(...,allow_nan=False). Preserve all returned fields. Empty proposals are a valid bounded-search outcome; never fabricate a fitting design. Do not copy inspection answers. The worker independently recomputes your submitted proposals in a fresh sandbox and rejects changed metrics. The deterministic toolkit computes measurements; you choose the search strategy and explain choices. Report best among explored/submitted layouts, not a global optimum.
Footprint and floors serve an explicit gross floor-area goal; 3.5m floor height. Connected open space uses a4m geometric-width proxy after excluding supplied obstructions, denominator gross parcel area. This is reserved land, not measured green/permeable land or a carbon/energy claim. Walking uses an offline pedestrian network and the same coarse population origins before/after; disconnected and missing data remain unknown, never zero. Nearest-node connectors are assumptions, not surveyed entrances. Preserve missing-baseline caveats. No construction, ownership, zoning or sustainability certification.
"""
