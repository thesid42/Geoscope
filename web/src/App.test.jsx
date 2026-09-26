import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';

vi.mock('./components/LeafletMap.jsx', () => ({
  default: ({ mode }) => <div data-testid="map-view" data-mode={mode} />,
}));

const population = (id = 'p1', count = 50) => ({ type: 'Feature', id, properties: { layer: 'population', population: count, name: id }, geometry: { type: 'Point', coordinates: [-122.33, 47.61] } });
const service = { type: 'Feature', id: 's1', properties: { layer: 'service', name: 'Library' }, geometry: { type: 'Point', coordinates: [-122.32, 47.61] } };
const zone = { type: 'Feature', id: 'z1', properties: { layer: 'zone', name: 'Study zone' }, geometry: { type: 'Polygon', coordinates: [[[-122.34, 47.60], [-122.30, 47.60], [-122.30, 47.64], [-122.34, 47.64], [-122.34, 47.60]]] } };
const demoData = { type: 'FeatureCollection', name: 'Harborview fixture', features: [population(), service, zone] };
const sfData = { type: 'FeatureCollection', name: 'San Francisco fixture', features: [population('sf-p'), service] };
const config = { demo: { id: 'demo', name: 'Harborview synthetic demo', synthetic: true }, real: { id: 'sf2020', name: 'SF sample', synthetic: false }, analysis_enabled: true };
const completedExposure = {
  id: 'run-1', status: 'completed', analysis_mode: 'exposure', synthetic: true,
  summary: 'Zero-population test result.', plan: '{"steps":["fixture"]}', reference_verified: true,
  result: { mode: 'exposure', reference_verified: true, metrics: { population_total: 0, inside_population: 0, outside_population: 0, share_inside_pct: null, inside_feature_count: 0 } },
  logs: [], attempts: [],
};
const completedAccess = {
  id: 'run-1', status: 'completed', analysis_mode: 'access', synthetic: true,
  summary: 'Access fixture complete.', plan: '{"steps":["fixture"]}',
  result: { mode: 'access', reference_verified: true, metrics: { baseline: { served_population: 42, underserved_population: 8, weighted_mean_nearest_m: 20 } } },
  logs: [], attempts: [],
};
const geojsonResponse = (value, status = 200) => response(status, value);
function response(status, payload, extra = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }), ...extra };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function baseFetch(overrides = {}) {
  return vi.fn(async (url, init = {}) => {
    if (url === '/api/config') return geojsonResponse(config);
    if (url === '/api/worker-status') return geojsonResponse({ ok: true, message: 'Mock worker ready' });
    if (url === '/api/datasets/real') return geojsonResponse(sfData);
    if (url === '/api/datasets/demo') return geojsonResponse(demoData);
    if (url === '/api/runs' && init.method === 'POST') return geojsonResponse({ id: 'run-1', status: 'queued' }, 202);
    if (url === '/api/runs/run-1') return geojsonResponse(completedAccess);
    if (url === '/api/runs/run-1/map') return geojsonResponse({ type: 'FeatureCollection', features: [population()] });
    return overrides[url]?.(url, init) ?? response(404, { detail: `Unhandled test path ${url}` });
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubGlobal('fetch', baseFetch());
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:fixture') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function ready(user, key = 'test-access-key') {
  await waitFor(() => expect(screen.getByRole('button', { name: /Run the analysis/ })).toBeEnabled());
  await user.type(screen.getByLabelText('Analysis access key'), key);
}

describe('GeoScope React workflows', () => {
  it('ignores an out-of-order dataset response and keeps run disabled until the selected data loads', async () => {
    const user = userEvent.setup();
    const oldRequest = deferred();
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return oldRequest.promise;
      if (url === '/api/datasets/demo') return geojsonResponse(demoData);
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('option', { name: /Harborview/ });
    const run = screen.getByRole('button', { name: /Run the analysis/ });
    expect(run).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Population inside zones' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Population + places or zones'), 'demo');
    await screen.findByRole('heading', { name: 'Harborview · synthetic fixture' });
    await waitFor(() => expect(run).toBeEnabled());
    oldRequest.resolve(geojsonResponse(sfData));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('heading', { name: 'Harborview · synthetic fixture' })).toBeInTheDocument();
    expect(screen.getByText('1 population areas · 1 services · 1 zones')).toBeInTheDocument();
  });

  it('renders null exposure metrics as N/A and clears success cards after a polling HTTP failure', async () => {
    const user = userEvent.setup();
    let postCount = 0;
    const fetchMock = baseFetch();
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (url === '/api/runs' && init.method === 'POST') { postCount += 1; return geojsonResponse({ id: postCount === 1 ? 'run-1' : 'run-2', status: 'queued' }, 202); }
      if (url === '/api/runs/run-1') return geojsonResponse(completedExposure);
      if (url === '/api/runs/run-2') return response(503, { detail: 'worker unavailable' });
      if (url === '/api/runs') return geojsonResponse({ id: 'run-1', status: 'queued' }, 202);
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/datasets/demo') return geojsonResponse(demoData);
      if (url === '/api/runs/run-1/map') return geojsonResponse({ type: 'FeatureCollection', features: [] });
      return response(404, { detail: 'not found' });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await ready(user);
    await user.selectOptions(screen.getByLabelText('Population + places or zones'), 'demo');
    await screen.findByRole('heading', { name: 'Harborview · synthetic fixture' });
    await user.selectOptions(screen.getByLabelText('Analysis'), 'exposure');
    await user.click(screen.getByRole('button', { name: /Run the analysis/ }));
    await screen.findByText('Zero-population test result.');
    const exposurePost = fetchMock.mock.calls.find(([url, init]) => url === '/api/runs' && init?.method === 'POST');
    expect(JSON.parse(exposurePost[1].body).analysis_mode).toBe('exposure');
    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
    expect(screen.getByText('share of total population')).toBeInTheDocument();
    // A new run starts from a clean result view even if the next poll cannot be read.
    await user.selectOptions(screen.getByLabelText('Analysis'), 'access');
    await user.click(screen.getByRole('button', { name: /Run the analysis/ }));
    expect(await screen.findByText(/Could not retrieve run status: worker unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Zero-population test result.')).not.toBeInTheDocument();
    expect(screen.queryByText('share of total population')).not.toBeInTheDocument();
  });

  it('sends the session access key on uploads, polling, and artifact downloads', async () => {
    const user = userEvent.setup();
    const fetchMock = baseFetch({});
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (url === '/api/datasets' && init.method === 'POST') return geojsonResponse({ id: 'uploaded-id', schema: { service_features: 1, zone_features: 1, population_features: 1 } });
      if (url === '/api/datasets/uploaded-id') return geojsonResponse(demoData);
      if (url === '/api/runs/run-1') return geojsonResponse(completedAccess);
      if (url === '/api/runs/run-1/map') return geojsonResponse({ type: 'FeatureCollection', features: [] });
      if (url === '/api/runs/run-1/artifacts/result.json') return response(200, { file: true });
      if (url === '/api/runs' && init.method === 'POST') return geojsonResponse({ id: 'run-1', status: 'queued' }, 202);
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/datasets/demo') return geojsonResponse(demoData);
      return response(404, { detail: 'not found' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<App />);
    await ready(user, '  test-access-key  ');
    const file = new File([JSON.stringify(demoData)], 'fixture.geojson', { type: 'application/geo+json' });
    await user.upload(screen.getByLabelText(/bring your own GeoJSON/i), file);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/datasets', expect.objectContaining({ headers: { Authorization: 'Bearer test-access-key' } })));
    await screen.findByText('fixture.geojson');
    await user.click(screen.getByRole('button', { name: /Run the analysis/ }));
    await screen.findByText('Access fixture complete.');
    await user.click(screen.getByRole('button', { name: 'result.json ↓' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-1/artifacts/result.json', expect.objectContaining({ headers: { Authorization: 'Bearer test-access-key' } }));
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-1', expect.objectContaining({ headers: { Authorization: 'Bearer test-access-key' }, signal: expect.any(AbortSignal) }));
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-1/map', expect.objectContaining({ headers: { Authorization: 'Bearer test-access-key' }, signal: expect.any(AbortSignal) }));
  });


  it('keeps the public map preview when worker readiness cannot be fetched', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') throw new Error('worker endpoint offline');
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'San Francisco · 2020 Census + selected parks' });
    expect(screen.getByText('WORKER UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run the analysis/ })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Population inside zones' })).toBeDisabled();
  });

  it('locks dataset, mode, and upload while the run-creation request is pending', async () => {
    const user = userEvent.setup();
    const pendingCreate = deferred();
    const fetchMock = baseFetch();
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/datasets/demo') return geojsonResponse(demoData);
      if (url === '/api/runs' && init.method === 'POST') return pendingCreate.promise;
      if (url === '/api/runs/run-pending') return geojsonResponse({ ...completedAccess, id: 'run-pending' });
      if (url === '/api/runs/run-pending/map') return geojsonResponse({ type: 'FeatureCollection', features: [] });
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await ready(user);
    await user.click(screen.getByRole('button', { name: /Run the analysis/ }));
    expect(screen.getByLabelText('Population + places or zones')).toBeDisabled();
    expect(screen.getByLabelText('Analysis')).toBeDisabled();
    expect(screen.getByLabelText(/bring your own GeoJSON/i)).toBeDisabled();
    const post = fetchMock.mock.calls.find(([url, init]) => url === '/api/runs' && init?.method === 'POST');
    expect(JSON.parse(post[1].body).dataset_id).toBe('sf2020');
    pendingCreate.resolve(geojsonResponse({ id: 'run-pending', status: 'queued' }, 202));
    await screen.findByText('Access fixture complete.');
  });

  it('does not claim reference verification for a planned but failed run', async () => {
    const user = userEvent.setup();
    const fetchMock = baseFetch({});
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/runs' && init.method === 'POST') return geojsonResponse({ id: 'run-1', status: 'queued' }, 202);
      if (url === '/api/runs/run-1') return geojsonResponse({ id: 'run-1', status: 'failed', analysis_mode: 'access', plan: 'plan exists', error: 'sandbox unavailable', logs: [] });
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await ready(user);
    await user.click(screen.getByRole('button', { name: /Run the analysis/ }));
    await screen.findByText('sandbox unavailable');
    expect(screen.queryByText('Metrics and per-feature results matched a fixed GIS reference calculation.')).not.toBeInTheDocument();
  });
});
