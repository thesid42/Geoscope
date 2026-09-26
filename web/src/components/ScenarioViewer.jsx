import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeScenarioSceneData } from '../scenario.js';

function shapeFor(rings) {
  const shape = new THREE.Shape(rings[0].map(({ x, z }) => new THREE.Vector2(x, -z)));
  for (const ring of rings.slice(1)) shape.holes.push(new THREE.Path(ring.map(({ x, z }) => new THREE.Vector2(x, -z))));
  return shape;
}
function addFlatPolygon(scene, rings, color, opacity = 0.4) {
  if (!rings?.[0]?.length) return;
  const geometry = new THREE.ShapeGeometry(shapeFor(rings));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false }));
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.04; scene.add(mesh);
  for (const ring of rings) scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring.map(({ x, z }) => new THREE.Vector3(x, 0.06, z))), new THREE.LineBasicMaterial({ color })));
}
function disposeObject(object) {
  object.geometry?.dispose?.();
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.dispose?.();
}

export default function ScenarioViewer({ area, candidate, building, serviceType, dataset }) {
  const hostRef = useRef(null); const [error, setError] = useState('');
  const dimensions = `${building.width_m} × ${building.depth_m} × ${building.height_m} m`;
  useEffect(() => {
    const host = hostRef.current; if (!host) return undefined;
    let renderer; let controls; let frame; let observer; let dead = false;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#edf2ed');
    const model = makeScenarioSceneData({ area, candidate, building, dataset });
    const focus = model.buildingFootprint.length ? model.buildingFootprint.slice(0, -1).reduce((sum, p, _i, arr) => ({ x: sum.x + p.x / arr.length, z: sum.z + p.z / arr.length }), { x: 0, z: 0 }) : { x: 0, z: 0 };
    const distance = Math.max(Number(building.width_m), Number(building.depth_m), 20) * 11;
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, Math.max(model.width, model.depth) * 20);
    camera.position.set(focus.x + distance * 0.8, distance * 0.9, focus.z + distance); camera.lookAt(focus.x, 0, focus.z);
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); host.replaceChildren(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement); controls.target.set(focus.x, 0, focus.z); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.48;
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(model.width, model.depth), new THREE.MeshBasicMaterial({ color: '#e4ebe4', side: THREE.DoubleSide }));
      ground.rotation.x = -Math.PI / 2; scene.add(ground);
      const grid = new THREE.GridHelper(Math.max(model.width, model.depth), 12, '#c2cec4', '#d5ded6'); grid.position.y = 0.02; scene.add(grid);
      for (const item of model.context) {
        if (item.rings?.[0]) addFlatPolygon(scene, item.rings, item.kind === 'plot' ? '#8069a2' : item.kind === 'restricted' ? '#b45146' : item.kind === 'building' ? '#887b70' : '#77988f', item.kind === 'plot' ? 0.14 : 0.4);
        else if (item.point) { const marker = new THREE.Mesh(new THREE.SphereGeometry(1.5, 10, 8), new THREE.MeshBasicMaterial({ color: '#739a91' })); marker.position.set(item.point.x, 1.2, item.point.z); scene.add(marker); }
      }
      for (const rings of model.plotRings) addFlatPolygon(scene, rings, '#604d82', 0.2);
      if (model.buildingFootprint.length >= 4 && model.buildingHeight > 0) {
        const geometry = new THREE.ExtrudeGeometry(shapeFor([model.buildingFootprint]), { depth: model.buildingHeight, bevelEnabled: false });
        const massing = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#d77c42' }));
        massing.rotation.x = -Math.PI / 2; massing.position.y = 0.12; scene.add(massing);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: '#70452e' })); edges.rotation.x = -Math.PI / 2; edges.position.y = 0.12; scene.add(edges);
      }
      const resize = () => { if (!renderer || !host.clientWidth || !host.clientHeight) return; renderer.setSize(host.clientWidth, host.clientHeight, false); camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); };
      observer = new ResizeObserver(resize); observer.observe(host); resize();
      const draw = () => { if (dead) return; controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(draw); };
      frame = requestAnimationFrame(draw); setError('');
    } catch {
      setError('3D preview is unavailable in this environment. The verified map, land checks, and rankings remain available above.');
    }
    return () => { dead = true; if (frame) cancelAnimationFrame(frame); observer?.disconnect(); controls?.dispose(); scene.traverse(disposeObject); renderer?.dispose(); renderer?.domElement?.remove(); };
  }, [area, candidate, building, dataset]);
  const name = ({ clinic: 'clinic', library: 'library', school: 'school', community_center: 'community center' })[serviceType] ?? 'community facility';
  return <section className="scenario-viewer" aria-label="Verified 3D footprint preview">
    <div className="scenario-viewer-head"><div><b>SUPPLIED PLOT · VERIFIED FOOTPRINT</b><span>{name} massing · {dimensions}</span></div><span>Flat ground · hypothetical building</span></div>
    {error ? <div className="scenario-3d-error" role="status">{error}</div> : <div className="scenario-canvas" ref={hostRef} aria-label="Interactive 3D view of verified footprint in its supplied plot" />}
    <p>Orange is the verified footprint on the supplied plot; context is simplified to at most 500 supplied features. Buildings and restrictions are shown with polygon holes preserved. Plot and obstruction checks use simulated records and provide no actual San Francisco availability evidence, ownership, zoning approval, or permits.</p>
  </section>;
}
