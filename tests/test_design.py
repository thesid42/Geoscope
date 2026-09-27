import copy
import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError
from pyproj import Transformer
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import transform

from app.scenario import DesignSpec, WalkSpec
from app.simulation_program import context, search_layouts, evaluate_proposals, check_layout, open_reserve
from app.simulation_runtime import bind_proposals, reference_script
from app import sandbox

FWD=Transformer.from_crs("EPSG:4326","EPSG:32610",always_xy=True).transform
INV=Transformer.from_crs("EPSG:32610","EPSG:4326",always_xy=True).transform
X,Y=500000,4180000


def feature(identifier,layer,geom,**props):
    return {"type":"Feature","id":identifier,"geometry":mapping(transform(INV,geom)),"properties":{"layer":layer,**props}}


def request():
    return {"type":"FeatureCollection","analysis_mode":"scenario","projected_crs":"EPSG:32610",
        "study_area":list(transform(INV,box(X-400,Y-400,X+400,Y+400)).bounds),"threshold_m":400,"service_type":"clinic",
        "design":DesignSpec().model_dump(),"walk":WalkSpec().model_dump(),
        "land_inventory":{"source":"Test survey","as_of":"2026-09-27",**{key:"complete_for_candidate_sites" for key in ("building_coverage","road_coverage","restriction_coverage")}},
        "features":[feature("p","population",Point(X,Y),population=120.5),feature("lot","candidate_site",box(X-45,Y-45,X+45,Y+45),land_status="available",allowed_services=["clinic"],source="Test record")]}


def proposal():
    lon,lat=INV(X,Y)
    return {"site_id":"lot","longitude":lon,"latitude":lat,"width_m":20,"depth_m":20,"rotation_deg":0,"floors":3}


def test_agent_search_meets_floor_demand_and_open_goal_and_is_repeatable():
    req=request(); rows=search_layouts(req)
    assert rows and rows==search_layouts(req)
    result,mapped=evaluate_proposals(req,rows)
    candidate=result["metrics"]["candidates"][0]
    assert candidate["design"]["gross_floor_area_m2"]>=900
    assert candidate["building"]["height_m"]==candidate["design"]["floors"]*3.5
    assert candidate["design"]["usable_open_space_pct"]>=40
    assert candidate["access"]["status"]=="unavailable"
    reserve=transform(FWD,shape(candidate["open_space"]))
    footprint=transform(FWD,shape(candidate["footprint"]))
    assert reserve.intersection(footprint).area<1e-6
    assert reserve.is_valid
    assert mapped["features"]==[]


def test_agent_strategy_can_change_floors_without_relaxing_user_goals():
    req=request()
    low=search_layouts(req,"low_rise")[0]
    open_=search_layouts(req,"open_space")[0]
    assert low["floors"]==1
    assert open_["floors"]==3
    for row in (low,open_):
        assert evaluate_proposals(req,[row])[0]["metrics"]["candidates"][0]["design"]["gross_floor_area_m2"]>=900


@pytest.mark.parametrize("mutation",["floor_area","floors","outside","collision","reserve","unknown_plot"])
def test_submitted_design_is_reconstructed_and_rejected_when_infeasible(mutation):
    req=request(); p=proposal()
    if mutation=="floor_area": p.update(width_m=10,depth_m=10)
    elif mutation=="floors": p["floors"]=4
    elif mutation=="outside": p["longitude"]+=.02
    elif mutation=="collision": req["features"].append(feature("b","building",box(X-2,Y-2,X+2,Y+2)))
    elif mutation=="reserve": req["design"].update(min_open_space_pct=85);p.update(width_m=40,depth_m=40)
    elif mutation=="unknown_plot": p["site_id"]="invented"
    with pytest.raises(ValueError): evaluate_proposals(req,[p])


def test_open_space_excludes_obstructions_and_rejects_narrow_fragments():
    req=request();ctx=context(req)
    parcel=box(X,Y,X+100,Y+3)
    raw,reserve=open_reserve(parcel,box(X+10,Y+.5,X+20,Y+2.5),ctx)
    assert raw.area>0 and reserve is None
    req["features"].append(feature("block","restricted",box(X-45,Y-45,X+45,Y)))
    ctx=context(req);f,parcel=ctx["sites"][0]
    raw,reserve=open_reserve(parcel,box(X-5,Y+5,X+5,Y+15),ctx)
    assert raw.area<parcel.area/2
    assert reserve.intersection(ctx["obstruction"]).area==0


def test_open_space_denominator_remains_gross_plot_when_area_is_clipped():
    req=request();req["design"].update(min_open_space_pct=60)
    req["study_area"]=list(transform(INV,box(X-45,Y-45,X,Y+45)).bounds)
    p=proposal();p["longitude"],p["latitude"]=INV(X-23,Y)
    with pytest.raises(ValueError,match="open space"): evaluate_proposals(req,[p])


@pytest.mark.parametrize("patch",[{"floors":True},{"width_m":float("nan")},{"longitude":False},{"geometry":{}},{"site_id":"unknown"}])
def test_worker_proposal_admission_blocks_injection_and_nonfinite_parameters(patch):
    p={**proposal(),**patch}
    with pytest.raises(ValueError): bind_proposals(request(),{"design_proposals":[p],"design_strategy":"balanced"})


def test_worker_uses_original_constraints_and_runs_proposal_then_verifier(monkeypatch):
    req=request(); actual,mapped=evaluate_proposals(req,[proposal()])
    calls=[]
    def execute_once(code,data,**kwargs):
        calls.append((code,data))
        if len(calls)==1:
            return {"result":copy.deepcopy(actual),"artifacts":{"result.geojson":json.dumps(mapped).encode()},"stdout":"agent","stderr":""}
        assert data["design"]==req["design"]
        assert data["features"]==req["features"]
        verified,verified_map=evaluate_proposals(data,data["design_proposals"],data["design_strategy"])
        return {"result":verified,"artifacts":{"result.json":json.dumps(verified).encode(),"result.geojson":json.dumps(verified_map).encode()},"stdout":"verifier","stderr":""}
    monkeypatch.setattr(sandbox,"_execute_once",execute_once)
    output=sandbox.execute("agent program",req)
    assert calls[0][0]=="agent program" and len(calls)==2
    assert "design_proposals" not in req
    assert output["result"]["reference_verified"] is True
    assert output["result"]["verification_kind"]=="submitted_design_recomputed"
    assert output["artifacts"]["result.geojson"]==json.dumps(mapped).encode()


def test_worker_rejects_forged_design_metrics(monkeypatch):
    req=request(); truth,mapped=evaluate_proposals(req,[proposal()]);fake=copy.deepcopy(truth)
    fake["metrics"]["candidates"][0]["design"]["usable_open_space_pct"]=99
    calls=[]
    def once(code,data,**kwargs):
        calls.append(data)
        return {"result":fake if len(calls)==1 else truth,"artifacts":{"result.geojson":json.dumps(mapped).encode()},"stdout":"","stderr":""}
    monkeypatch.setattr(sandbox,"_execute_once",once)
    with pytest.raises(sandbox.SandboxFailure,match="trusted reference"): sandbox.execute("agent",req)


def test_empty_search_is_not_claimed_as_proof_no_layout_exists():
    req=request();result,_=evaluate_proposals(req,[])
    assert result["metrics"]["eligible_sites"]==0
    assert result["metrics"]["site_checks"][0]["status"]=="not_proposed"
    assert "not proof" in result["metrics"]["site_checks"][0]["reason"]


@pytest.mark.parametrize("spec",[{"max_floors":True},{"target_floor_area_m2":float("inf")},{"min_open_space_pct":1},{"unexpected":0}])
def test_api_goal_validation(spec):
    with pytest.raises(ValidationError): DesignSpec(**spec)


def test_reference_bootstrap_compiles_and_does_not_run_generated_code():
    req=request()
    compile(reference_script(req),"inspection","exec")
    bound=bind_proposals(req,{"design_proposals":[proposal()],"design_strategy":"low_rise"})
    code=reference_script(bound)
    compile(code,"verification","exec")
    assert "evaluate_proposals" in code and "search_layouts" not in code


def test_permission_string_is_not_a_declared_allowed_use_list():
    req=request();req["features"][1]["properties"]["allowed_services"]="not clinic"
    assert search_layouts(req)==[]
    with pytest.raises(ValueError,match="land record"): evaluate_proposals(req,[proposal()])


@pytest.mark.parametrize("key",["open_space","routes"])
def test_verifier_checks_new_geometry_at_coordinate_precision(key):
    req=request();truth,_=evaluate_proposals(req,[proposal()])
    if key=="routes":
        truth["metrics"]["candidates"][0]["access"]["routes"]=[{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-122.4,37.7],[-122.401,37.701]]}}]
    fake=copy.deepcopy(truth)
    c=fake["metrics"]["candidates"][0]
    if key=="open_space":c["open_space"]["coordinates"][0][0][0]+=.00001
    else:c["access"]["routes"][0]["geometry"]["coordinates"][0][0]+=.00001
    with pytest.raises(sandbox.SandboxFailure):sandbox._verify_result(fake,truth)


def test_design_agent_flow_binds_goals_and_network_and_keeps_prompt_compact(tmp_path,monkeypatch):
    import asyncio
    import base64
    from dataclasses import replace
    from app import controller
    from app.simulation_program import inspect_design
    req=request(); req["design_proposals"]=[{"injected":True}]
    run={"id":"design-flow", "analysis_mode":"scenario", "question":"Design a compact clinic and keep open space.",
        "dataset_name":"Fixture", "dataset_id":"localdemo", "synthetic":True,"study_area":req["study_area"],
        "service_type":"clinic","building":{"width_m":24,"depth_m":18,"height_m":12,"setback_m":3},
        "design":req["design"],"walk":req["walk"],"logs":[],"attempts":[],"artifacts":{},"status":"queued"}
    monkeypatch.setattr(controller,"settings",replace(controller.settings,data_dir=tmp_path,worker_url="http://worker",worker_token="test",vultr_model_id="test"))
    monkeypatch.setattr(controller,"_walking_snapshot",lambda identifier:None)
    prompts=[];requests=[]
    async def chat(client,instructions,prompt,**kwargs):
        prompts.append((instructions,prompt))
        return ["Plan layouts, verify geometry, compare access.","# generated design program","Verified design summary."][len(prompts)-1]
    async def models(client):return ["test"]
    monkeypatch.setattr(controller,"_chat",chat);monkeypatch.setattr(controller,"_models",models)
    class Response:
        status_code=200
        def __init__(self,payload):self.payload=payload
        def json(self):return self.payload
    class Client:
        def __init__(self,*args,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def post(self,url,**kwargs):
            body=kwargs["json"];data=body["data"];requests.append(data)
            assert "design_proposals" not in data
            assert data["design"]==run["design"] and data["walk"]==run["walk"]
            if url.endswith("/inspect"):return Response({"inspection":inspect_design(data)})
            result,mapped=evaluate_proposals(data,[proposal()])
            result["reference_verified"]=True
            return Response({"result":result,"artifacts":{name:base64.b64encode(json.dumps(value).encode()).decode() for name,value in (("result.json",result),("result.geojson",mapped))},"stdout":"","stderr":"","verified_against_reference":True})
    monkeypatch.setattr(controller.httpx,"AsyncClient",Client)
    asyncio.run(controller._run_agent_inner(run,req,None,None,400,"EPSG:32610"))
    assert run["status"]=="completed",run.get("error")
    assert len(requests)==2 and len(prompts)==3
    assert "search_layouts" in prompts[1][0]
    summary=json.loads(prompts[2][1]);c=summary["result"]["metrics"]["candidates"][0]
    assert "open_space" not in c and "routes" not in c["access"] and "samples" not in c["access"]
    assert "design_proposals" not in summary["result"]
    assert len(prompts[2][1])<16000
    saved=json.loads((tmp_path/"design-flow"/"request.json").read_text())
    assert saved["design"]==run["design"] and "design_proposals" not in saved


def test_reserve_cannot_be_taken_from_disconnected_lot_fragment():
    from shapely.geometry import MultiPolygon
    req=request();ctx=context(req)
    small=box(X-15,Y-15,X+15,Y+15);remote=box(X+100,Y-45,X+190,Y+45)
    footprint=box(X-10,Y-10,X+10,Y+10)
    raw,reserve=open_reserve(MultiPolygon([small,remote]),footprint,ctx)
    assert raw.area<small.area
    assert reserve is not None and reserve.intersection(remote).area==0
