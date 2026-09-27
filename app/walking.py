"""Offline pedestrian-access comparison over a bounded, staged OSM graph."""
from __future__ import annotations
import heapq, math, hashlib, json
from collections import defaultdict
from pyproj import CRS, Transformer
from shapely.geometry import LineString, Point, box, shape
from shapely.ops import transform

MAX_NODES, MAX_EDGES, MAX_FEATURES = 40_000, 80_000, 100_000
MAX_SAMPLES, MAX_ROUTES, MAX_CANDIDATES = 5_000, 5, 12
MAX_SNAP_M, MAX_WALK_MINUTES, GRID_M = 200.0, 20.0, 250.0


def _num(value, name, low=None, high=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be finite numeric data.")
    value=float(value)
    if (low is not None and value < low) or (high is not None and value > high):
        raise ValueError(f"{name} is outside its supported range.")
    return value


def _bounds(value, name):
    if not isinstance(value,(list,tuple)) or len(value)!=4:
        raise ValueError(f"{name} must be [west, south, east, north].")
    w,s,e,n=(_num(x,name) for x in value)
    if not (-180<=w<e<=180 and -80<=s<n<=84): raise ValueError(f"{name} is not a valid EPSG:4326 rectangle.")
    return w,s,e,n


def _key(value,name):
    if not isinstance(value,(str,int)) or isinstance(value,bool) or not str(value) or len(str(value))>100:
        raise ValueError(f"{name} must be a short nonempty identifier.")
    return str(value)


class Graph:
    def __init__(self, network, project):
        if not isinstance(network,dict): raise ValueError("No staged walking network.")
        nodes,edges=network.get("nodes"),network.get("edges")
        if not isinstance(nodes,list) or not 1<=len(nodes)<=MAX_NODES: raise ValueError(f"Network must contain at most {MAX_NODES} nodes.")
        if not isinstance(edges,list) or not 1<=len(edges)<=MAX_EDGES: raise ValueError(f"Network must contain at most {MAX_EDGES} edges.")
        self.bounds=_bounds(network.get("bounds"),"walk_network.bounds")
        self.ids=[]; self.xy=[]; idmap={}
        w,s,e,n=self.bounds
        for i,node in enumerate(nodes):
            if not isinstance(node,dict): raise ValueError(f"Node {i} must be an object.")
            key=_key(node.get("id"),"node ID")
            if key in idmap: raise ValueError("Node IDs must be unique.")
            lon=_num(node.get("longitude"),"node longitude",-180,180)
            lat=_num(node.get("latitude"),"node latitude",-80,84)
            if not w<=lon<=e or not s<=lat<=n: raise ValueError("A network node falls outside declared bounds.")
            x,y=project(lon,lat); idmap[key]=len(self.ids); self.ids.append(key); self.xy.append((float(x),float(y)))
        self.adj=[[] for _ in self.ids]; seen=set()
        for i,edge in enumerate(edges):
            if isinstance(edge,dict): u0,v0,stated=edge.get("u"),edge.get("v"),edge.get("length_m")
            elif isinstance(edge,(list,tuple)) and len(edge)>=2: u0,v0,stated=edge[0],edge[1],edge[2] if len(edge)>2 else None
            else: raise ValueError(f"Edge {i} must provide endpoint IDs.")
            uk,vk=_key(u0,"edge.u"),_key(v0,"edge.v")
            if uk not in idmap or vk not in idmap or uk==vk: raise ValueError(f"Edge {i} has invalid endpoints.")
            u,v=idmap[uk],idmap[vk]; pair=(min(u,v),max(u,v))
            if pair in seen: continue
            seen.add(pair)
            if stated is not None: _num(stated,"edge length_m",.001,100_000)
            x1,y1=self.xy[u]; x2,y2=self.xy[v]; length=math.hypot(x2-x1,y2-y1)
            if not math.isfinite(length) or not 0<length<=100_000: raise ValueError("Invalid projected graph segment.")
            # Recompute, never trust caller-provided route weights.
            self.adj[u].append((v,length)); self.adj[v].append((u,length))
        if not seen: raise ValueError("Network has no usable edges.")
        self.cells=defaultdict(list)
        for i,(x,y) in enumerate(self.xy): self.cells[(math.floor(x/GRID_M),math.floor(y/GRID_M))].append(i)
        self.network=network

    def nearest(self,x,y,maximum):
        cx,cy=math.floor(x/GRID_M),math.floor(y/GRID_M); radius=math.ceil(maximum/GRID_M)+1
        best=None; limit=maximum*maximum
        for gx in range(cx-radius,cx+radius+1):
            for gy in range(cy-radius,cy+radius+1):
                for i in self.cells.get((gx,gy),()):
                    nx,ny=self.xy[i]; d2=(nx-x)**2+(ny-y)**2
                    if d2<=limit and (best is None or d2<best[1]**2 or (d2==best[1]**2 and self.ids[i]<self.ids[best[0]])):
                        best=(i,math.sqrt(d2))
        return best

    def snap_boundary(self,boundary,maximum,blockers):
        x0,y0,x1,y1=boundary.bounds
        gx0,gy0=math.floor((x0-maximum)/GRID_M),math.floor((y0-maximum)/GRID_M)
        gx1,gy1=math.floor((x1+maximum)/GRID_M),math.floor((y1+maximum)/GRID_M)
        ids=[]
        for gx in range(gx0,gx1+1):
            for gy in range(gy0,gy1+1): ids.extend(self.cells.get((gx,gy),()))
        choices=[]
        for i in ids:
            x,y=self.xy[i]; node=Point(x,y); d=boundary.distance(node)
            if d<=maximum: choices.append((d,self.ids[i],i,node))
        choices.sort(key=lambda row:(row[0],row[1]))
        for d,_,i,node in choices:
            anchor=boundary.interpolate(boundary.project(node)); connector=LineString([(anchor.x,anchor.y),(node.x,node.y)])
            clear=True
            if connector.length:
                ax0,ay0,ax1,ay1=connector.bounds
                for obs in blockers:
                    bx0,by0,bx1,by1=obs.bounds
                    if bx1<ax0 or bx0>ax1 or by1<ay0 or by0>ay1: continue
                    if connector.intersects(obs): clear=False; break
            if clear: return i,d,anchor
        return None

    def dijkstra(self,seeds):
        dist=[math.inf]*len(self.ids); parent=[-1]*len(self.ids); heap=[]
        for i,cost in seeds:
            if cost<dist[i]: dist[i]=cost; heapq.heappush(heap,(cost,self.ids[i],i))
        while heap:
            d,_,u=heapq.heappop(heap)
            if d!=dist[u]: continue
            for v,length in self.adj[u]:
                trial=d+length
                if trial<dist[v]: dist[v]=trial; parent[v]=u; heapq.heappush(heap,(trial,self.ids[v],v))
        return dist,parent


def _feature_layers(req,project,area_bounds,graph,snapmax):
    features=req.get("features")
    if not isinstance(features,list) or len(features)>MAX_FEATURES: raise ValueError(f"At most {MAX_FEATURES} dataset features are allowed.")
    area=transform(project,box(*area_bounds)); population=[]; services=[]; blockers=[]; supplied=0
    service_type=req.get("service_type")
    for i,feature in enumerate(features):
        if not isinstance(feature,dict) or not isinstance(feature.get("geometry"),dict): continue
        try:
            geom=shape(feature["geometry"])
            if geom.is_empty or not geom.is_valid: continue
            geom=transform(project,geom)
        except Exception: continue
        props=feature.get("properties") if isinstance(feature.get("properties"),dict) else {}
        layer=props.get("layer")
        if layer=="population":
            weight=props.get("population")
            if isinstance(weight,bool) or not isinstance(weight,(int,float)) or not math.isfinite(weight) or weight<0: continue
            point=geom.representative_point()
            if area.covers(point):
                population.append({"id":str(feature.get("id",f"population-{i+1}")),"point":point,"weight":float(weight),
                                   "snap":graph.nearest(point.x,point.y,snapmax)})
        elif layer in ("service","park"):
            kind="park" if layer=="park" else props.get("service_type")
            if kind==service_type:
                supplied+=1; point=geom.representative_point(); snap=graph.nearest(point.x,point.y,snapmax)
                if snap: services.append({"point":point,"snap":snap})
        elif layer=="building" or (layer=="restricted" and props.get("restriction_type")!="mapped_road_corridor"):
            blockers.append(geom)
    if not population: raise ValueError("No population representative points are inside the study area.")
    return population,services,blockers,supplied


def _candidate_snap(candidate,graph,project,blockers,snapmax):
    try:
        data=candidate.get("footprint")
        if not isinstance(data,dict): return None,"candidate has no GeoJSON footprint"
        geom=shape(data)
        if geom.geom_type not in ("Polygon","MultiPolygon") or geom.is_empty or not geom.is_valid:
            return None,"candidate footprint is not a valid polygon"
        geom=transform(project,geom); found=graph.snap_boundary(geom.boundary,snapmax,blockers)
        if found is None: return None,"no pedestrian node within snap limit with a clear mapped connector"
        node,distance,anchor=found
        return {"node":node,"connector":distance,"anchor":anchor},None
    except Exception as exc: return None,f"invalid candidate footprint ({type(exc).__name__})"


def _route(graph,node,parent,start,target,unproject):
    chain=[node]
    while parent[chain[-1]]>=0 and len(chain)<=len(graph.ids): chain.append(parent[chain[-1]])
    coords=[(start.x,start.y),*(graph.xy[i] for i in chain),(target.x,target.y)]; out=[]
    for x,y in coords:
        lon,lat=unproject(x,y); point=[float(lon),float(lat)]
        if not out or point!=out[-1]: out.append(point)
    return out


def _unavailable(reason,walk,network):
    return {"status":"unavailable","reason":reason,"minutes":walk.get("minutes"),"speed_mps":walk.get("speed_mps"),
            "network_source":network.get("source"),"network_as_of":network.get("as_of"),"baseline_known":False,
            "estimated_population_total":None,"compared_population":None,"unmatched_population":None,
            "before_served_population":None,"after_served_population":None,"newly_served_population":None,
            "before_mean_minutes":None,"after_mean_minutes":None,"samples":[],"routes":[]}


def compare_walk_access(request:dict,candidates:list[dict])->list[dict]:
    """Compare walking access before/after candidate footprints in candidate order.

    Unreachable demand remains unknown. Per-candidate output caps detailed samples
    at 5,000 and route GeoJSON examples at five features.
    """
    if not isinstance(request,dict): raise ValueError("request must be an object.")
    if not isinstance(candidates,list) or len(candidates)>MAX_CANDIDATES: raise ValueError(f"At most {MAX_CANDIDATES} candidates are allowed.")
    walk,network=request.get("walk"),request.get("walk_network")
    if not isinstance(walk,dict): raise ValueError("walk settings are required.")
    minutes=_num(walk.get("minutes"),"walk.minutes",1,MAX_WALK_MINUTES)
    speed=_num(walk.get("speed_mps"),"walk.speed_mps",.3,2.5)
    snapmax=_num(walk.get("max_snap_m"),"walk.max_snap_m",1,MAX_SNAP_M)
    bounds=_bounds(request.get("study_area"),"study_area")
    try:
        crs=CRS.from_user_input(request.get("projected_crs"))
        if not crs.is_projected or crs.axis_info[0].unit_name.lower() not in {"metre","meter","metres","meters"}: raise ValueError()
        project=Transformer.from_crs("EPSG:4326",crs,always_xy=True).transform
        unproject=Transformer.from_crs(crs,"EPSG:4326",always_xy=True).transform
    except Exception as exc: raise ValueError("A projected metric CRS is required.") from exc
    if not isinstance(network,dict): return [_unavailable("No staged pedestrian network is available.",walk,{}) for _ in candidates]
    try:
        graph=Graph(network,project); w,s,e,n=bounds; nw,ns,ne,nn=graph.bounds
        if not(nw<=w and ns<=s and ne>=e and nn>=n): raise ValueError("Network snapshot does not cover the full study area.")
        area_shape=transform(project,box(*bounds))
        network_shape=transform(project,box(*graph.bounds))
        margin_m=area_shape.distance(network_shape.boundary)
        if margin_m + 0.1 < minutes*60*speed:
            raise ValueError(f"Network coverage has only {margin_m:.0f} m of edge padding for a {minutes*60*speed:.0f} m walk budget. Choose a shorter walk or smaller study area.")
        pops,services,blockers,supplied=_feature_layers(request,project,bounds,graph,snapmax)
    except Exception as exc:
        return [_unavailable(str(exc)[:500],walk,network) for _ in candidates]
    baseline_known=bool(services)
    seed_anchors={}
    seeds=[]
    for service in services:
        node,connector=service["snap"]; seeds.append((node,connector))
        current=seed_anchors.get(node)
        if current is None or connector<current[0]: seed_anchors[node]=(connector,service["point"])
    before_dist,before_parent=graph.dijkstra(seeds) if seeds else ([math.inf]*len(graph.ids),[-1]*len(graph.ids))
    limit=minutes*60*speed; out=[]
    for candidate in candidates:
        cid=str(candidate.get("id","")) if isinstance(candidate,dict) else ""
        if not isinstance(candidate,dict):
            result=_unavailable("candidate must be an object",walk,network); result["candidate_id"]=cid; out.append(result); continue
        proposal,error=_candidate_snap(candidate,graph,project,blockers,snapmax)
        if error:
            result=_unavailable(error,walk,network); result["candidate_id"]=cid; out.append(result); continue
        after_dist,after_parent=graph.dijkstra([(proposal["node"],proposal["connector"])])
        total=sum(row["weight"] for row in pops)
        compared=unmatched=before_served=after_served=new=0.0
        prop_reach=prop_served=prop_time=0.0; bw=aw=bsum=asum=0.0; samples=[]; route_rows=[]
        for row in pops:
            weight,snap=row["weight"],row["snap"]; lon,lat=unproject(row["point"].x,row["point"].y)
            if snap is None:
                unmatched+=weight; sample={"id":row["id"],"longitude":float(lon),"latitude":float(lat),"population":weight,"before_minutes":None,"after_minutes":None,"status":"unknown"}
            else:
                node,connector=snap
                old=before_dist[node]+connector if math.isfinite(before_dist[node]) else math.inf
                site=after_dist[node]+connector if math.isfinite(after_dist[node]) else math.inf
                if math.isfinite(site):
                    prop_reach+=weight; prop_time+=weight*site/speed/60
                    if site<=limit: prop_served+=weight
                if math.isfinite(old):
                    after=min(old,site); compared+=weight; bw+=weight; aw+=weight
                    bsum+=weight*old/speed/60; asum+=weight*after/speed/60
                    if old<=limit: before_served+=weight
                    if after<=limit: after_served+=weight
                    if old>limit and after<=limit: new+=weight
                    status="improved" if site<old else ("within_limit" if after<=limit else "over_limit")
                    old_min,after_min=old/speed/60,after/speed/60
                    if status=="improved" and after<=limit and len(route_rows)<MAX_ROUTES:
                        chain=[node]
                        while before_parent[chain[-1]]>=0 and len(chain)<=len(graph.ids): chain.append(before_parent[chain[-1]])
                        target=seed_anchors.get(chain[-1],(0,None))[1]
                        bcoords=_route(graph,node,before_parent,row["point"],target,unproject) if target else None
                        acoords=_route(graph,node,after_parent,row["point"],proposal["anchor"],unproject)
                        route_rows.append((weight,row["id"],old_min,after_min,bcoords,acoords))
                    sample={"id":row["id"],"longitude":float(lon),"latitude":float(lat),"population":weight,"before_minutes":old_min,"after_minutes":after_min,"status":status}
                else:
                    unmatched+=weight; sample={"id":row["id"],"longitude":float(lon),"latitude":float(lat),"population":weight,"before_minutes":None,"after_minutes":site/speed/60 if math.isfinite(site) else None,"status":"proposal_only" if math.isfinite(site) else "unknown"}
                    if not baseline_known and math.isfinite(site) and site<=limit and len(route_rows)<MAX_ROUTES:
                        route_rows.append((weight,row["id"],None,site/speed/60,None,_route(graph,node,after_parent,row["point"],proposal["anchor"],unproject)))
            if len(samples)<MAX_SAMPLES: samples.append(sample)
        routes=[]
        for weight,demand_id,bmin,amin,bcoords,acoords in sorted(route_rows,key=lambda r:(-r[0],r[1])):
            for phase,mins,coords in (("before",bmin,bcoords),("after",amin,acoords)):
                if len(routes)>=MAX_ROUTES: break
                if coords and len(coords)>=2:
                    routes.append({"type":"Feature","id":f"route-{len(routes)+1:02d}",
                        "properties":{"phase":phase,"demand_id":demand_id,"minutes":mins,"estimated_population_weight":weight},
                        "geometry":{"type":"LineString","coordinates":coords}})
            if len(routes)>=MAX_ROUTES: break
        count=lambda v:int(v) if float(v).is_integer() else float(v)
        out.append({"candidate_id":cid,"status":"available","minutes":minutes,"speed_mps":speed,
            "network_source":network.get("source"),"network_as_of":network.get("as_of"),"network_bounds":list(graph.bounds),
            "network_sha256":hashlib.sha256(json.dumps(network,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest(),"coverage_margin_m":margin_m,
            "baseline_known":baseline_known,"supplied_services":supplied,"matched_services":len(services),
            "estimated_population_total":count(total),"compared_population":count(compared),"unmatched_population":count(unmatched),
            "proposal_reachable_population":count(prop_reach),"proposal_served_population":count(prop_served),
            "proposal_mean_minutes":prop_time/prop_reach if prop_reach else None,
            "before_served_population":count(before_served) if baseline_known and compared else None,
            "after_served_population":(count(after_served) if compared else None) if baseline_known else count(prop_served),
            "newly_served_population":count(new) if baseline_known and compared else None,
            "before_mean_minutes":bsum/bw if baseline_known and bw else None,"after_mean_minutes":asum/aw if baseline_known and aw else None,
            "mean_walk_reduction_minutes":(bsum/bw-asum/aw) if baseline_known and bw and aw else None,
            "newly_served_pct":(new/compared*100) if baseline_known and compared else None,
            "sample_count":len(pops),"samples_truncated":len(pops)>MAX_SAMPLES,"snap_limit_m":snapmax,
            "assumptions":"Projected shared-node segment distances plus bounded straight-line connectors from representative points and the proposed footprint boundary. Entrances, crossings, signals, closures, grade, and actual walkability are not verified.",
            "samples":samples,"routes":routes})
    return out
