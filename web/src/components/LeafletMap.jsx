import { useEffect, useRef } from 'react';
import L from 'leaflet';

const roleOf = (feature) => feature?.properties?.layer === 'park' ? 'service' : feature?.properties?.layer;
function styleFor(feature) {
  const role = roleOf(feature);
  if (role === 'zone') return { color: '#c08046', weight: 1.4, fillColor: '#e5ad71', fillOpacity: 0.25 };
  if (role === 'service') return { color: '#559365', weight: 1.2, fillColor: '#83b88b', fillOpacity: 0.65 };
  return { color: '#789d98', weight: 0.7, fillColor: '#a7c8bf', fillOpacity: 0.18 };
}
function pointStyle(feature) {
  const service = roleOf(feature) === 'service';
  return { radius: 6, color: service ? '#559365' : '#648d83', weight: 1, fillOpacity: 0.55, fillColor: service ? '#83b88b' : '#a7c8bf' };
}
function popupNode(feature) {
  const props = feature?.properties ?? {};
  const root = document.createElement('div');
  root.className = 'tract-popup';
  const name = document.createElement('b');
  name.textContent = props.name || props.geoid || props.id || 'Feature';
  const detail = document.createElement('span');
  const role = roleOf(feature);
  detail.textContent = role === 'population' ? ` · ${Number(props.population || 0).toLocaleString()} population estimate` : role === 'zone' ? ' · Analysis zone' : ' · Service location';
  root.append(name, document.createElement('br'), detail);
  return root;
}
function candidateIcon(letter, kind) {
  return L.divIcon({ className: '', html: `<div class="candidate-marker ${kind}">${letter}</div>`, iconSize: [25, 25], iconAnchor: [12, 12] });
}

export default function LeafletMap({ data, datasetId, resultData, mode, candidateA, candidateB, onCandidateChange }) {
  const elementRef = useRef(null);
  const mapRef = useRef(null);
  const sourceLayerRef = useRef(null);
  const resultLayerRef = useRef(null);
  const candidateLayersRef = useRef([]);

  useEffect(() => {
    const map = L.map(elementRef.current, { zoomControl: false }).setView([37.764, -122.44], 12);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    if (sourceLayerRef.current) map.removeLayer(sourceLayerRef.current);
    sourceLayerRef.current = null;
    if (!data?.features) return undefined;
    const visible = { type: 'FeatureCollection', features: data.features.filter((f) => roleOf(f) !== 'population' || Number(f.properties?.population) > 0) };
    const layer = L.geoJSON(visible, {
      style: styleFor,
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, pointStyle(feature)),
      onEachFeature: (feature, child) => child.bindPopup(popupNode(feature)),
    }).addTo(map);
    sourceLayerRef.current = layer;
    if (datasetId === 'sf2020') map.fitBounds([[37.70, -122.53], [37.83, -122.35]]);
    else {
      const bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.08));
    }
    return undefined;
  }, [data, datasetId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    candidateLayersRef.current.forEach((layer) => map.removeLayer(layer));
    candidateLayersRef.current = [];
    if (mode !== 'compare') return undefined;
    for (const [index, letter, kind, position] of [[0, 'A', 'a', candidateA], [1, 'B', 'b', candidateB]]) {
      const longitude = Number(position?.[0]);
      const latitude = Number(position?.[1]);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
      const marker = L.marker([latitude, longitude], { icon: candidateIcon(letter, kind), draggable: true })
        .addTo(map).bindTooltip(`Candidate ${letter} · illustrative; drag to adjust`);
      marker.on('dragend', (event) => {
        const point = event.target.getLatLng();
        onCandidateChange(letter, [Number(point.lng.toFixed(5)), Number(point.lat.toFixed(5))]);
      });
      candidateLayersRef.current[index] = marker;
    }
    return undefined;
  }, [mode, candidateA, candidateB, onCandidateChange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    if (resultLayerRef.current) map.removeLayer(resultLayerRef.current);
    resultLayerRef.current = null;
    if (resultData?.features) {
      resultLayerRef.current = L.geoJSON(resultData, {
        style: (feature) => ({ color: '#477f92', weight: 1, fillColor: feature.properties?.inside_zone || feature.properties?.underserved ? '#dfaa86' : '#77a879', fillOpacity: 0.35 }),
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, color: '#477f92', fillOpacity: 0.7 }),
      }).addTo(map);
    }
    return undefined;
  }, [resultData]);

  return <div id="map" ref={elementRef} aria-label="Map of population areas, services, zones and proposed sites" />;
}
