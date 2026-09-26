import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import LeafletMap from './LeafletMap.jsx';

const mocks = vi.hoisted(() => {
  const bounds = { isValid: () => true, pad: () => bounds };
  const map = {
    setView: vi.fn(function () { return this; }),
    fitBounds: vi.fn(), removeLayer: vi.fn(), remove: vi.fn(),
  };
  const popups = [];
  const markers = [];
  const addedLayer = () => ({ addTo: vi.fn(function () { return this; }) });
  return { map, bounds, popups, markers, addedLayer };
});

vi.mock('leaflet', () => ({
  default: {
    map: vi.fn(() => mocks.map),
    control: { zoom: vi.fn(() => mocks.addedLayer()) },
    tileLayer: vi.fn(() => mocks.addedLayer()),
    divIcon: vi.fn((options) => options),
    circleMarker: vi.fn(() => mocks.addedLayer()),
    geoJSON: vi.fn((data, options) => {
      for (const feature of data.features) {
        options.onEachFeature?.(feature, { bindPopup: (node) => mocks.popups.push(node) });
      }
      return { ...mocks.addedLayer(), getBounds: () => mocks.bounds };
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

beforeEach(() => { vi.clearAllMocks(); mocks.popups.length = 0; mocks.markers.length = 0; });
afterEach(cleanup);

describe('Leaflet map lifecycle', () => {
  it('refits only for a changed source dataset, not rerenders, moved candidates, or result overlays', () => {
    const props = makeProps();
    const view = render(<LeafletMap {...props} />);
    expect(mocks.map.fitBounds).toHaveBeenCalledTimes(1);

    // A new callback models an unrelated parent render and must not rebuild the source.
    view.rerender(<LeafletMap {...props} onCandidateChange={vi.fn()} />);
    view.rerender(<LeafletMap {...props} candidateA={[-122.45, 37.73]} />);
    view.rerender(<LeafletMap {...props} resultData={{ ...source }} />);
    expect(mocks.map.fitBounds).toHaveBeenCalledTimes(1);

    view.rerender(<LeafletMap {...props} data={{ ...source }} datasetId="second-upload" />);
    expect(mocks.map.fitBounds).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(mocks.map.remove).toHaveBeenCalledTimes(1);
  });

  it('reports dragged candidate coordinates without resetting the source extent', () => {
    const props = makeProps();
    render(<LeafletMap {...props} />);
    mocks.markers[0].handlers.dragend({ target: { getLatLng: () => ({ lng: -122.4123456, lat: 37.7123456 }) } });
    expect(props.onCandidateChange).toHaveBeenCalledWith('A', [-122.41235, 37.71235]);
    expect(mocks.map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('renders uploaded feature names as text rather than popup HTML', () => {
    const maliciousName = '<img src=x onerror="alert(1)">';
    const data = { ...source, features: [{ ...source.features[0], properties: { ...source.features[0].properties, name: maliciousName } }] };
    render(<LeafletMap {...makeProps()} data={data} />);
    expect(mocks.popups[0].querySelector('b').textContent).toBe(maliciousName);
    expect(mocks.popups[0].querySelector('img')).toBeNull();
  });
});
