import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeScenarioSceneData, makeStreetTiles } from '../scenario.js';

const COLORS = { plot: '#7654a3', restricted: '#b14741', building: '#7f858c', service: '#287c69', population: '#77988f' };
function shapeFor(rings) {
  const shape = new THREE.Shape(rings[0].map(({ x, z }) => new THREE.Vector2(x, -z)));
  for (const ring of rings.slice(1)) shape.holes.push(new THREE.Path(ring.map(({ x, z }) => new THREE.Vector2(x, -z))));
  return shape;
}
function line(scene, points, color, height = 0.35) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(({ x, z }) => new THREE.Vector3(x, height, z)));
  const object = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color })); scene.add(object); return object;
}
function flatPolygon(scene, rings, color, opacity = 0.08) {
  if (!rings?.[0]?.length) return;
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shapeFor(rings)), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false }));
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.24; scene.add(mesh);
  for (const ring of rings) line(scene, ring, color);
}
function extrude(scene, rings, height, color) {
  const geometry = new THREE.ExtrudeGeometry(shapeFor(rings), { depth: height, bevelEnabled: false });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color }));
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.3; scene.add(mesh);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: '#454741' }));
  edges.rotation.copy(mesh.rotation); edges.position.copy(mesh.position); scene.add(edges);
}
function label(scene, textures, text, x, y, z, worldHeight = 5) {
  const canvas = document.createElement('canvas'); const context = canvas.getContext('2d');
  if (!context) return;
  const safeText = String(text).slice(0, 70);
  context.font = '600 21px Arial'; canvas.width = Math.min(900, Math.ceil(context.measureText(safeText).width) + 24); canvas.height = 42;
  context.fillStyle = 'rgba(255,255,255,0.94)'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '600 21px Arial'; context.fillStyle = '#25372e'; context.textBaseline = 'middle'; context.fillText(safeText, 12, 21, canvas.width - 24);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; textures.add(texture);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.position.set(x, y, z); sprite.scale.set(worldHeight * canvas.width / canvas.height, worldHeight, 1); sprite.renderOrder = 10; scene.add(sprite);
}
function disposeObject(object) {
  object.geometry?.dispose?.();
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.dispose?.();
}

export default function ScenarioViewer({ area, candidate, building, serviceType, dataset }) {
  const hostRef = useRef(null); const resetViewRef = useRef(null);
  const [view, setView] = useState('closeup'); const [error, setError] = useState(''); const [tiles, setTiles] = useState({ loaded: 0, failed: 0, total: 9 });
  const model = useMemo(() => makeScenarioSceneData({ area, candidate, building, dataset }), [area, candidate, building, dataset]);
  const dimensions = `${building.width_m} × ${building.depth_m} × ${building.height_m} m`;
  useEffect(() => {
    const host = hostRef.current; if (!host) return undefined;
    let renderer; let controls; let frame; let observer; let dead = false;
    const textures = new Set(); const scene = new THREE.Scene(); scene.background = new THREE.Color('#e8eeeb');
    const basemap = makeStreetTiles(model, view);
    setError(''); setTiles({ loaded: 0, failed: 0, total: basemap.tiles.length });
    const closeDistance = Math.max(Number(building.width_m), Number(building.depth_m), model.buildingHeight, 20) * 3;
    const distance = view === 'neighborhood' ? Math.max(basemap.width, basemap.depth) * 0.55 : closeDistance;
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 20_000);
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); host.replaceChildren(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.46;
      controls.minDistance = 20; controls.maxDistance = Math.max(basemap.width, basemap.depth) * 2;
      resetViewRef.current = () => { controls.target.set(0, model.buildingHeight / 3, 0); camera.position.set(distance * 0.8, distance * 0.9, distance); controls.update(); };
      resetViewRef.current();
      scene.add(new THREE.HemisphereLight('#ffffff', '#879180', 2.5));
      const sun = new THREE.DirectionalLight('#fff9e8', 2); sun.position.set(-100, 200, 80); scene.add(sun);
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(basemap.width, basemap.depth), new THREE.MeshBasicMaterial({ color: '#e2e8e1', side: THREE.DoubleSide }));
      ground.rotation.x = -Math.PI / 2; ground.position.set(basemap.centerX, -0.05, basemap.centerZ); scene.add(ground);
      const grid = new THREE.GridHelper(Math.max(basemap.width, basemap.depth), 20, '#afbbb0', '#d2dad0'); grid.position.y = -0.01; scene.add(grid);
      const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
      // Only the current, bounded view is loaded; normal browser HTTP caching applies.
      for (const tile of basemap.tiles) {
        const pending = loader.load(tile.url, (texture) => {
          if (dead) { texture.dispose(); return; }
          textures.add(texture); texture.colorSpace = THREE.SRGBColorSpace;
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(tile.width, tile.depth), new THREE.MeshBasicMaterial({ map: texture }));
          mesh.rotation.x = -Math.PI / 2; mesh.position.set(tile.centerX, 0.05, tile.centerZ); scene.add(mesh);
          setTiles((current) => ({ ...current, loaded: current.loaded + 1 }));
        }, undefined, () => { if (!dead) setTiles((current) => ({ ...current, failed: current.failed + 1 })); });
        textures.add(pending);
      }
      for (const item of model.context) {
        if (item.rings?.[0]) {
          if (item.kind === 'building' && item.sourceHeight) extrude(scene, item.rings, item.sourceHeight, COLORS.building);
          else flatPolygon(scene, item.rings, COLORS[item.kind] || '#7d918b', item.kind === 'restricted' ? 0.18 : 0.035);
        } else if (item.point) {
          const marker = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 6), new THREE.MeshBasicMaterial({ color: COLORS.population })); marker.position.set(item.point.x, 1.8, item.point.z); scene.add(marker);
        }
      }
      for (const rings of model.plotRings) flatPolygon(scene, rings, '#087f8c', 0.1);
      if (model.buildingFootprint.length >= 4 && model.buildingHeight > 0) extrude(scene, [model.buildingFootprint], model.buildingHeight, '#dc7b36');
      const labelHeight = view === 'neighborhood' ? 20 : 5;
      label(scene, textures, `Proposed ${serviceType.replaceAll('_', ' ')}`, 0, model.buildingHeight + labelHeight * 2, 0, labelHeight);
      for (const service of model.services) {
        const marker = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 8, 10), new THREE.MeshLambertMaterial({ color: COLORS.service })); marker.position.set(service.point.x, 4, service.point.z); scene.add(marker);
        label(scene, textures, `${service.simulated ? 'Simulated' : 'Supplied'} ${service.serviceType}: ${service.name}`, service.point.x, 13, service.point.z, labelHeight);
      }
      const cueOffset = view === 'neighborhood' ? 140 : Math.max(Number(building.width_m), Number(building.depth_m)) + 18;
      const scaleLength = view === 'neighborhood' ? 100 : 20;
      const cueX = -cueOffset; const cueZ = cueOffset;
      line(scene, [{ x: cueX, z: cueZ }, { x: cueX + scaleLength, z: cueZ }], '#203f35', 0.65);
      for (const x of [cueX, cueX + scaleLength]) line(scene, [{ x, z: cueZ - 2 }, { x, z: cueZ + 2 }], '#203f35', 0.65);
      label(scene, textures, `${scaleLength} m · approximate`, cueX + scaleLength / 2, labelHeight, cueZ + 6, labelHeight);
      const north = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(cueX - 12, 1, cueZ), scaleLength * 0.8, '#203f35', 6, 4); scene.add(north);
      label(scene, textures, 'N', cueX - 12, labelHeight, cueZ - scaleLength, labelHeight);
      const bounds = model.areaBounds;
      line(scene, [{ x: bounds.west, z: bounds.north }, { x: bounds.east, z: bounds.north }, { x: bounds.east, z: bounds.south }, { x: bounds.west, z: bounds.south }, { x: bounds.west, z: bounds.north }], '#2867bf');
      const resize = () => { if (!renderer || !host.clientWidth || !host.clientHeight) return; renderer.setSize(host.clientWidth, host.clientHeight, false); camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); };
      observer = new ResizeObserver(resize); observer.observe(host); resize();
      const draw = () => { if (dead) return; controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(draw); };
      frame = requestAnimationFrame(draw);
    } catch {
      setError('3D is unavailable here. The checked map, parcel records, dimensions and rankings remain available.');
    }
    return () => {
      dead = true; resetViewRef.current = null; if (frame) cancelAnimationFrame(frame); observer?.disconnect(); controls?.dispose();
      scene.traverse(disposeObject); for (const texture of textures) texture?.dispose(); renderer?.dispose(); renderer?.forceContextLoss?.(); renderer?.domElement?.remove();
    };
  }, [model, building, candidate.id, serviceType, view]);
  const tileStatus = tiles.loaded + tiles.failed < tiles.total ? 'Loading street map…' : tiles.loaded === 0 ? 'Street map unavailable; supplied geometry remains visible.' : tiles.failed ? 'Some street tiles unavailable; supplied geometry remains visible.' : 'OpenStreetMap street context · independent of supplied land records';
  const name = serviceType.replaceAll('_', ' ');
  return <section className="scenario-viewer" aria-label="Verified 3D footprint preview">
    <div className="scenario-viewer-head"><div><b>PROPOSAL IN ITS NEIGHBORHOOD</b><span>Proposed {name} · {dimensions}</span></div><span>Flat ground · hypothetical building<br />Drag to orbit · scroll to zoom</span></div>
    <div className="scenario-view-controls" role="group" aria-label="3D camera view">
      <button type="button" className="download-link" aria-pressed={view === 'closeup'} onClick={() => setView('closeup')}>Building close-up</button>
      <button type="button" className="download-link" aria-pressed={view === 'neighborhood'} onClick={() => setView('neighborhood')}>Neighborhood context</button>
      <button type="button" className="download-link" onClick={() => resetViewRef.current?.()}>Reset view</button>
    </div>
    <div className="scenario-scene-stage" style={{ position: 'relative' }}>
      <div className="scenario-canvas" ref={hostRef} hidden={Boolean(error)} aria-label="Interactive 3D street map with checked building footprint, selected plot, north and metric scale" />
      {error && <div className="scenario-3d-error" role="status">{error}</div>}
      <div className="scenario-map-credit" style={{ position: 'absolute', right: 8, bottom: 8, background: 'rgba(255,255,255,.95)', padding: '3px 6px', fontSize: 11 }}>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</div>
    </div>
    {!error && <div className="scenario-tile-status" role="status">{tileStatus}</div>}
    <div className="scenario-context-key"><span>Orange: checked proposal</span><span>Teal: selected plot</span><span>Purple: other supplied plots</span><span>Blue: study boundary</span><span>Red: road/restriction exclusions</span><span>Green: supplied services</span><span>Gray: supplied building footprints</span></div>
    <details><summary>Selected parcel record</summary><span>{candidate.id}</span></details>
    <p>Street imagery provides location context, not land availability. {model.simulated ? 'The candidate land records are simulated. ' : 'Candidate land records come from the supplied dataset. '}{model.services.some((service) => service.simulated) ? 'Service markers labelled simulated are mock records; other markers come from the supplied service inventory. ' : 'Service markers come from the supplied inventory, not an inferred complete neighborhood inventory. '}Buildings rise only where a source includes height_m; others remain flat. Context is limited to nearby supplied features; large population fills are omitted to keep streets readable. The proposal uses the checked footprint and requested height on flat ground, with approximate local metre scale. No ownership, planning approval, terrain or real-world feasibility is established.</p>
  </section>;
}
