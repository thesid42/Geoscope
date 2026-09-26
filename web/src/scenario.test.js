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
