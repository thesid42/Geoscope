import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeScenarioSceneData, validateStudyArea, validateBuilding } from './scenario.js';

const area = [-122.433, 37.758, -122.417, 37.776];
const ring = [[-122.4252,37.7669],[-122.4248,37.7669],[-122.4248,37.7671],[-122.4252,37.7671],[-122.4252,37.7669]];
const candidate = { id:'plot-a', longitude:-122.425, latitude:37.767, footprint:{type:'Polygon',coordinates:[ring]} };
const building = { width_m:35,depth_m:22,height_m:12,setback_m:3 };
const dataset = {features:[{id:'plot-a',properties:{layer:'candidate_site'},geometry:{type:'Polygon',coordinates:[ring]}}]};

describe('scenario geometry and bounds', () => {
  it('keeps the supplied footprint ring and height usable for a real Three extrusion', () => {
    const model = makeScenarioSceneData({area,candidate,building,dataset});
    expect(model.buildingFootprint).toHaveLength(5);
    expect(model.plotRings).toHaveLength(1);
    expect(model.buildingHeight).toBe(12);
    const shape = new THREE.Shape(model.buildingFootprint.map(({x,z})=>new THREE.Vector2(x,-z)));
    const geometry = new THREE.ExtrudeGeometry(shape,{depth:model.buildingHeight,bevelEnabled:false});
    geometry.rotateX(-Math.PI/2); geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    expect(size.x).toBeGreaterThan(34); expect(size.x).toBeLessThan(36);
    expect(size.z).toBeGreaterThan(21); expect(size.z).toBeLessThan(23);
    expect(size.y).toBeCloseTo(12,4);
    geometry.dispose();
  });
  it('uses checked footprint coordinates rather than rebuilding from display width', () => {
    const small = makeScenarioSceneData({area,candidate,building,dataset});
    const large = makeScenarioSceneData({area,candidate,building:{...building,width_m:100},dataset});
    expect(large.buildingFootprint).toEqual(small.buildingFootprint);
  });
  it('carries provided plots and obstructions into the scene without invented buildings', () => {
    const source = {features:[...dataset.features,{id:'blocked',properties:{layer:'building'},geometry:{type:'Polygon',coordinates:[ring]}},{id:'restriction',properties:{layer:'restricted'},geometry:{type:'Polygon',coordinates:[ring]}}]};
    const model = makeScenarioSceneData({area,candidate,building,dataset:source});
    expect(model.context.map(item=>item.kind)).toEqual(['plot','building','restricted']);
  });
  it('rejects reversed, nonfinite, tiny and excessively broad study areas', () => {
    expect(validateStudyArea(area)).toBeNull();
    for (const invalid of [[0,0,0,1],[0,0,1,1],[0,0,NaN,1],[0,0,0.000001,0.000001]]) expect(validateStudyArea(invalid)).toBeTruthy();
    expect(validateBuilding(building)).toBeNull();
    expect(validateBuilding({...building,width_m:101})).toBeTruthy();
    expect(validateBuilding({...building,setback_m:-1})).toBeTruthy();
  });
});

it('aligns adjoining street tiles and checked coordinates in one north-up metre frame', async () => {
  const { makeStreetTiles } = await import('./scenario.js');
  const model = makeScenarioSceneData({ area, candidate, building, dataset });
  expect(model.toLocal([candidate.longitude, candidate.latitude])).toEqual({ x: 0, z: -0 });
  expect(model.toLocal([candidate.longitude, candidate.latitude + 0.001]).z).toBeLessThan(0);
  const closeup = makeStreetTiles(model);
  expect(closeup.tiles).toHaveLength(9);
  expect(new Set(closeup.tiles.map((tile) => tile.url)).size).toBe(9);
  expect(closeup.tiles.every((tile) => tile.url.startsWith('https://tile.openstreetmap.org/18/'))).toBe(true);
  const [left, right] = closeup.tiles;
  expect(left.centerX + left.width / 2).toBeCloseTo(right.centerX - right.width / 2, 7);
  expect(closeup.tiles[0].centerZ + closeup.tiles[0].depth / 2).toBeCloseTo(closeup.tiles[3].centerZ - closeup.tiles[3].depth / 2, 7);
  expect(makeStreetTiles(model, 'neighborhood').width).toBeCloseTo(closeup.width * 4, 5);
});

it('retains selected parcel holes beyond context limits and never invents building heights', () => {
  const inner = ring.map(([lon, lat]) => [candidate.longitude + (lon-candidate.longitude)/2, candidate.latitude + (lat-candidate.latitude)/2]);
  const filler = Array.from({ length: 170 }, (_, i) => ({ id: `b-${i}`, properties: { layer:'building' }, geometry:{type:'Polygon',coordinates:[ring]} }));
  const supplied = { features:[...filler, { ...dataset.features[0], geometry:{type:'MultiPolygon',coordinates:[[ring,inner],[ring]]} }] };
  const model = makeScenarioSceneData({area,candidate,building,dataset:supplied});
  expect(model.context.length).toBeLessThanOrEqual(160);
  expect(model.omitted).toBeGreaterThan(0);
  expect(model.plotRings).toHaveLength(2); expect(model.plotRings[0]).toHaveLength(2);
  expect(model.context.every((item) => item.sourceHeight === null)).toBe(true);
  const source = { features:[{...filler[0], properties:{ layer:'building', height_m:14, source:'Provided survey' }}, { ...filler[1], properties:{layer:'building',height_m:20} }] };
  const heights = makeScenarioSceneData({area,candidate,building,dataset:source}).context.map((item)=>item.sourceHeight);
  expect(heights).toEqual([14,null]);
});

it('uses supplied service locations and labels while omitting obscuring population polygons', () => {
  const source = { scenario_status:'MOCK_SIMULATION', features:[
    {...dataset.features[0], properties:{layer:'population'}},
    {id:'clinic-1', properties:{layer:'service',service_type:'clinic',name:'Simulated clinic',scenario_only:true},geometry:{type:'Point',coordinates:[candidate.longitude+.001,candidate.latitude]}},
  ] };
  const model = makeScenarioSceneData({area,candidate,building,dataset:source});
  expect(model.context).toEqual([]); expect(model.services).toHaveLength(1);
  expect(model.services[0]).toMatchObject({name:'Simulated clinic',simulated:true,serviceType:'clinic'});
  expect(model.services[0].point.x).toBeGreaterThan(80);
});

it('does not mark observed services simulated just because the land scenario is a mock', () => {
  const source = {scenario_status:'MOCK_SIMULATION', service_inventory:{source:'City registry'}, features:[
    {id:'observed',properties:{layer:'service',name:'Registry library',service_type:'library',source:'City registry'},geometry:{type:'Point',coordinates:[candidate.longitude,candidate.latitude]}},
    {id:'example',properties:{layer:'service',name:'Example clinic',service_type:'clinic',source:'Simulated clinic record'},geometry:{type:'Point',coordinates:[candidate.longitude,candidate.latitude]}},
  ]};
  const model = makeScenarioSceneData({area,candidate,building,dataset:source});
  expect(model.services.map((service)=>service.simulated)).toEqual([false,true]);
});
