import { useEffect, useRef } from 'react';
import L from 'leaflet';

const roleOf = (feature) => feature?.properties?.layer === 'park' ? 'service' : feature?.properties?.layer;
function styleFor(feature) {
  const role = roleOf(feature);
  if (role === 'zone') return { color: '#c08046', weight: 1.4, fillColor: '#e5ad71', fillOpacity: 0.25 };
  if (role === 'service') return { color: '#559365', weight: 1.2, fillColor: '#83b88b', fillOpacity: 0.65 };
  if (role === 'candidate_site') return { color: '#725d94', weight: 1.8, fillColor: '#aa96c4', fillOpacity: 0.28 };
  if (role === 'building') return { color: '#596675', weight: 1.5, fillColor: '#8894a0', fillOpacity: 0.55 };
  if (role === 'restricted') return { color: '#b94245', weight: 2, fillColor: '#e69494', fillOpacity: 0.25, dashArray: '3 3' };
  return { color: '#789d98', weight: 0.7, fillColor: '#a7c8bf', fillOpacity: 0.06 };
}
function pointStyle(feature) {
  const service = roleOf(feature) === 'service';
  return { radius: 6, color: service ? '#559365' : '#648d83', weight: 1, fillOpacity: 0.55, fillColor: service ? '#83b88b' : '#a7c8bf' };
}
function popupNode(feature) {
  const props = feature?.properties ?? {};
  const root = document.createElement('div'); root.className = 'tract-popup';
  const name = document.createElement('b'); name.textContent = props.name || props.geoid || props.id || 'Feature';
  const detail = document.createElement('span'); const role = roleOf(feature);
  const extras = [props.borough, props.service_type && String(props.service_type).replaceAll('_', ' '), props.property_type, props.acres != null && `${Number(props.acres).toLocaleString()} acres`].filter(Boolean);
  detail.textContent = role === 'population'
    ? ` · ${Number(props.population || 0).toLocaleString()} population estimate${props.borough ? ` · ${props.borough}` : ''}`
    : ` · ${[role || 'Feature', ...extras].join(' · ')}`;
  root.append(name, document.createElement('br'), detail);
  return root;
}
function candidateIcon(label, selected) {
  const root = document.createElement('div');
  root.className = `scenario-candidate-marker${selected ? ' selected' : ''}`;
  root.textContent = label;
  return L.divIcon({ className: '', html: root.outerHTML, iconSize: [29, 29], iconAnchor: [14, 14] });
}

/** Known dataset extents [southWest, northEast] in lat/lng order for Leaflet.fitBounds. */
const DATASET_BOUNDS = {
  sf2020: [[37.70, -122.53], [37.83, -122.35]],
  localdemo: [[37.755, -122.438], [37.780, -122.412]],
  nycland: [[40.790, -73.955], [40.812, -73.930]],
  nyc2020: [[40.49, -74.26], [40.92, -73.70]],
};

/** Label every plot only when the inventory is small; otherwise keep the map readable. */
const PLOT_LABEL_ALL_MAX = 12;
/** When decluttering, keep permanent labels for the selected site plus this many top ranks. */
const PLOT_LABEL_TOP_RANKS = 8;

function shouldShowPermanentPlotLabel({ selected, item, plotCount, hasResults }) {
  if (selected) return true;
  if (item && Number.isFinite(Number(item.rank)) && Number(item.rank) <= PLOT_LABEL_TOP_RANKS) return true;
  // Small pre-run inventories (e.g. SF mock) keep lettered labels; dense extracts do not.
  if (!hasResults && plotCount <= PLOT_LABEL_ALL_MAX) return true;
  return false;
}

function boundsFromStudyArea(area) {
  if (!area?.length || area.length !== 4 || !area.every(Number.isFinite)) return null;
  const [west, south, east, north] = area;
  if (!(west < east && south < north)) return null;
  return L.latLngBounds([[south, west], [north, east]]);
}

function resolveViewBounds({ datasetId, layer, scenarioArea, mode }) {
  if (['scenario', 'exposure'].includes(mode)) {
    const study = boundsFromStudyArea(scenarioArea);
    if (study) return study;
  }
  if (DATASET_BOUNDS[datasetId]) return L.latLngBounds(DATASET_BOUNDS[datasetId]);
  const layerBounds = layer?.getBounds?.();
  if (layerBounds?.isValid?.()) return layerBounds.pad(0.08);
  return null;
}

function applyMapBounds(map, bounds, options = { padding: [35, 35], maxZoom: 16 }) {
  if (!map || !bounds) return;
  map.invalidateSize({ animate: false });
  map.fitBounds(bounds, { animate: false, ...options });
}

export default function LeafletMap({ data, datasetId, resultData, mode, candidateA, candidateB, onCandidateChange, scenarioArea, scenarioCandidates, selectedCandidateId, onScenarioAreaSelected, areaSelectionActive, onSelectScenarioCandidate, scenarioSiteChecks, interactionsLocked = false, scenarioView = 'after' }) {
  const elementRef = useRef(null); const mapRef = useRef(null);
  const sourceLayerRef = useRef(null); const resultLayerRef = useRef(null); const candidateLayersRef = useRef([]);
  const scenarioLayersRef = useRef([]); const areaLayerRef = useRef(null); const clicksRef = useRef([]);
  const viewBoundsRef = useRef(null);
  const fittedDatasetRef = useRef(null);

  useEffect(() => {
    const map = L.map(elementRef.current, { zoomControl: false }).setView([37.764, -122.44], 12);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    mapRef.current = map;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
      if (viewBoundsRef.current) map.fitBounds(viewBoundsRef.current, { animate: false, padding: [35, 35], maxZoom: 16 });
    });
    resize?.observe(elementRef.current);
    return () => { resize?.disconnect(); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current; if (!map) return undefined;
    if (sourceLayerRef.current) map.removeLayer(sourceLayerRef.current);
    sourceLayerRef.current = null;
    if (!data?.features) return undefined;
    const visible = { type: 'FeatureCollection', features: data.features.filter((f) => {
      if (roleOf(f) !== 'population') return true;
      if (mode === 'scenario') return false;
      return Number(f.properties?.population) > 0;
    }) };
    const layer = L.geoJSON(visible, { style: (feature) => roleOf(feature) === 'candidate_site' ? { ...styleFor(feature), opacity: 0, fillOpacity: 0 } : styleFor(feature), pointToLayer: (feature, latlng) => L.circleMarker(latlng, pointStyle(feature)), onEachFeature: (feature, child) => child.bindPopup(popupNode(feature)) }).addTo(map);
    sourceLayerRef.current = layer;

    const datasetChanged = fittedDatasetRef.current !== datasetId;
    const bounds = resolveViewBounds({ datasetId, layer, scenarioArea, mode });
    if (bounds && (datasetChanged || !viewBoundsRef.current)) {
      viewBoundsRef.current = bounds;
      fittedDatasetRef.current = datasetId;
      applyMapBounds(map, bounds);
    }
    return undefined;
  }, [data, datasetId, mode, scenarioArea]);

  useEffect(() => {
    const map = mapRef.current; if (!map) return undefined;
    candidateLayersRef.current.forEach((layer) => map.removeLayer(layer)); candidateLayersRef.current = [];
    if (mode !== 'compare') return undefined;
    for (const [index, letter, kind, position] of [[0, 'A', 'a', candidateA], [1, 'B', 'b', candidateB]]) {
      const longitude = Number(position?.[0]); const latitude = Number(position?.[1]);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
      const marker = L.marker([latitude, longitude], { icon: candidateIcon(letter, false), draggable: !interactionsLocked }).addTo(map).bindTooltip(`Candidate ${letter} · illustrative; drag to adjust`);
      marker.on('dragend', (event) => { if (interactionsLocked) return; const point = event.target.getLatLng(); onCandidateChange(letter, [Number(point.lng.toFixed(5)), Number(point.lat.toFixed(5))]); });
      candidateLayersRef.current[index] = marker;
    }
    return undefined;
  }, [mode, candidateA, candidateB, onCandidateChange, interactionsLocked]);

  useEffect(() => {
    const map = mapRef.current; if (!map) return undefined;
    scenarioLayersRef.current.forEach((layer) => map.removeLayer(layer)); scenarioLayersRef.current = [];
    const candidates = scenarioCandidates ?? [];
    const plots = (data?.features ?? []).filter((f) => roleOf(f) === 'candidate_site');
    if (mode === 'scenario') {
      const plotCount = plots.length;
      const hasResults = candidates.length > 0;
      const labelAllPlots = !hasResults && plotCount <= PLOT_LABEL_ALL_MAX;
      for (const [index, feature] of plots.entries()) {
        const id = String(feature.id ?? feature.properties?.id);
        const item = candidates.find((candidate) => String(candidate.id) === id);
        const check = scenarioSiteChecks?.find((site) => String(site.id) === id);
        const selected = id === String(selectedCandidateId);
        const letter = index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
        const label = item
          ? `Site ${item.rank}`
          : labelAllPlots
            ? `Plot ${letter}${check?.status === 'excluded' ? ' · excluded' : check?.status === 'eligible' ? ' · fits' : ''}`
            : check?.status === 'excluded'
              ? 'Excluded plot'
              : check?.status === 'eligible'
                ? 'Eligible plot'
                : 'Candidate plot';
        const permanent = shouldShowPermanentPlotLabel({ selected, item, plotCount, hasResults });
        const outline = L.geoJSON(feature, {
          style: {
            color: selected ? '#087f8c' : check?.status === 'excluded' ? '#8a8585' : '#7654a3',
            weight: selected ? 4 : permanent ? 2 : 1.2,
            fillColor: selected ? '#4ec7c8' : '#b29ad0',
            fillOpacity: selected ? 0.28 : permanent ? 0.12 : 0.06,
            dashArray: check && !item ? '4 4' : null,
          },
          onEachFeature: (_f, child) => {
            const root = popupNode(feature);
            const status = document.createElement('p');
            status.textContent = item
              ? `${label} · fit checked. Select this site to see its building and estimated coverage.`
              : check
                ? `${label} · ${check.status}: ${check.reason}`
                : `${label} · candidate land plot. Run the analysis to check fit.`;
            root.append(status); child.bindPopup(root);
            if (item) child.on('click', () => { if (!areaSelectionActive) onSelectScenarioCandidate?.(item); });
          },
        }).addTo(map);
        scenarioLayersRef.current.push(outline);
        const bounds = outline.getBounds();
        if (!bounds.isValid()) continue;
        const labelNode = document.createElement('span');
        labelNode.textContent = `${selected ? 'Selected · ' : ''}${label}`;
        outline.bindTooltip(labelNode, {
          permanent,
          direction: 'top',
          className: `plot-label${selected ? ' selected' : permanent ? '' : ' hover-only'}`,
          interactive: false,
          opacity: selected ? 1 : permanent ? 0.95 : 0.9,
        });
      }
      for (const item of candidates) {
        if (!Number.isFinite(Number(item.longitude)) || !Number.isFinite(Number(item.latitude))) continue;
        const selected = String(item.id) === String(selectedCandidateId);
        const marker = L.marker([Number(item.latitude), Number(item.longitude)], { icon: candidateIcon(String(item.rank ?? ''), selected), bubblingMouseEvents: true, zIndexOffset: selected ? 900 : 500 }).addTo(map);
        const tooltip = document.createElement('span'); tooltip.textContent = `${selected ? 'Selected · ' : ''}Site ${item.rank} · ${item.id} · plot fit checked`;
        marker.bindTooltip(tooltip);
        marker.on('click', () => { if (!areaSelectionActive) onSelectScenarioCandidate?.(item); });
        scenarioLayersRef.current.push(marker);
        if (item.footprint && (!item.design || (scenarioView === 'after' && selected))) {
          const footprint = L.geoJSON({ type: 'Feature', properties: {}, geometry: item.footprint }, { style: { color: '#b85318', weight: selected ? 3 : 1.5, fillColor: '#f39b48', fillOpacity: selected ? 0.8 : 0.4 } }).addTo(map);
          const node = document.createElement('span'); node.textContent = `Site ${item.rank} · proposed building footprint`;
          footprint.bindTooltip(node);
          footprint.on('click', () => { if (!areaSelectionActive) onSelectScenarioCandidate?.(item); });
          scenarioLayersRef.current.push(footprint);
        }
        if (item.open_space && item.design && scenarioView === 'after' && selected) {
          const reserve = L.geoJSON({ type: 'Feature', properties: {}, geometry: item.open_space }, { style: { color: '#397548', weight: selected ? 2.5 : 1.5, fillColor: '#78ae70', fillOpacity: 0.52 } }).addTo(map);
          reserve.bindTooltip(`Site ${item.rank} · reserved open space`);
          reserve.on('click', () => { if (!areaSelectionActive) onSelectScenarioCandidate?.(item); });
          scenarioLayersRef.current.push(reserve);
        }
      }
      const selected = candidates.find((item) => String(item.id) === String(selectedCandidateId));
      const access = selected?.access;
      if (access && selected.design) {
        const limit = Number(access.minutes);
        for (const sample of access.samples ?? []) {
          const longitude = Number(sample.longitude); const latitude = Number(sample.latitude);
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
          const minutes = sample[scenarioView === 'before' ? 'before_minutes' : 'after_minutes'];
          const known = minutes != null && Number.isFinite(Number(minutes)) && !(scenarioView === 'before' && access.baseline_known === false);
          const served = known && Number(minutes) <= limit;
          const color = !known ? '#737c81' : served ? '#25834b' : '#c8614c';
          const population = sample.population == null ? 'Population weight unavailable' : `Estimated population weight: ${Number(sample.population).toLocaleString()}`;
          const outcome = !known ? `${scenarioView === 'before' ? 'Before' : 'After'} access unknown` : served ? `${scenarioView === 'before' ? 'Before' : 'After'}: ${Number(minutes).toFixed(1)} min walk` : `${scenarioView === 'before' ? 'Before' : 'After'}: beyond ${limit} min`;
          const marker = L.circleMarker([latitude, longitude], { radius: 6, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 0.92 }).addTo(map);
          marker.bindTooltip(`${population} · ${outcome}`);
          scenarioLayersRef.current.push(marker);
        }
        const routes = (access.routes ?? []).filter((route) => { const phase = route?.properties?.phase; return !phase || phase === scenarioView; });
        if (routes.length) {
          const routeLayer = L.geoJSON({ type: 'FeatureCollection', features: routes }, { style: (feature) => ({ color: feature.properties?.phase === 'before' ? '#39788a' : '#188456', weight: 3.5, opacity: 0.9 }) }).addTo(map);
          routeLayer.eachLayer((layer) => layer.bindTooltip(layer.feature?.properties?.phase === 'before' ? 'Estimated walking route before' : 'Estimated walking route after'));
          scenarioLayersRef.current.push(routeLayer);
        }
      }
    }
    if (areaLayerRef.current) map.removeLayer(areaLayerRef.current);
    areaLayerRef.current = null;
    if (scenarioArea?.length === 4 && scenarioArea.every(Number.isFinite)) {
      const [west, south, east, north] = scenarioArea;
      areaLayerRef.current = L.rectangle([[south, west], [north, east]], { color: '#2867bf', weight: 2, fillOpacity: 0, dashArray: '8 6', interactive: false }).addTo(map);
      const label = document.createElement('span'); label.textContent = mode === 'exposure' ? 'Population count boundary' : 'Study area boundary';
      areaLayerRef.current.bindTooltip(label, { permanent: true, direction: 'top', className: 'study-area-label' });
    }
    return undefined;
  }, [data, mode, scenarioArea, scenarioCandidates, selectedCandidateId, scenarioSiteChecks, areaSelectionActive, onSelectScenarioCandidate, scenarioView]);

  // When the study area changes for an already-fitted dataset (draw/edit), follow it without requiring a dataset reload.
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    if (!['scenario', 'exposure'].includes(mode)) return;
    const bounds = boundsFromStudyArea(scenarioArea);
    if (!bounds) return;
    viewBoundsRef.current = bounds;
    applyMapBounds(map, bounds);
  }, [mode, scenarioArea]);

  useEffect(() => {
    const map = mapRef.current; if (!map) return undefined;
    clicksRef.current = [];
    let firstCorner = null;
    elementRef.current.style.cursor = areaSelectionActive ? 'crosshair' : '';
    const click = (event) => {
      if (!areaSelectionActive) return;
      clicksRef.current.push([event.latlng.lng, event.latlng.lat]);
      if (clicksRef.current.length === 1) { firstCorner = L.circleMarker(event.latlng, { radius: 6, color: '#2867bf', fillOpacity: 1 }).addTo(map); }
      if (clicksRef.current.length === 2) {
        const [a, b] = clicksRef.current; clicksRef.current = [];
        onScenarioAreaSelected([Number(Math.min(a[0], b[0]).toFixed(6)), Number(Math.min(a[1], b[1]).toFixed(6)), Number(Math.max(a[0], b[0]).toFixed(6)), Number(Math.max(a[1], b[1]).toFixed(6))]);
      }
    };
    map.on('click', click);
    return () => { map.off('click', click); if (firstCorner) map.removeLayer(firstCorner); };
  }, [areaSelectionActive, onScenarioAreaSelected]);

  useEffect(() => {
    const map = mapRef.current; if (!map) return undefined;
    if (resultLayerRef.current) map.removeLayer(resultLayerRef.current); resultLayerRef.current = null;
    const designRun = mode === 'scenario' && scenarioCandidates?.some((item) => item.design);
    if (!designRun && resultData?.features) resultLayerRef.current = L.geoJSON(resultData, { style: (feature) => ({ color: '#477f92', weight: 0.7, interactive: false, fillColor: feature.properties?.inside_zone || feature.properties?.underserved ? '#dfaa86' : '#77a879', fillOpacity: 0.16 }), interactive: false, pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, color: '#477f92', fillOpacity: 0.7 }) }).addTo(map);
    return undefined;
  }, [resultData, mode, scenarioCandidates]);

  return <div className="map-wrapper map-frame">
    <div id="map" ref={elementRef} aria-label="Map of population areas, places, selected area, and candidate sites" />
    {mode === 'scenario' && selectedCandidateId && <button type="button" className="map-focus-button" onClick={() => {
      const candidate = scenarioCandidates?.find((site) => String(site.id) === String(selectedCandidateId));
      if (candidate) mapRef.current?.setView([Number(candidate.latitude), Number(candidate.longitude)], 18);
    }}>Zoom to selected site</button>}
    <div className="map-key" aria-label="Map legend">
      <strong className="map-key-title">Legend</strong>
      {['scenario', 'exposure'].includes(mode) && <span className="map-key-item"><i className="key-area" />{mode === 'exposure' ? 'Count boundary' : 'Study boundary'}</span>}
      {mode === 'scenario' ? <><span className="map-key-item"><i className="key-plot" />Candidate plot</span><span className="map-key-item"><i className="key-selected" />Selected plot</span>{scenarioCandidates?.some((item) => item.design) ? scenarioView === 'after' && <><span className="map-key-item"><i className="key-building" />Proposed building</span><span className="map-key-item"><i className="key-open-space" />Reserved open space</span></> : <span className="map-key-item"><i className="key-building" />Proposed building</span>}<span className="map-key-item"><i className="key-blocker" />Building record</span><span className="map-key-item"><i className="key-restricted" />Restricted area</span><span className="map-key-item"><i className="key-service" />Mapped service</span>{scenarioCandidates?.some((item) => item.design) && <><span className="map-key-item"><i className="key-access-reachable" />Within walking limit</span><span className="map-key-item"><i className="key-access-beyond" />Beyond walking limit</span><span className="map-key-item"><i className="key-access-unknown" />Unknown access</span><span className="map-key-item"><i className="key-access-before" />Before route</span><span className="map-key-item"><i className="key-access-after" />After route</span></>}</> : <><span className="map-key-item"><i className="key-population" />Population areas</span><span className="map-key-item"><i className="key-service" />{mode === 'access' || mode === 'compare' ? 'Services / parks' : 'Services'}</span></>}
      {resultData?.features?.length > 0 && !(mode === 'scenario' && scenarioCandidates?.some((item) => item.design)) && <><span className="map-key-item"><i className="key-result-orange" />{mode === 'exposure' ? 'Inside count boundary' : 'Outside current service range'}</span><span className="map-key-item"><i className="key-result-green" />{mode === 'exposure' ? 'Outside count boundary' : 'Within current service range'}</span></>}
    </div>
    {areaSelectionActive && <div className="map-draw-hint" role="status">Click one corner, then the opposite corner to choose your area.</div>}
  </div>;
}
