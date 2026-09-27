const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees) => degrees * Math.PI / 180;

export function distanceMeters(a, b) {
  const lat1 = radians(a[1]); const lat2 = radians(b[1]);
  const dLat = lat2 - lat1; const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function validateStudyArea(area) {
  if (!Array.isArray(area) || area.length !== 4 || !area.every((n) => typeof n === 'number' && Number.isFinite(n))) return 'Enter four finite coordinates: west, south, east, north.';
  const [west, south, east, north] = area;
  if (west < -180 || east > 180 || south < -80 || north > 84 || (south < 0 && north > 0) || west >= east || south >= north) return 'Study area bounds must form a valid EPSG:4326 rectangle.';
  const width = distanceMeters([west, (south + north) / 2], [east, (south + north) / 2]);
  const height = distanceMeters([(west + east) / 2, south], [(west + east) / 2, north]);
  if (Math.min(width, height) < 20) return 'Each study area side must be at least 20 meters.';
  if (Math.max(width, height) > 10_000) return 'Study area sides must be no longer than 10 kilometers.';
  return null;
}

export function validateBuilding(building) {
  for (const [key, min, max, label] of [['width_m', 5, 100, 'Width'], ['depth_m', 5, 100, 'Depth'], ['height_m', 3, 80, 'Height'], ['setback_m', 0, 20, 'Setback']]) {
    const value = Number(building?.[key]);
    if (!Number.isFinite(value) || value < min || value > max) return `${label} must be between ${min} and ${max} meters.`;
  }
  return null;
}

const readableNumber = (value, digits = 0) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString(undefined, { maximumFractionDigits: digits })
  : 'N/A';

export function explainScenarioCandidate(candidate, candidates, metrics) {
  if (!candidate) return [];
  const ranked = Array.isArray(candidates) ? candidates : [];
  const rank = Math.max(0, ranked.findIndex((item) => item.id === candidate.id));
  const building = metrics?.building ?? {};
  const check = candidate.land_check ?? {};
  const facility = ({ clinic: 'clinic', library: 'library', school: 'school', community_center: 'community center' })[metrics?.service_type] || 'facility';
  const noInventory = metrics?.inventory_status === 'no matching service inventory supplied';
  const area = Number(candidate.plot_area_m2);
  const distance = Number(candidate.nearest_existing_service_m);
  const reasons = [];

  if ([building.width_m, building.depth_m, check.setback_m].every((value) => Number.isFinite(Number(value)))) {
    reasons.push(`The verified ${readableNumber(building.width_m)} × ${readableNumber(building.depth_m)} m footprint and ${readableNumber(check.setback_m, 1)} m setback fit inside the supplied plot and study area.`);
  } else {
    reasons.push('The requested footprint and setback passed the supplied plot and study-area fit checks.');
  }
  if (check.no_building_overlap === true && check.no_road_overlap === true && check.no_restriction_overlap === true) {
    reasons.push('The checked placement does not overlap a supplied building, mapped road corridor, or other restriction.');
  }
  if (Number.isFinite(area)) {
    reasons.push(`The supplied plot area is ${readableNumber(area)} m².`);
  }
  if (noInventory) {
    reasons.push(`No mapped ${facility} records were supplied, so ranking uses plot area only.`);
  } else if (Number.isFinite(distance)) {
    reasons.push(`The supplied plot is ${readableNumber(distance)} m from the nearest mapped ${facility}.`);
  }

  const previous = rank > 0 ? ranked[rank - 1] : null;
  const sameGap = (left, right) => {
    const first = left?.nearest_existing_service_m;
    const second = right?.nearest_existing_service_m;
    if (first == null && second == null) return true;
    return Number(first) === Number(second);
  };
  const tiedGap = ranked.filter((item) => sameGap(item, candidate));
  const tiedArea = ranked.filter((item) => sameGap(item, candidate) && Number(item.plot_area_m2) === area);
  if (rank === 0) {
    if (noInventory || candidate.nearest_existing_service_m == null) {
      if (tiedArea.length > 1) reasons.push('It ranks first among equal-area sites because of the plot ID tie-break.');
      else reasons.push('It ranks first because it has the largest plot area among eligible sites.');
    } else if (tiedGap.length > 1 && Number.isFinite(area)) {
      reasons.push(`It ranks first among sites with the same service gap because its plot area is larger (${readableNumber(area)} m²).`);
    } else {
      reasons.push(`It ranks first because it is farthest from an existing mapped ${facility} among eligible sites.`);
    }
  } else if (previous) {
    const previousDistance = Number(previous.nearest_existing_service_m);
    const previousArea = Number(previous.plot_area_m2);
    if (!noInventory && Number.isFinite(previousDistance) && Number.isFinite(distance) && previousDistance > distance) {
      reasons.push(`It ranks below Site ${rank} because that site is farther from an existing mapped ${facility} (${readableNumber(previousDistance)} m versus ${readableNumber(distance)} m).`);
    } else if (Number.isFinite(previousArea) && Number.isFinite(area) && previousArea > area) {
      reasons.push(`It ties Site ${rank} on service gap but ranks after it because that plot is larger (${readableNumber(previousArea)} m² versus ${readableNumber(area)} m²).`);
    } else {
      reasons.push(`It ties Site ${rank} on service gap and plot area, so the plot ID provides the deterministic tie-break.`);
    }
  }
  return reasons;
}

const MERCATOR_RADIUS = 6_378_137;
const MERCATOR_LIMIT = 85.05112878;
const MAX_CONTEXT_FEATURES = 160;
const MAX_CONTEXT_POSITIONS = 20_000;
const mercatorY = (latitude) => MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + radians(Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, latitude))) / 2));
function polygonComponents(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates ?? []];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates ?? [];
  return [];
}
const finitePosition = (point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);

// All geometry and tiles share this local, uniformly scaled Web Mercator frame.
// GIS calculations remain in the independently checked analysis CRS.
export function makeScenarioSceneData({ area, candidate, building, dataset }) {
  const [west, south, east, north] = area;
  const centerLon = Number(candidate.longitude); const centerLat = Number(candidate.latitude);
  const scale = Math.cos(radians(centerLat)); const originY = mercatorY(centerLat);
  const toLocal = ([lon, lat]) => ({ x: MERCATOR_RADIUS * radians(lon - centerLon) * scale, z: -(mercatorY(lat) - originY) * scale });
  const nw = toLocal([west, north]); const se = toLocal([east, south]);
  const allFeatures = dataset?.features ?? [];
  const selectedPlot = allFeatures.find((f) => f?.properties?.layer === 'candidate_site' && String(f.id) === String(candidate.id));
  const convert = (geometry) => polygonComponents(geometry).map((component) => component.map((ring) => ring.filter(finitePosition).map(toLocal)).filter((ring) => ring.length >= 4)).filter((component) => component.length > 0);
  const context = []; const services = []; let positionCount = 0; let featureCount = 0; let omitted = 0;
  for (const feature of allFeatures) {
    const props = feature?.properties ?? {}; const role = props.layer;
    const kind = role === 'candidate_site' ? 'plot' : role === 'park' ? 'service' : role;
    if (!['population', 'service', 'plot', 'building', 'restricted'].includes(kind) || !feature.geometry) continue;
    const components = polygonComponents(feature.geometry);
    const first = feature.geometry.type === 'Point' ? feature.geometry.coordinates : components[0]?.[0]?.[0];
    if (!finitePosition(first)) continue;
    const point = toLocal(first);
    const positions = components.reduce((total, component) => total + component.reduce((count, ring) => count + ring.length, 0), 0);
    // Only nearby source features are rendered. The selected parcel is retained separately.
    const near = Math.abs(point.x) <= 1500 && Math.abs(point.z) <= 1500;
    if (!near) continue;
    const name = String(props.name || feature.id || props.service_type || kind).slice(0, 80);
    const simulated = props.scenario_only === true || (typeof props.source === 'string' && /\b(simulated|mock|synthetic)\b/i.test(props.source));
    if (kind === 'service' && services.length < 12) services.push({ point, name, simulated, serviceType: props.service_type || (role === 'park' ? 'park' : 'service') });
    // Large population fills would obscure the street map; their counts stay in the analysis panel.
    if (kind === 'population' && components.length) continue;
    if (featureCount >= MAX_CONTEXT_FEATURES || positionCount + positions > MAX_CONTEXT_POSITIONS) { omitted++; continue; }
    featureCount++; positionCount += positions;
    const sourceHeight = typeof props.height_m === 'number' && Number.isFinite(props.height_m) && props.height_m > 0 && props.height_m <= 150 && typeof props.source === 'string' && props.source.trim() ? props.height_m : null;
    if (components.length) {
      for (const rings of convert(feature.geometry)) context.push({ kind, rings, name, simulated, sourceHeight });
    } else if (kind === 'population') context.push({ kind, point, name });
  }
  const buildingFootprint = (polygonComponents(candidate.footprint)[0]?.[0] ?? []).filter(finitePosition).map(toLocal);
  return {
    center: { longitude: centerLon, latitude: centerLat }, toLocal,
    width: se.x - nw.x, depth: se.z - nw.z, areaBounds: { west: nw.x, north: nw.z, east: se.x, south: se.z },
    context, services, omitted, buildingFootprint, plotRings: selectedPlot ? convert(selectedPlot.geometry) : [],
    buildingHeight: Number(building.height_m), simulated: dataset?.scenario_status === 'MOCK_SIMULATION' || selectedPlot?.properties?.scenario_only === true,
    serviceInventory: dataset?.service_inventory ?? null,
  };
}

export function makeStreetTiles(model, view = 'closeup') {
  const zoom = view === 'neighborhood' ? 16 : 18;
  const count = 2 ** zoom;
  const { longitude, latitude } = model.center;
  const centerX = Math.floor((longitude + 180) / 360 * count);
  const latRad = radians(Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, latitude)));
  const centerY = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * count);
  const lon = (x) => x / count * 360 - 180;
  const lat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / count))) * 180 / Math.PI;
  const tiles = [];
  for (let y = Math.max(0, centerY - 1); y <= Math.min(count - 1, centerY + 1); y++) {
    for (let x = Math.max(0, centerX - 1); x <= Math.min(count - 1, centerX + 1); x++) {
      const nw = model.toLocal([lon(x), lat(y)]); const se = model.toLocal([lon(x + 1), lat(y + 1)]);
      tiles.push({ x, y, zoom, url: `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`, width: se.x - nw.x, depth: se.z - nw.z, centerX: (nw.x + se.x) / 2, centerZ: (nw.z + se.z) / 2 });
    }
  }
  const west = Math.min(...tiles.map((tile) => tile.centerX - tile.width / 2)); const east = Math.max(...tiles.map((tile) => tile.centerX + tile.width / 2));
  const north = Math.min(...tiles.map((tile) => tile.centerZ - tile.depth / 2)); const south = Math.max(...tiles.map((tile) => tile.centerZ + tile.depth / 2));
  return { tiles, zoom, width: east - west, depth: south - north, centerX: (west + east) / 2, centerZ: (north + south) / 2 };
}
