#!/usr/bin/env python3
"""Fetch compact, dated pedestrian graphs for the SF and East Harlem demo areas.

This script performs trusted preparation only. Runtime analysis consumes the
checked-in JSON graph snapshots and never calls Overpass or another service.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import ssl
import urllib.error
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"data"/"walk"
OSM_COPYRIGHT="https://www.openstreetmap.org/copyright"
ODBL="https://opendatacommons.org/licenses/odbl/1-0/"
ENDPOINTS=("https://overpass.private.coffee/api/interpreter","https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter")
REGIONS={
    "sf":{"bounds":[-122.443,37.750,-122.407,37.784],"area_bounds":[-122.433,37.758,-122.417,37.776],"buffer_approx_m":850},
    "nyc":{"bounds":[-73.965,40.782,-73.920,40.820],"area_bounds":[-73.955,40.790,-73.930,40.812],"buffer_approx_m":850},
}
EXCLUDE_HIGHWAY={"motorway","motorway_link","trunk","trunk_link","construction","proposed","raceway","bridleway","abandoned","platform"}
FALSE={"no","private","use_sidepath"}
TRUE={"yes","1","true","designated"}
MAX_NODES,MAX_EDGES=40_000,80_000

def digest(data:bytes)->str:
    return hashlib.sha256(data).hexdigest()

def ql(bounds):
    west,south,east,north=bounds
    bbox=f"{south},{west},{north},{east}"
    # Overpass QL way result plus recursive member nodes preserves shared OSM
    # topology; edges are consecutive nodes of the original ways.
    return f'[out:json][timeout:180][maxsize:268435456];way["highway"]({bbox});out body;>;out skel qt;'

def fetch(query, timeout):
    errors=[]
    context=ssl.create_default_context()
    for endpoint in ENDPOINTS:
        req=urllib.request.Request(endpoint,data=urllib.parse.urlencode({"data":query}).encode(),
            headers={"User-Agent":"GeoScopeWalkingSnapshot/1.0 (bounded public OSM extract)","Content-Type":"application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req,timeout=timeout,context=context) as response:
                if response.status!=200: raise RuntimeError(f"HTTP {response.status}")
                raw=response.read(40*1024*1024+1)
            if len(raw)>40*1024*1024: raise ValueError("Overpass response exceeds 40 MiB safety bound")
            payload=json.loads(raw)
            if not isinstance(payload.get("elements"),list) or not payload.get("osm3s",{}).get("timestamp_osm_base"):
                raise ValueError("Overpass response lacks elements or data timestamp")
            return raw,payload,endpoint
        except Exception as exc:
            errors.append(f"{endpoint}: {type(exc).__name__}: {exc}")
    raise RuntimeError("All configured Overpass endpoints failed: "+"; ".join(errors))

def pedestrian_allowed(tags):
    highway=tags.get("highway","")
    if not highway or highway in EXCLUDE_HIGHWAY or tags.get("area")=="yes": return False
    access=tags.get("access","").lower()
    foot=tags.get("foot","").lower()
    if access in FALSE or foot in FALSE: return False
    # The runtime graph is bidirectional. Omit explicit foot-one-way ways rather
    # than silently permitting a direction that OSM marks as prohibited.
    foot_oneway=tags.get("oneway:foot","").lower()
    if foot_oneway in TRUE or foot_oneway=="-1": return False
    return True

def compact(payload,bounds):
    elements=payload["elements"]
    west,south,east,north=bounds
    def inside(node_id):
        node=nodes.get(node_id)
        return node is not None and west<=node["lon"]<=east and south<=node["lat"]<=north
    nodes={e["id"]:e for e in elements if e.get("type")=="node" and "lat" in e and "lon" in e}
    ways=[e for e in elements if e.get("type")=="way" and pedestrian_allowed(e.get("tags",{}))]
    used=set(); edges=[]; accepted=0
    for way in ways:
        ids=way.get("nodes",[])
        if len(ids)<2 or any(node_id not in nodes for node_id in ids): continue
        way_edges=[(u,v) for u,v in zip(ids,ids[1:]) if u!=v and inside(u) and inside(v)]
        if not way_edges: continue
        accepted+=1
        for u,v in way_edges:
            edges.append((u,v)); used.update((u,v))
    used_nodes=sorted(used)
    if len(used_nodes)>MAX_NODES or len(edges)>MAX_EDGES:
        raise ValueError(f"Filtered snapshot exceeds runtime bounds: {len(used_nodes)} nodes, {len(edges)} edges; refusing truncation.")
    if not edges: raise ValueError("No walkable shared-node edges remain after access filtering.")
    return {
        "bounds":bounds,
        "nodes":[{"id":str(i),"longitude":float(nodes[i]["lon"]),"latitude":float(nodes[i]["lat"])} for i in used_nodes],
        "edges":[{"u":str(u),"v":str(v)} for u,v in edges],
    },{"ways_returned":sum(e.get("type")=="way" for e in elements),"pedestrian_ways":accepted,
       "node_elements":len(nodes),"nodes_used":len(used_nodes),"edge_segments":len(edges)}

def prepare(name, timeout):
    cfg=REGIONS[name]; query=ql(cfg["bounds"])
    raw,payload,endpoint=fetch(query,timeout)
    compacted,counts=compact(payload,cfg["bounds"])
    captured=datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z")
    data={"schema_version":1,**compacted,"source":"OpenStreetMap pedestrian highway graph via Overpass API",
          "as_of":payload["osm3s"]["timestamp_osm_base"],"prepared_at":captured,
          "license":"Open Database License (ODbL) 1.0","attribution":"© OpenStreetMap contributors"}
    raw_bytes=(json.dumps(data,sort_keys=True,separators=(",",":"),allow_nan=False)+"\n").encode()
    OUT.mkdir(parents=True,exist_ok=True)
    path=OUT/f"{name}.json"
    path.write_bytes(raw_bytes)
    manifest={"area":name,"study_area_bounds":cfg["area_bounds"],"network_bounds":cfg["bounds"],
        "buffer_approx_m":cfg["buffer_approx_m"],"source_endpoint":endpoint,"query":query,
        "osm_data_timestamp":data["as_of"],"prepared_at":captured,"counts":counts,
        "filter":{"excluded_highway":sorted(EXCLUDE_HIGHWAY),"excluded_access_values":sorted(FALSE),
                  "excluded_explicit_oneway_foot":True,"graph_directionality":"undirected; explicit oneway:foot ways omitted"},
        "sha256_snapshot":digest(raw_bytes),"sha256_overpass_response":digest(raw),"snapshot_file":path.name,"license":"ODbL 1.0",
        "license_url":ODBL,"attribution":data["attribution"],"copyright_url":OSM_COPYRIGHT,
        "limitations":["OSM pedestrian tags and connectivity are not a guarantee of safe/current walkability.",
          "Motor-vehicle one-way tagging is not used as a pedestrian restriction; explicitly one-way foot ways are excluded.",
          "This extract does not encode verified building entrances, crossing delay, slope, closures, signals, or step-free accessibility.",
          "Bounds include an approximately 850 m rectangular buffer around the named demo extent; routing beyond its edge is not represented."]}
    (OUT/f"{name}-manifest.json").write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    print(json.dumps({"area":name,"file":str(path.relative_to(ROOT)),"sha256":manifest["sha256_snapshot"],"counts":counts,"as_of":data["as_of"]}))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--area",choices=("sf","nyc","all"),default="all")
    parser.add_argument("--timeout",type=int,default=240)
    args=parser.parse_args()
    names=REGIONS if args.area=="all" else [args.area]
    for name in names: prepare(name,args.timeout)

if __name__=="__main__": main()
