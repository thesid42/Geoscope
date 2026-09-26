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

function polygonComponents(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates ?? []];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates ?? [];
  return [];
}

export function makeScenarioSceneData({ area, candidate, building, dataset }) {
  const [west, south, east, north] = area;
  const centerLat = (south + north) / 2; const centerLon = (west + east) / 2;
  const xScale = 111_320 * Math.cos(centerLat * Math.PI / 180); const yScale = 110_574;
  const toLocal = ([lon, lat]) => ({ x: (lon - centerLon) * xScale, z: -(lat - centerLat) * yScale });
  const width = (east - west) * xScale; const depth = (north - south) * yScale;
  const allFeatures = dataset?.features ?? [];
  const selectedPlot = allFeatures.find((feature) => feature?.properties?.layer === 'candidate_site' && String(feature.id ?? feature.properties?.id) === String(candidate.id)) ?? null;
  const context = [];
  for (const feature of allFeatures.slice(0, 500)) {
    const role = feature?.properties?.layer;
    const kind = role === 'population' ? 'population' : role === 'candidate_site' ? 'plot' : ['building', 'restricted'].includes(role) ? role : null;
    if (!kind || !feature.geometry) continue;
    if (feature.geometry.type === 'Point' && kind === 'population') {
      const [lon, lat] = feature.geometry.coordinates ?? [];
      if (lon >= west && lon <= east && lat >= south && lat <= north) context.push({ kind, point: toLocal([lon, lat]) });
    } else if (['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
      const components = polygonComponents(feature.geometry).map((component) => component.map((ring) => ring.filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(toLocal)).filter((ring) => ring.length >= 4)).filter((component) => component.length > 0);
      for (const rings of components) context.push({ kind, rings });
    }
  }
  if (selectedPlot && !context.some((item) => item.kind === 'plot' && item.rings)) {
    for (const component of polygonComponents(selectedPlot.geometry)) {
      const rings = component.map((ring) => ring.filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(toLocal)).filter((ring) => ring.length >= 4);
      if (rings.length) context.push({ kind: 'plot', rings });
    }
  }
  const footprintRings = polygonComponents(candidate?.footprint)[0] ?? [];
  const buildingFootprint = (footprintRings[0] ?? []).filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(toLocal);
  const plotRings = selectedPlot ? polygonComponents(selectedPlot.geometry).map((component) => component.map((ring) => ring.map(toLocal))) : [];
  return { center: { longitude: centerLon, latitude: centerLat }, width, depth, context, buildingFootprint, plotRings, buildingHeight: Number(building?.height_m) };
}
