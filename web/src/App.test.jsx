import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';

vi.mock('./components/LeafletMap.jsx', () => ({
  default: ({ mode }) => <div data-testid="map-view" data-mode={mode} />,
}));

vi.mock('./components/ScenarioViewer.jsx', () => ({ default: ({ candidate }) => <div data-testid="scenario-3d">{candidate.id}</div> }));

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
  logs: [], attempts: [], artifacts: { 'result.json': true, 'trace.json': true },
};
const completedAccess = {
  id: 'run-1', status: 'completed', analysis_mode: 'access', synthetic: true,
  summary: 'Access fixture complete.', plan: '{"steps":["fixture"]}',
  result: { mode: 'access', reference_verified: true, metrics: { baseline: { served_population: 42, underserved_population: 8, weighted_mean_nearest_m: 20 } } },
  logs: [], attempts: [], artifacts: { 'analysis.py': true, 'result.json': true, 'trace.json': true },
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

async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ })).toBeEnabled());
  expect(screen.queryByLabelText('Analysis access key')).not.toBeInTheDocument();
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
    const run = screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ });
    expect(run).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Estimate population in an area' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Dataset'), 'demo');
    await screen.findByRole('heading', { name: 'Harborview' });
    expect(screen.getByRole('option', { name: 'Estimate population in an area' })).not.toBeDisabled();
    await waitFor(() => expect(run).toBeEnabled());
    oldRequest.resolve(geojsonResponse(sfData));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('heading', { name: 'Harborview' })).toBeInTheDocument();
    expect(screen.getByText('Fabricated features for demonstration and testing. They do not describe a real neighborhood.')).toBeInTheDocument();
  });

  it('defaults East Harlem official lots to facility-site mode', async () => {
    const land = { type: 'FeatureCollection', name: 'East Harlem land', scenario_status: 'OFFICIAL_EXTRACT', features: [
      population('eh-p', 80),
      { type: 'Feature', id: 'lot-1', properties: { layer: 'candidate_site', land_status: 'available' }, geometry: { type: 'Polygon', coordinates: [[[-73.94, 40.80], [-73.939, 40.80], [-73.939, 40.801], [-73.94, 40.801], [-73.94, 40.80]]] } },
      { ...service, id: 'eh-clinic', properties: { layer: 'service', service_type: 'clinic', name: 'Clinic' }, geometry: { type: 'Point', coordinates: [-73.941, 40.799] } },
    ] };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse({ ...config, nyc_land: { id: 'nycland', name: 'East Harlem lots', synthetic: false } });
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/nycland') return geojsonResponse(land);
      return response(404, {});
    }));
    render(<App />);
    await screen.findByRole('heading', { name: 'East Harlem' });
    await ready();
    expect(screen.getByLabelText('Task')).toHaveValue('scenario');
    expect(screen.getByText(/MapPLUTO vacant tax lots/)).toBeInTheDocument();
  });

  it('lists the New York City snapshot and uses Midtown comparison defaults', async () => {
    const nycData = { type: 'FeatureCollection', name: 'NYC fixture', features: [population('nyc-p', 120), { ...service, id: 'nyc-clinic', properties: { layer: 'service', service_type: 'clinic', name: 'Clinic', borough: 'Manhattan' }, geometry: { type: 'Point', coordinates: [-73.98, 40.75] } }] };
    const nycConfig = { ...config, nyc: { id: 'nyc2020', name: 'NYC sample', synthetic: false, features: 7927 } };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse(nycConfig);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/datasets/nyc2020') return geojsonResponse(nycData);
      if (url === '/api/datasets/demo') return geojsonResponse(demoData);
      return response(404, {});
    }));
    render(<App />);
    await screen.findByRole('heading', { name: 'New York' });
    expect(await screen.findByText(/FacDB clinics, libraries, schools, and community centers/)).toBeInTheDocument();
    expect(screen.getByLabelText('Candidate A longitude')).toHaveValue(-73.9832);
    expect(screen.getByLabelText('Candidate A latitude')).toHaveValue(40.7536);
    expect(screen.getByLabelText('Candidate B longitude')).toHaveValue(-73.9903);
    expect(screen.getByLabelText('Candidate B latitude')).toHaveValue(40.7359);
  });

  it('uses San Francisco comparison defaults for the local mock dataset', async () => {
    const user = userEvent.setup();
    const scenarioData = { ...demoData, features: [...demoData.features, { ...service, id: 'sf-library', geometry: { type: 'Point', coordinates: [-122.425, 37.767] } }] };
    const localConfig = { ...config, scenario_demo: { id: 'localdemo', name: 'SF mock' }, supported_modes: ['scenario', 'compare'] };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse(localConfig);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/localdemo') return geojsonResponse(scenarioData);
      return response(404, {});
    }));
    render(<App />);
    await screen.findByRole('heading', { name: 'San Francisco' });
    await ready();
    await user.selectOptions(screen.getByLabelText('Task'), 'compare');
    expect(screen.getByLabelText('Candidate A longitude')).toHaveValue(-122.43);
    expect(screen.getByLabelText('Candidate A latitude')).toHaveValue(37.77);
    expect(screen.getByLabelText('Candidate B longitude')).toHaveValue(-122.42);
    expect(screen.getByLabelText('Candidate B latitude')).toHaveValue(37.76);
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
    await user.selectOptions(screen.getByLabelText('Dataset'), 'demo');
    await screen.findByRole('heading', { name: 'Harborview' });
    await user.click(screen.getByText(/More tools \(basic proximity \/ population\)/));
    await user.selectOptions(screen.getByLabelText('Basic analysis'), 'exposure');
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ }));
    await screen.findByText('Zero-population test result.');
    const exposurePost = fetchMock.mock.calls.find(([url, init]) => url === '/api/runs' && init?.method === 'POST');
    expect(JSON.parse(exposurePost[1].body).analysis_mode).toBe('exposure');
    expect(JSON.parse(exposurePost[1].body).study_area).toHaveLength(4);
    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
    expect(screen.getByText('share of total population')).toBeInTheDocument();
    // A new run starts from a clean result view even if the next poll cannot be read.
    await user.selectOptions(screen.getByLabelText('Basic analysis'), 'access');
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ }));
    expect(await screen.findByText(/Could not retrieve run status: worker unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Zero-population test result.')).not.toBeInTheDocument();
    expect(screen.queryByText('share of total population')).not.toBeInTheDocument();
  });

  it('enables population estimates without supplied zones and submits the selected default area', async () => {
    const user = userEvent.setup();
    const fetchMock = baseFetch();
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/runs' && init.method === 'POST') return geojsonResponse({ id: 'run-1', status: 'queued' }, 202);
      if (url === '/api/runs/run-1') return geojsonResponse(completedExposure);
      if (url === '/api/runs/run-1/map') return geojsonResponse({ type: 'FeatureCollection', features: [] });
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'San Francisco' });
    await ready();
    await user.click(screen.getByText(/More tools \(basic proximity \/ population\)/));
    await user.selectOptions(screen.getByLabelText('Basic analysis'), 'exposure');
    expect(screen.getByRole('button', { name: 'Draw area on map' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Estimate population/ })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Estimate population/ }));
    await screen.findByText('Zero-population test result.');
    const post = fetchMock.mock.calls.find(([url, init]) => url === '/api/runs' && init?.method === 'POST');
    expect(JSON.parse(post[1].body)).toMatchObject({ analysis_mode: 'exposure', study_area: [-122.433, 37.758, -122.417, 37.776] });
    expect(screen.getByText('estimated population inside area')).toBeInTheDocument();
    expect(screen.getByText(/Each census area’s full population estimate is assigned by its representative point/i)).toBeInTheDocument();
  });

  it('uses same-origin requests without exposing an access token on uploads, polling, or downloads', async () => {
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
    await ready();
    const file = new File([JSON.stringify(demoData)], 'fixture.geojson', { type: 'application/geo+json' });
    await user.click(screen.getByText('Upload GeoJSON'));
    await user.upload(screen.getByLabelText(/Choose a GeoJSON file/i), file);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/datasets' && init?.method === 'POST')).toBe(true));
    await screen.findByRole('heading', { name: 'fixture.geojson' });
    await user.click(screen.getByText(/More tools \(basic proximity \/ population\)/));
    await user.selectOptions(screen.getByLabelText('Basic analysis'), 'access');
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ }));
    await screen.findByText('Access fixture complete.');
    await user.click(screen.getByRole('button', { name: 'result.json ↓' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-1/artifacts/result.json', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-1/map', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    for (const [,init] of fetchMock.mock.calls) expect(init?.headers?.Authorization).toBeUndefined();
  });


  it('keeps the public map preview when worker readiness cannot be fetched', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return response(503, { detail: 'worker endpoint offline' });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'San Francisco' });
    await screen.findByText(/2020 Census TIGERweb POP100/);
    expect(screen.getByText('SERVICE UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Estimate population in an area' })).not.toBeDisabled();
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
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ }));
    expect(screen.getByLabelText('Dataset')).toBeDisabled();
    expect(screen.getByLabelText('Task')).toBeDisabled();
    await user.click(screen.getByText('Upload GeoJSON'));
    expect(screen.getByLabelText(/Choose a GeoJSON file/i)).toBeDisabled();
    const post = fetchMock.mock.calls.find(([url, init]) => url === '/api/runs' && init?.method === 'POST');
    expect(JSON.parse(post[1].body).dataset_id).toBe('sf2020');
    pendingCreate.resolve(geojsonResponse({ id: 'run-pending', status: 'queued' }, 202));
    await screen.findByText('Access fixture complete.');
  });

  it('shows checking state, retries worker readiness without reloading the selected dataset, and updates the reason', async () => {
    const user = userEvent.setup();
    let checks = 0; let datasetRequests = 0;
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') { checks++; return checks === 1 ? response(503, { detail: 'worker still starting' }) : geojsonResponse({ ok: true, sandbox: 'runsc verified' }); }
      if (url === '/api/datasets/real') { datasetRequests++; return geojsonResponse(sfData); }
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'San Francisco' });
    expect(await screen.findByText('worker still starting')).toBeInTheDocument();
    expect(screen.getByText('SERVICE UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry check' }));
    await waitFor(() => expect(screen.getByText('ANALYSIS READY')).toBeInTheDocument());
    expect(screen.getByTitle('runsc verified')).toBeInTheDocument();
    expect(datasetRequests).toBe(1);
  });

  it('shows failed attempt diagnostics and only offers artifacts the server marked available', async () => {
    const user = userEvent.setup();
    const failedRun = { id: 'run-1', status: 'failed', analysis_mode: 'scenario', error: 'No population sample points fall inside the selected area. This dataset represents each population area with one point, so draw a larger area or upload finer local population data, then run again. No model request was made.', plan: 'plan exists', logs: [], artifacts: { 'trace.json': true, 'result.json': false, 'analysis.py': false }, attempts: [{ attempt: 1, status: 'failed', script_file: 'analysis-attempt-1.py', diagnostics: { message: 'Execution failed during the generated analysis.', stderr: 'NameError: missing value', stdout: '' } }] };
    const fetchMock = baseFetch({});
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/runs' && init.method === 'POST') return geojsonResponse({ id: 'run-1', status: 'queued' }, 202);
      if (url === '/api/runs/run-1') return geojsonResponse(failedRun);
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />); await ready();
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ }));
    await screen.findByText(/No population sample points fall inside the selected area/);
    expect(screen.getByRole('heading', { name: 'Choose a larger study area' })).toBeInTheDocument();
    expect(screen.getByText(/The land check did not run and no model request was made/)).toBeInTheDocument();
    expect(screen.getByText('NameError: missing value')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'trace.json ↓' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'result.json ↓' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'analysis.py ↓' })).not.toBeInTheDocument();
  });

  it('renders Pydantic validation details as a useful field-specific error', async () => {
    const user = userEvent.setup();
    const fetchMock = baseFetch({});
    fetchMock.mockImplementation(async (url, init = {}) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/runs' && init.method === 'POST') return response(422, { detail: [{ type: 'less_than', loc: ['body', 'threshold_m'], msg: 'Input should be less than 5000' }] });
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />); await ready();
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ }));
    expect(await screen.findByText('threshold_m: Input should be less than 5000')).toBeInTheDocument();
  });




  it('keeps the run action outside the scrolling controls pane', async () => {
    render(<App />);
    await ready();
    const controls = screen.getByRole('complementary', { name: 'Analysis controls' });
    const scroll = controls.querySelector('.controls-scroll');
    const run = screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ });
    expect(scroll).toBeTruthy();
    expect(scroll).not.toContainElement(run);
    expect(controls).toContainElement(run);
    expect(document.querySelector('.app-frame')).toBeTruthy();
  });

  it('puts outcome first in the results stage with ranked sites and collapsible context', async () => {
    const user = userEvent.setup();
    const area = [-122.433, 37.758, -122.417, 37.776];
    const ring = [[-122.426, 37.766], [-122.424, 37.766], [-122.424, 37.768], [-122.426, 37.768], [-122.426, 37.766]];
    const data = { type: 'FeatureCollection', scenario_status: 'simulated land inventory', features: [population(), { type: 'Feature', id: 'plot-a', properties: { layer: 'candidate_site' }, geometry: { type: 'Polygon', coordinates: [ring] } }] };
    const candidate = { id: 'plot-a', longitude: -122.425, latitude: 37.767, plot_area_m2: 400, nearest_existing_service_m: null, services_within_threshold: 0, footprint: { type: 'Polygon', coordinates: [ring] }, land_check: { source: 'Mock plot', setback_m: 3, plot_fit: true, area_fit: true, no_building_overlap: true, no_road_overlap: true, no_restriction_overlap: true } };
    const completed = { id: 'scenario-1', status: 'completed', analysis_mode: 'scenario', demo_mode: true, summary: 'Mock checks completed.', logs: [], result: { reference_verified: false, geometry_verified: true, metrics: { service_type: 'clinic', study_area: area, building: { width_m: 24, depth_m: 18, height_m: 12, setback_m: 3 }, eligible_sites: 1, sites_evaluated: 1, candidates: [candidate], site_checks: [], land_inventory: { source: 'SF mock', as_of: '2026-09-26' }, existing_services_in_area: 1, existing_service_counts: { clinic: 1 }, service_inventory: { source: 'OpenStreetMap mapped facilities', as_of: '2026-05-06' } } } };
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (url === '/api/config') return geojsonResponse({ ...config, scenario_demo: { id: 'localdemo' }, supported_modes: ['scenario'], demo_mode: true });
      if (url === '/api/worker-status') return geojsonResponse({ ok: true, mock: true });
      if (url === '/api/datasets/localdemo') return geojsonResponse(data);
      if (url === '/api/runs' && init.method === 'POST') return geojsonResponse({ id: 'scenario-1', status: 'queued' }, 202);
      if (url === '/api/runs/scenario-1') return geojsonResponse(completed);
      if (url === '/api/runs/scenario-1/map') return geojsonResponse({ type: 'FeatureCollection', features: [] });
      return response(404, {});
    }));
    render(<App />);
    await ready();
    await user.click(screen.getByRole('button', { name: /Design & compare|Check facility sites|Run the analysis/ }));
    const results = screen.getByLabelText('Results stage');
    await within(results).findByText(/1 of 1 plots fit/);
    expect(within(results).getByRole('heading', { name: 'Facility sites' })).toBeInTheDocument();
    expect(within(results).getByRole('heading', { name: 'Ranked sites' })).toBeInTheDocument();
    expect(within(results).getByRole('heading', { name: '3D view' })).toBeInTheDocument();
    expect(within(results).getByRole('heading', { name: 'Why Site 1 is ranked here' })).toBeInTheDocument();
    expect(within(results).getByText('Area context & limits')).toBeInTheDocument();
    expect(results.querySelector('.result-outcome')).not.toBeNull();
    expect(results.querySelector('.result-main')).not.toBeNull();
  });

  it('splits the workspace into controls, map stage, and results stage', async () => {
    render(<App />);
    await ready();
    expect(screen.getByRole('complementary', { name: 'Analysis controls' })).toBeInTheDocument();
    expect(screen.getByLabelText('Map stage')).toBeInTheDocument();
    expect(screen.getByLabelText('Results stage')).toBeInTheDocument();
    expect(screen.getByLabelText('Map and analysis results')).toBeInTheDocument();
    const results = screen.getByLabelText('Results stage');
    expect(results).toContainElement(screen.getByText('No results yet'));
    const mapStage = screen.getByLabelText('Map stage');
    expect(mapStage).toContainElement(screen.getByTestId('map-view'));
  });



  it('lists only scenario-capable datasets for facility sites and keeps city snapshots for compare', async () => {
    const user = userEvent.setup();
    const land = { type: 'FeatureCollection', name: 'East Harlem land', scenario_status: 'OFFICIAL_EXTRACT', features: [
      population('eh-p', 80),
      { type: 'Feature', id: 'lot-1', properties: { layer: 'candidate_site', land_status: 'available' }, geometry: { type: 'Polygon', coordinates: [[[-73.94, 40.80], [-73.939, 40.80], [-73.939, 40.801], [-73.94, 40.801], [-73.94, 40.80]]] } },
      { ...service, id: 'eh-clinic', properties: { layer: 'service', service_type: 'clinic', name: 'Clinic' }, geometry: { type: 'Point', coordinates: [-73.941, 40.799] } },
    ] };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse({
        ...config,
        nyc_land: { id: 'nycland', name: 'East Harlem lots', synthetic: false, scenario_capable: true },
        scenario_demo: { id: 'localdemo', name: 'SF mock', synthetic: true, scenario_capable: true },
        real: { id: 'sf2020', name: 'SF sample', synthetic: false, scenario_capable: false },
        nyc: { id: 'nyc2020', name: 'NYC sample', synthetic: false, scenario_capable: false },
        demo: { id: 'demo', name: 'Harborview', synthetic: true, scenario_capable: false },
      });
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/nycland') return geojsonResponse(land);
      if (url === '/api/datasets/localdemo') return geojsonResponse({ ...land, name: 'SF mock' });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      if (url === '/api/datasets/nyc2020') return geojsonResponse(sfData);
      if (url === '/api/datasets/demo') return geojsonResponse(demoData);
      return response(404, {});
    }));
    render(<App />);
    await screen.findByRole('heading', { name: 'East Harlem' });
    await ready();
    expect(screen.getByLabelText('Task')).toHaveValue('scenario');
    const scenarioOptions = [...screen.getByLabelText('Dataset').options].map((option) => option.value);
    expect(scenarioOptions).toEqual(['nycland', 'localdemo']);
    expect(screen.getByText(/Facility sites need parcel \+ land-check data/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Task'), 'compare');
    const compareOptions = [...screen.getByLabelText('Dataset').options].map((option) => option.value);
    expect(compareOptions).toEqual(['nycland', 'localdemo', 'nyc2020', 'sf2020', 'demo']);
  });

  it('features facility sites and compare, burying access and exposure as basic tools', async () => {
    const user = userEvent.setup();
    const scenarioData = {
      type: 'FeatureCollection',
      features: [
        population(),
        service,
        { type: 'Feature', id: 'plot-1', properties: { layer: 'candidate_site' }, geometry: { type: 'Polygon', coordinates: [[[-122.43, 37.77], [-122.429, 37.77], [-122.429, 37.771], [-122.43, 37.771], [-122.43, 37.77]]] } },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse({ ...config, scenario_demo: { id: 'localdemo', name: 'SF mock' }, supported_modes: ['scenario', 'access', 'compare', 'exposure'] });
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/localdemo') return geojsonResponse(scenarioData);
      return response(404, {});
    }));
    render(<App />);
    await ready();
    expect(screen.getByLabelText('Task')).toHaveValue('scenario');
    expect(screen.getByLabelText('Facility')).toHaveValue('clinic');
    const featured = [...screen.getByLabelText('Task').options].map((option) => option.value);
    expect(featured.filter((value) => value === 'scenario' || value === 'compare')).toEqual(['scenario', 'compare']);
    expect(featured).not.toContain('access');
    expect(featured).not.toContain('exposure');
    expect(screen.getByText(/More tools \(basic proximity \/ population\)/)).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
    await user.click(screen.getByText(/More tools \(basic proximity \/ population\)/));
    await user.selectOptions(screen.getByLabelText('Basic analysis'), 'access');
    expect(screen.getByLabelText('Task')).toHaveValue('access');
    await user.selectOptions(screen.getByLabelText('Task'), 'compare');
    expect(screen.getByText(/Compare two proposed locations/i)).toBeInTheDocument();
  });

  it('orders the workflow as task, dataset, study area, then run, and shows an empty results state', async () => {
    render(<App />);
    await ready();
    expect(screen.getByRole('heading', { name: 'Task' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dataset' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sites' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByText('No results yet')).toBeInTheDocument();
    expect(screen.getByLabelText('Task')).toHaveValue('compare');
    expect(screen.getByRole('option', { name: /Design & compare \(needs candidate plots\)/ })).toBeDisabled();
    expect([...screen.getByLabelText('Task').options].map((option) => option.value)).toEqual(['scenario', 'compare']);
  });

  it('explains why run is disabled when the analysis service is unavailable', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse(config);
      if (url === '/api/worker-status') return response(503, { detail: 'worker endpoint offline' });
      if (url === '/api/datasets/real') return geojsonResponse(sfData);
      return response(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: 'San Francisco' });
    expect(await screen.findByText(/Analysis service is unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ })).toBeDisabled();
  });

  it('lists community centre for facility siting and explains parks on compare', async () => {
    const user = userEvent.setup();
    const scenarioData = {
      type: 'FeatureCollection',
      features: [
        population(),
        service,
        { type: 'Feature', id: 'plot-1', properties: { layer: 'candidate_site' }, geometry: { type: 'Polygon', coordinates: [[[-122.43, 37.77], [-122.429, 37.77], [-122.429, 37.771], [-122.43, 37.771], [-122.43, 37.77]]] } },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/config') return geojsonResponse({ ...config, scenario_demo: { id: 'localdemo', name: 'SF mock' }, supported_modes: ['scenario', 'access', 'compare'] });
      if (url === '/api/worker-status') return geojsonResponse({ ok: true });
      if (url === '/api/datasets/localdemo') return geojsonResponse(scenarioData);
      return response(404, {});
    }));
    render(<App />);
    await ready();
    expect(screen.getByLabelText('Task')).toHaveValue('scenario');
    expect(screen.getByRole('option', { name: 'Community centre' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Task'), 'compare');
    expect(screen.getByText(/Park records count as services when the dataset includes them/i)).toBeInTheDocument();
  });

  it('labels completed findings with plain-language status pills', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', baseFetch());
    render(<App />);
    await ready();
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ }));
    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(screen.getByText(/people within walking-range threshold/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Design & compare|Check facility sites|Run the analysis/ }));
    await screen.findByText('sandbox unavailable');
    expect(screen.queryByText('Metrics and per-feature results matched a fixed GIS reference calculation.')).not.toBeInTheDocument();
  });
});

it('submits default agentic design and walking settings, shows unknown baseline honestly, and clears stale results', async () => {
  const user = userEvent.setup();
  const area = [-122.433,37.758,-122.417,37.776];
  const ring = [[-122.426,37.766],[-122.424,37.766],[-122.424,37.768],[-122.426,37.768],[-122.426,37.766]];
  const data = {type:'FeatureCollection',scenario_status:'simulated land inventory',features:[population(),{type:'Feature',id:'plot-a',properties:{layer:'candidate_site'},geometry:{type:'Polygon',coordinates:[ring]}}]};
  const candidate = {id:'plot-a',longitude:-122.425,latitude:37.767,plot_area_m2:400,footprint:{type:'Polygon',coordinates:[ring]},open_space:{type:'Polygon',coordinates:[ring]},building:{width_m:20,depth_m:15,height_m:9,setback_m:3,floors:3},design:{floors:3,gross_floor_area_m2:900,footprint_area_m2:300,total_open_area_m2:100,usable_open_area_m2:80,usable_open_space_pct:40,min_open_space_pct:40,strategy:'compact'},access:{status:'available',minutes:10,speed_mps:1.2,network_source:'supplied roads',network_as_of:'2026-09-26',baseline_known:false,estimated_population_total:50,compared_population:50,unmatched_population:0,before_served_population:null,after_served_population:10,newly_served_population:10,before_mean_minutes:null,after_mean_minutes:8.5,samples:[{id:'p1',longitude:-122.425,latitude:37.767,population:50,before_minutes:null,after_minutes:8.5,status:'newly_served'}],routes:[]}};
  const completed = {id:'scenario-1',status:'completed',analysis_mode:'scenario',demo_mode:true,summary:'Three checked designs.',plan:'Walking access compared against design.',logs:[],result:{reference_verified:false,geometry_verified:true,metrics:{service_type:'clinic',study_area:area,design:{target_floor_area_m2:900,max_floors:3,min_open_space_pct:40,setback_m:3},eligible_sites:1,sites_evaluated:1,sites_available:4,existing_services_in_area:1,candidates:[candidate],site_checks:[],land_inventory:{source:'SF mock',as_of:'2026-09-26'}}}};
  const mock = vi.fn(async (url,init={})=>{
    if(url==='/api/config') return response(200,{...config,scenario_demo:{id:'localdemo'},supported_modes:['scenario'],demo_mode:true});
    if(url==='/api/worker-status') return response(200,{ok:true,mock:true});
    if(url==='/api/datasets/localdemo') return response(200,data);
    if(url==='/api/runs' && init.method==='POST') return response(202,{id:'scenario-1',status:'queued'});
    if(url==='/api/runs/scenario-1') return response(200,completed);
    if(url==='/api/runs/scenario-1/map') return response(200,{type:'FeatureCollection',features:[]});
    return response(404,{});
  });
  vi.stubGlobal('fetch',mock); render(<App/>); await ready();
  expect(screen.getByLabelText('Task')).toHaveValue('scenario');
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.queryByLabelText('Width (m)')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:/Design & compare/}));
  const results=screen.getByLabelText('Results stage');
  expect(await within(results).findByText('1 checked designs')).toBeInTheDocument();
  expect(within(results).getByRole('heading',{name:'Design & compare'})).toBeInTheDocument();
  expect(within(results).getByRole('heading',{name:'Ranked designs'})).toBeInTheDocument();
  expect(within(results).getByText(/Before access and change are unknown because no connected facility inventory was supplied/i)).toBeInTheDocument();
  expect(within(results).getAllByText('N/A',{selector:'.metric .value'}).length).toBeGreaterThan(0);
  expect(results.querySelector('.existing-facility-count')?.textContent).toMatch(/Already nearby: 1 mapped clinic/);
  expect(within(results).getAllByText('N/A').length).toBeGreaterThan(0);
  expect(within(results).getByText(/Walking network: supplied roads · 2026-09-26/)).toBeInTheDocument();
  await user.click(within(results).getByText('Technical details and files'));
  await user.click(within(results).getByText('Analysis method'));
  expect(within(results).getByText(/Walking times are estimated on the supplied street network/)).toBeInTheDocument();
  expect(within(results).getByText(/Submitted designs rank by verified land and walking outcomes/)).toBeInTheDocument();
  expect(within(results).getByText('40%',{selector:'.rank-pop'})).toBeInTheDocument();
  expect(await within(results).findByTestId('scenario-3d')).toHaveTextContent('plot-a');
  const post=mock.mock.calls.find(([url,init])=>url==='/api/runs' && init.method==='POST');
  const payload=JSON.parse(post[1].body);
  expect(payload).toMatchObject({analysis_mode:'scenario',study_area:area,service_type:'clinic',design:{target_floor_area_m2:900,max_floors:3,min_open_space_pct:40,setback_m:3},walk:{minutes:10,speed_mps:1.2,max_snap_m:100}});
  expect(payload).not.toHaveProperty('building');
  await user.click(within(results).getByRole('button',{name:'Before'}));
  expect(within(results).getByRole('button',{name:'Before'})).toHaveAttribute('aria-pressed','true');
  expect(within(results).getByText(/proposed building and reserved open space are hidden/i)).toBeInTheDocument();
  await user.clear(screen.getByLabelText(/Target floor area/));
  await user.type(screen.getByLabelText(/Target floor area/),'1000');
  expect(screen.queryByTestId('scenario-3d')).not.toBeInTheDocument();
  expect(screen.queryByText('Three checked designs.')).not.toBeInTheDocument();
});
