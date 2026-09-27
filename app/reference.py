"""Trusted fixed GIS checks, run in a separate disposable gVisor container."""

REFERENCE_CODE = r'''import json, math
from pyproj import Transformer
from shapely.geometry import shape, Point
from shapely.ops import transform, unary_union

with open('/input/request.json', encoding='utf-8') as f:
    request = json.load(f)
mode = request['analysis_mode']
project = Transformer.from_crs('EPSG:4326', request['projected_crs'], always_xy=True).transform
population = []
services = []
zones = []
invalid = []
for index, feature in enumerate(request['features']):
    geom_data = feature.get('geometry')
    if not geom_data:
        invalid.append(index)
        continue
    geom = shape(geom_data)
    if geom.is_empty or not geom.is_valid:
        invalid.append(index)
        continue
    projected = transform(project, geom)
    properties = feature.get('properties') or {}
    role = 'service' if properties.get('layer') == 'park' else properties.get('layer')
    if role == 'population':
        weight = properties.get('population')
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight < 0:
            invalid.append(index)
            continue
        population.append((feature, projected.representative_point(), float(weight)))
    elif role == 'service':
        services.append(projected)
    elif role == 'zone':
        zones.append(projected)
    elif role not in ("candidate_site", "building", "restricted"):
        invalid.append(index)
if invalid:
    raise ValueError(f'{len(invalid)} invalid geometries or attributes; first feature index: {invalid[0]}')
if not population:
    raise ValueError('At least one valid population feature is required.')
if mode in ('access', 'compare') and not services:
    raise ValueError('Access and comparison modes require at least one service feature.')
if mode == 'exposure' and not zones:
    raise ValueError('Exposure mode requires at least one zone polygon.')
if mode not in ('access', 'compare', 'exposure'):
    raise ValueError('Unsupported analysis mode.')
total = sum(weight for _, _, weight in population)
def count_value(value):
    return int(value) if float(value).is_integer() else float(value)
result = {'mode': mode}
mapped = []
if mode == 'exposure':
    zone_union = unary_union(zones)
    inside = [zone_union.covers(point) for _, point, _ in population]
    for (feature, _, _), value in zip(population, inside):
        row = dict(feature)
        row['properties'] = dict(feature.get('properties') or {})
        row['properties']['inside_zone'] = bool(value)
        mapped.append(row)
    inside_population = sum(weight for is_inside, (_, _, weight) in zip(inside, population) if is_inside)
    result['metrics'] = {
        'analysis_crs': request['projected_crs'], 'population_total': count_value(total),
        'population_features': len(population), 'zone_features': len(zones),
        'inside_population': count_value(inside_population), 'outside_population': count_value(total-inside_population),
        'share_inside_pct': (100.0*inside_population/total if total else None),
        'inside_feature_count': sum(inside),
    }
else:
    threshold = float(request['threshold_m'])
    nearest = [min(point.distance(service) for service in services) for _, point, _ in population]
    for (feature, _, _), distance in zip(population, nearest):
        row = dict(feature)
        row['properties'] = dict(feature.get('properties') or {})
        row['properties']['nearest_m'] = distance
        row['properties']['underserved'] = bool(distance > threshold)
        mapped.append(row)
    served = sum(weight for distance, (_, _, weight) in zip(nearest, population) if distance <= threshold)
    weighted_mean = (sum(d*w for d, (_, _, w) in zip(nearest, population))/total if total else None)
    result['metrics'] = {
        'analysis_crs': request['projected_crs'], 'threshold_m': int(threshold),
        'population_total': count_value(total), 'population_features': len(population),
        'service_features': len(services),
        'baseline': {'served_population': count_value(served), 'underserved_population': count_value(total-served), 'weighted_mean_nearest_m': weighted_mean},
    }
    if mode == 'compare':
        def metrics_for(name):
            coords = request['candidate_'+name]
            point = transform(project, Point(float(coords[0]), float(coords[1])))
            distances = [min(d, point.distance(pop_point)) for d, (_, pop_point, _) in zip(nearest, population)]
            newly = sum(w for old, new, (_, _, w) in zip(nearest, distances, population) if old > threshold and new <= threshold)
            served_after = sum(w for d, (_, _, w) in zip(distances, population) if d <= threshold)
            mean = sum(d*w for d, (_, _, w) in zip(distances, population))/total if total else None
            reduction = (sum((old-new)*w for old,new,(_,_,w) in zip(nearest,distances,population))/total if total else None)
            return {'served_population': count_value(served_after), 'newly_served_population': count_value(newly), 'weighted_mean_nearest_m': mean, 'weighted_mean_distance_reduction_m': reduction}
        a, b = metrics_for('a'), metrics_for('b')
        result['metrics']['candidate_a'] = a
        result['metrics']['candidate_b'] = b
        preferred = 'A' if a['newly_served_population'] > b['newly_served_population'] else ('B' if b['newly_served_population'] > a['newly_served_population'] else 'Tie')
        result['comparison'] = {'preferred_candidate': preferred, 'basis': 'newly served population within the stated straight-line threshold'}
with open('/output/result.json','w',encoding='utf-8') as f:
    json.dump(result,f,allow_nan=False,separators=(',',':'))
with open('/output/result.geojson','w',encoding='utf-8') as f:
    json.dump({'type':'FeatureCollection','features':mapped},f,allow_nan=False,separators=(',',':'))
'''


def reference_code(data):
    if data.get("analysis_mode") == "scenario" and data.get("design"):
        from app.simulation_runtime import reference_script
        return reference_script(data)
    if data.get("analysis_mode") == "scenario":
        from app.scenario_reference import SCENARIO_REFERENCE_CODE
        return SCENARIO_REFERENCE_CODE
    return REFERENCE_CODE
