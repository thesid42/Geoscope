import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import LeafletMap from './LeafletMap.jsx';

const mocks = vi.hoisted(() => {
  const bounds = {
    isValid: () => true,
    pad: () => bounds,
    getSouthWest: () => ({ lat: 37.7, lng: -122.5 }),
    getNorthEast: () => ({ lat: 37.8, lng: -122.4 }),
  };
  const map = {
    setView: vi.fn(function () { return this; }),
    fitBounds: vi.fn(), invalidateSize: vi.fn(), removeLayer: vi.fn(), remove: vi.fn(), on: vi.fn(), off: vi.fn(),
  };
  const popups = [];
  const markers = [];
  const plotTooltips = [];
  const addedLayer = () => ({ addTo: vi.fn(function () { return this; }), bindTooltip: vi.fn(function () { return this; }), bindPopup: vi.fn(function () { return this; }), on: vi.fn(function () { return this; }) });
  const latLngBounds = vi.fn((arg) => {
    if (arg && typeof arg.isValid === 'function') return arg;
    return {
      isValid: () => true,
      pad: () => bounds,
      _input: arg,
      getSouthWest: () => Array.isArray(arg?.[0]) ? { lat: arg[0][0], lng: arg[0][1] } : { lat: 0, lng: 0 },
      getNorthEast: () => Array.isArray(arg?.[1]) ? { lat: arg[1][0], lng: arg[1][1] } : { lat: 1, lng: 1 },
    };
  });
  return { map, bounds, popups, markers, plotTooltips, addedLayer, latLngBounds };
});

vi.mock('leaflet', () => ({
  default: {
    map: vi.fn(() => mocks.map),
    control: { zoom: vi.fn(() => mocks.addedLayer()), scale: vi.fn(() => mocks.addedLayer()) },
    tileLayer: vi.fn(() => mocks.addedLayer()),
    divIcon: vi.fn((options) => options),
    rectangle: vi.fn(() => mocks.addedLayer()),
    circleMarker: vi.fn(() => mocks.addedLayer()),
    latLngBounds: (...args) => mocks.latLngBounds(...args),
    geoJSON: vi.fn((data, options) => {
      for (const feature of data.features ?? [data]) {
        options.onEachFeature?.(feature, { bindPopup: (node) => mocks.popups.push(node), on: vi.fn() });
      }
      const layer = {
        ...mocks.addedLayer(),
        getBounds: () => mocks.bounds,
        bindTooltip: vi.fn(function (node, opts) {
          mocks.plotTooltips.push({
            text: typeof node === 'string' ? node : node?.textContent,
            className: opts?.className ?? '',
            permanent: Boolean(opts?.permanent),
            featureId: String(data?.id ?? data?.features?.[0]?.id ?? ''),
          });
          return this;
        }),
      };
      return layer;
    }),
    marker: vi.fn(() => {
      const marker = {
        ...mocks.addedLayer(), handlers: {},
        bindTooltip: vi.fn(function () { return this; }),
        on: vi.fn(function (event, handler) { this.handlers[event] = handler; return this; }),
      };
      mocks.markers.push(marker);
      return marker;
    }),
  },
}));

const source = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', id: 'p1', properties: { layer: 'population', population: 10, name: 'Test area' }, geometry: { type: 'Point', coordinates: [-122.4, 37.7] } }],
};
const makeProps = () => ({
  data: source, datasetId: 'uploaded-test', resultData: null, mode: 'compare',
  candidateA: [-122.41, 37.71], candidateB: [-122.42, 37.72], onCandidateChange: vi.fn(),
});

beforeEach(() => { vi.clearAllMocks(); mocks.popups.length = 0; mocks.markers.length = 0; mocks.plotTooltips.length = 0; });
afterEach(cleanup);

describe('Leaflet map lifecycle', () => {
  it('refits only for a changed source dataset, not rerenders, moved candidates, or result overlays', () => {
    const props = makeProps();
    const view = render(<LeafletMap {...props} />);
    expect(mocks.map.fitBounds).toHaveBeenCalled();
    const afterMount = mocks.map.fitBounds.mock.calls.length;

    // A new callback models an unrelated parent render and must not rebuild the source.
    view.rerender(<LeafletMap {...props} onCandidateChange={vi.fn()} />);
    view.rerender(<LeafletMap {...props} candidateA={[-122.45, 37.73]} />);
    view.rerender(<LeafletMap {...props} resultData={{ ...source }} />);
    expect(mocks.map.fitBounds).toHaveBeenCalledTimes(afterMount);

    view.rerender(<LeafletMap {...props} data={{ ...source }} datasetId="second-upload" />);
    expect(mocks.map.fitBounds.mock.calls.length).toBeGreaterThan(afterMount);
    view.unmount();
    expect(mocks.map.remove).toHaveBeenCalledTimes(1);
  });

  it('reports dragged candidate coordinates without resetting the source extent', () => {
    const props = makeProps();
    render(<LeafletMap {...props} />);
    const afterMount = mocks.map.fitBounds.mock.calls.length;
    mocks.markers[0].handlers.dragend({ target: { getLatLng: () => ({ lng: -122.4123456, lat: 37.7123456 }) } });
    expect(props.onCandidateChange).toHaveBeenCalledWith('A', [-122.41235, 37.71235]);
    expect(mocks.map.fitBounds).toHaveBeenCalledTimes(afterMount);
  });

  it('renders uploaded feature names as text rather than popup HTML', () => {
    const maliciousName = '<img src=x onerror="alert(1)">';
    const data = { ...source, features: [{ ...source.features[0], properties: { ...source.features[0].properties, name: maliciousName } }] };
    render(<LeafletMap {...makeProps()} data={data} />);
    expect(mocks.popups[0].querySelector('b').textContent).toBe(maliciousName);
    expect(mocks.popups[0].querySelector('img')).toBeNull();
  });

  it('recenters on SF mock and East Harlem extents when those datasets are selected', () => {
    const props = makeProps();
    const view = render(<LeafletMap {...props} mode="scenario" datasetId="nycland" scenarioArea={[-73.955, 40.790, -73.930, 40.812]} />);
    expect(mocks.latLngBounds).toHaveBeenCalled();
    const harlemCall = mocks.map.fitBounds.mock.calls.at(-1)[0];
    expect(harlemCall.getSouthWest().lat).toBeCloseTo(40.790, 3);
    expect(harlemCall.getSouthWest().lng).toBeCloseTo(-73.955, 3);

    const beforeSf = mocks.map.fitBounds.mock.calls.length;
    view.rerender(<LeafletMap {...props} mode="scenario" datasetId="localdemo" data={{ ...source }} scenarioArea={[-122.433, 37.758, -122.417, 37.776]} />);
    expect(mocks.map.fitBounds.mock.calls.length).toBeGreaterThan(beforeSf);
    const sfCall = mocks.map.fitBounds.mock.calls.at(-1)[0];
    expect(sfCall.getSouthWest().lat).toBeCloseTo(37.758, 3);
    expect(sfCall.getSouthWest().lng).toBeCloseTo(-122.433, 3);
    expect(mocks.map.invalidateSize).toHaveBeenCalled();
  });

  it('uses preset SF mock bounds when study area is not ready yet', () => {
    render(<LeafletMap {...makeProps()} mode="scenario" datasetId="localdemo" scenarioArea={null} />);
    const preset = mocks.latLngBounds.mock.calls
      .map((call) => call[0])
      .find((arg) => Array.isArray(arg) && Array.isArray(arg[0]) && arg[0][0] === 37.755);
    expect(preset).toEqual([[37.755, -122.438], [37.780, -122.412]]);
    expect(mocks.map.fitBounds).toHaveBeenCalled();
  });
});




it('keeps lettered permanent labels on small pre-run inventories', () => {
  const features = Array.from({ length: 3 }, (_, index) => ({
    type: 'Feature',
    id: `plot-${index}`,
    properties: { layer: 'candidate_site', name: `Plot ${index}` },
    geometry: { type: 'Polygon', coordinates: [[[-122.4, 37.7], [-122.39, 37.7], [-122.39, 37.71], [-122.4, 37.71], [-122.4, 37.7]]] },
  }));
  render(<LeafletMap {...makeProps()} mode="scenario" data={{ type: 'FeatureCollection', features }} scenarioCandidates={[]} selectedCandidateId={null} />);
  const plotLabels = mocks.plotTooltips.filter((tip) => tip.className.includes('plot-label'));
  expect(plotLabels).toHaveLength(3);
  expect(plotLabels.every((tip) => tip.permanent)).toBe(true);
  expect(plotLabels.map((tip) => tip.text)).toEqual(['Plot A', 'Plot B', 'Plot C']);
});

it('declutter dense inventories: hover-only for unlabeled plots, permanent for selected and top ranks', () => {
  const features = Array.from({ length: 20 }, (_, index) => ({
    type: 'Feature',
    id: `lot-${index}`,
    properties: { layer: 'candidate_site', name: `Lot ${index}` },
    geometry: { type: 'Polygon', coordinates: [[[-73.95, 40.80], [-73.949, 40.80], [-73.949, 40.801], [-73.95, 40.801], [-73.95, 40.80]]] },
  }));
  const ranked = [
    { id: 'lot-0', rank: 1, longitude: -73.95, latitude: 40.8005 },
    { id: 'lot-1', rank: 2, longitude: -73.9495, latitude: 40.8005 },
    { id: 'lot-9', rank: 9, longitude: -73.949, latitude: 40.8005 },
  ];
  render(<LeafletMap
    {...makeProps()}
    mode="scenario"
    datasetId="nycland"
    data={{ type: 'FeatureCollection', features }}
    scenarioCandidates={ranked}
    selectedCandidateId="lot-0"
  />);
  const plotLabels = mocks.plotTooltips.filter((tip) => tip.className.includes('plot-label'));
  expect(plotLabels).toHaveLength(20);
  const permanent = plotLabels.filter((tip) => tip.permanent);
  const hoverOnly = plotLabels.filter((tip) => !tip.permanent);
  // Selected (rank 1) + rank 2 stay permanent; rank 9 is beyond top-8 cap; other lots hover-only.
  expect(permanent.map((tip) => tip.text).sort()).toEqual(['Selected · Site 1', 'Site 2'].sort());
  expect(permanent.some((tip) => tip.className.includes('selected'))).toBe(true);
  expect(hoverOnly.length).toBe(18);
  expect(hoverOnly.every((tip) => tip.className.includes('hover-only'))).toBe(true);
});

it('hides permanent labels on dense pre-run extracts until a site is selected', () => {
  const features = Array.from({ length: 15 }, (_, index) => ({
    type: 'Feature',
    id: `lot-${index}`,
    properties: { layer: 'candidate_site' },
    geometry: { type: 'Polygon', coordinates: [[[-73.95, 40.80], [-73.949, 40.80], [-73.949, 40.801], [-73.95, 40.801], [-73.95, 40.80]]] },
  }));
  const view = render(<LeafletMap {...makeProps()} mode="scenario" datasetId="nycland" data={{ type: 'FeatureCollection', features }} scenarioCandidates={[]} selectedCandidateId={null} />);
  expect(mocks.plotTooltips.filter((tip) => tip.className.includes('plot-label') && tip.permanent)).toHaveLength(0);
  view.rerender(<LeafletMap {...makeProps()} mode="scenario" datasetId="nycland" data={{ type: 'FeatureCollection', features }} scenarioCandidates={[]} selectedCandidateId="lot-3" />);
  const permanent = mocks.plotTooltips.filter((tip) => tip.className.includes('plot-label') && tip.permanent);
  expect(permanent).toHaveLength(1);
  expect(permanent[0].text).toMatch(/^Selected ·/);
  expect(permanent[0].className).toContain('selected');
});

it('shows supplied parcel IDs as text in scenario marker tooltips', () => {
  const id = '<img src=x onerror="alert(1)">';
  render(<LeafletMap {...makeProps()} mode="scenario" scenarioCandidates={[{id,rank:1,longitude:-122.4,latitude:37.7}]} selectedCandidateId={id} />);
  const tooltip = mocks.markers[0].bindTooltip.mock.calls[0][0];
  expect(tooltip.textContent).toContain(id);
  expect(tooltip.querySelector('img')).toBeNull();
});


it('selects the same ranked site from its map marker and labels the study boundary', () => {
  const candidate = { id: 'plot-1', rank: 2, longitude: -122.4, latitude: 37.7 };
  const onSelect = vi.fn();
  const props = { ...makeProps(), mode: 'scenario', scenarioCandidates: [candidate], selectedCandidateId: candidate.id, onSelectScenarioCandidate: onSelect, scenarioArea: [-122.41,37.69,-122.39,37.71] };
  const view = render(<LeafletMap {...props} />);
  mocks.markers[0].handlers.click();
  expect(onSelect).toHaveBeenCalledWith(candidate);
  expect(view.getByLabelText('Map legend').textContent).toContain('Selected plot');
  expect(view.getByLabelText('Map legend').textContent).toContain('Proposed building');
  expect(view.getByRole('button', { name: 'Zoom to selected site' })).toBeTruthy();
});

it('keeps drawing clicks from changing the selected site', () => {
  const onSelect = vi.fn();
  render(<LeafletMap {...makeProps()} mode="scenario" scenarioCandidates={[{ id: 'plot-1', rank: 1, longitude: -122.4, latitude: 37.7 }]} onSelectScenarioCandidate={onSelect} areaSelectionActive />);
  mocks.markers[0].handlers.click();
  expect(onSelect).not.toHaveBeenCalled();
});


it('prevents dragging compare pins while a run owns their coordinates', () => {
  const props = makeProps(); render(<LeafletMap {...props} interactionsLocked />);
  mocks.markers[0].handlers.dragend({ target: { getLatLng: () => ({ lng: 1, lat: 2 }) } });
  expect(props.onCandidateChange).not.toHaveBeenCalled();
});
