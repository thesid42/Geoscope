"""Execute the design toolkit and independent verifier in real gVisor containers.

Run on the Linux worker from a checkout: python -m verification.design_sandbox_smoke
This fixed smoke script tests containment/integration, not model inference.
"""
import json
from pathlib import Path
from app.sandbox import execute
from app.simulation_runtime import LOADER

ROOT=Path(__file__).resolve().parents[1]
SCRIPT=LOADER+"""
proposals=toolkit.search_layouts(request,'balanced')
result,mapped=toolkit.evaluate_proposals(request,proposals,'balanced')
with open('/output/result.json','w') as f:json.dump(result,f,allow_nan=False)
with open('/output/result.geojson','w') as f:json.dump(mapped,f,allow_nan=False)
"""


def payload(city):
    if city=='sf':
        path='data/real-scenario/sf-mock.geojson';area=[-122.433,37.758,-122.417,37.776];crs='EPSG:32610'
    else:
        path='data/real-nyc-land/nyc-east-harlem-land.geojson';area=[-73.955,40.790,-73.930,40.812];crs='EPSG:32618'
    request=json.loads((ROOT/path).read_text(encoding='utf-8'))
    request.update(analysis_mode='scenario',service_type='library',study_area=area,projected_crs=crs,threshold_m=400,
        building={'width_m':24,'depth_m':18,'height_m':12,'setback_m':3},
        design={'target_floor_area_m2':900,'max_floors':3,'min_open_space_pct':40,'setback_m':3},
        walk={'minutes':10,'speed_mps':1.2,'max_snap_m':100},
        walk_network=json.loads((ROOT/f'data/walk/{city}.json').read_text(encoding='utf-8')))
    return request


if __name__=='__main__':
    import sys,time
    for city in sys.argv[1:] or ['sf','nyc']:
        started=time.monotonic();output=execute(SCRIPT,payload(city),timeout_seconds=90)
        result=output['result'];assert result['reference_verified']
        candidates=result['metrics']['candidates'];assert candidates
        print(json.dumps({'city':city,'seconds':round(time.monotonic()-started,2),'verification':result['verification_kind'],
            'candidates':[{'id':c['id'],'floors':c['design']['floors'],'open_pct':round(c['design']['usable_open_space_pct'],1),
            'access_status':c['access']['status'],'reason':c['access'].get('reason'),
            'before':c['access']['before_served_population'],'after':c['access']['after_served_population'],
            'compared':c['access']['compared_population']} for c in candidates]}),flush=True)
        assert any(c['access']['status']=='available' and c['access']['compared_population'] for c in candidates)
