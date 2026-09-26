"""Independent fixtures for fixed GIS code; runc execution is not a containment test."""
import json
import math
import sys
from pathlib import Path
sys.path.insert(0, '/source')
from app.reference import REFERENCE_CODE
from pyproj import Transformer

inverse = Transformer.from_crs('EPSG:32610', 'EPSG:4326', always_xy=True)
def xy(x, y=0):
    return list(inverse.transform(500000 + x, 4200000 + y))

def feature(identifier, layer, x, population=None):
    properties = {'layer': layer}
    if population is not None:
        properties['population'] = population
    return {'type': 'Feature', 'id': identifier, 'properties': properties,
            'geometry': {'type': 'Point', 'coordinates': xy(x)}}

def zone(identifier, lo, hi):
    ring = [xy(lo, -10), xy(hi, -10), xy(hi, 10), xy(lo, 10), xy(lo, -10)]
    return {'type': 'Feature', 'id': identifier, 'properties': {'layer': 'zone'},
            'geometry': {'type': 'Polygon', 'coordinates': [ring]}}

def run(request):
    Path('/input/request.json').write_text(json.dumps(request))
    exec(compile(REFERENCE_CODE, 'fixed-reference', 'exec'), {})
    return json.loads(Path('/output/result.json').read_text())

base = {'type': 'FeatureCollection', 'projected_crs': 'EPSG:32610',
        'threshold_m': 500, 'candidate_a': xy(600), 'candidate_b': xy(1400),
        'features': [feature('p0', 'population', 0, 100),
                     feature('p1', 'population', 600, 200),
                     feature('p2', 'population', 1400, 300),
                     feature('s0', 'service', 0)]}

access = run({**base, 'analysis_mode': 'access'})['metrics']
assert access['baseline']['served_population'] == 100, access
assert access['baseline']['underserved_population'] == 500, access
assert math.isclose(access['baseline']['weighted_mean_nearest_m'], 900, abs_tol=.001), access
compare = run({**base, 'analysis_mode': 'compare'})
assert compare['metrics']['candidate_a']['newly_served_population'] == 200, compare
assert compare['metrics']['candidate_b']['newly_served_population'] == 300, compare
assert math.isclose(compare['metrics']['candidate_b']['weighted_mean_nearest_m'], 200, abs_tol=.001), compare
assert compare['comparison']['preferred_candidate'] == 'B', compare
exposure = run({**base, 'analysis_mode': 'exposure',
                'features': base['features'][:3] + [zone('z1', -10, 700), zone('z2', 500, 800)]})['metrics']
assert exposure['inside_population'] == 300, exposure
assert exposure['outside_population'] == 300, exposure
assert exposure['share_inside_pct'] == 50, exposure
zero = json.loads(json.dumps(base))
for f in zero['features']:
    if f['properties']['layer'] == 'population':
        f['properties']['population'] = 0
assert run({**zero, 'analysis_mode': 'access'})['metrics']['baseline']['weighted_mean_nearest_m'] is None
print(json.dumps({'fixed_reference': 'passed', 'cases': ['known-distance access', 'candidate ranking', 'overlapping-zone union', 'zero-population mean'], 'runtime': 'runc; not containment verification'}))
