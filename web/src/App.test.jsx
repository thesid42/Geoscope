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
  await waitFor(() => expect(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ })).toBeEnabled());
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
    const run = screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ });
    expect(run).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Estimate population in an area' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Population + places or zones'), 'demo');
    await screen.findByRole('heading', { name: 'Harborview · synthetic fixture' });
    expect(screen.getByRole('option', { name: 'Estimate population in an area' })).not.toBeDisabled();
    await waitFor(() => expect(run).toBeEnabled());
    oldRequest.resolve(geojsonResponse(sfData));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('heading', { name: 'Harborview · synthetic fixture' })).toBeInTheDocument();
    expect(screen.getByText(/1 population areas · 1 services · 1 zones · 0 candidate plots/)).toBeInTheDocument();
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
    await screen.findByRole('heading', { name: 'San Francisco · simulated scenario land' });
    await ready();
    await user.selectOptions(screen.getByLabelText('What do you want to find out?'), 'compare');
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
    await user.selectOptions(screen.getByLabelText('Population + places or zones'), 'demo');
    await screen.findByRole('heading', { name: 'Harborview · synthetic fixture' });
    await user.selectOptions(screen.getByLabelText('What do you want to find out?'), 'exposure');
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ }));
    await screen.findByText('Zero-population test result.');
    const exposurePost = fetchMock.mock.calls.find(([url, init]) => url === '/api/runs' && init?.method === 'POST');
    expect(JSON.parse(exposurePost[1].body).analysis_mode).toBe('exposure');
    expect(JSON.parse(exposurePost[1].body).study_area).toHaveLength(4);
    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
    expect(screen.getByText('share of total population')).toBeInTheDocument();
    // A new run starts from a clean result view even if the next poll cannot be read.
    await user.selectOptions(screen.getByLabelText('What do you want to find out?'), 'access');
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ }));
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
    await screen.findByRole('heading', { name: 'San Francisco · 2020 Census + selected parks' });
    await ready();
    await user.selectOptions(screen.getByLabelText('What do you want to find out?'), 'exposure');
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
    await user.click(screen.getByText('Use your own data'));
    await user.upload(screen.getByLabelText(/Choose a GeoJSON file/i), file);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/datasets' && init?.method === 'POST')).toBe(true));
    await screen.findByText('fixture.geojson');
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ }));
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
    await screen.findByRole('heading', { name: 'San Francisco · 2020 Census + selected parks' });
    await screen.findByText(/1 population areas/);
    expect(screen.getByText('WORKER UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ })).toBeDisabled();
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
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ }));
    expect(screen.getByLabelText('Population + places or zones')).toBeDisabled();
    expect(screen.getByLabelText('What do you want to find out?')).toBeDisabled();
    await user.click(screen.getByText('Use your own data'));
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
    await screen.findByRole('heading', { name: 'San Francisco · 2020 Census + selected parks' });
    expect(await screen.findByText('worker still starting')).toBeInTheDocument();
    expect(screen.getByText('WORKER UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry check' }));
    await waitFor(() => expect(screen.getByText('WORKER READY')).toBeInTheDocument());
    expect(screen.getByText('runsc verified')).toBeInTheDocument();
    expect(datasetRequests).toBe(1);
  });

  it('shows failed attempt diagnostics and only offers artifacts the server marked available', async () => {
    const user = userEvent.setup();
    const failedRun = { id: 'run-1', status: 'failed', analysis_mode: 'access', error: 'analysis failed', plan: 'plan exists', logs: [], artifacts: { 'trace.json': true, 'result.json': false, 'analysis.py': false }, attempts: [{ attempt: 1, status: 'failed', script_file: 'analysis-attempt-1.py', diagnostics: { message: 'Execution failed during the generated analysis.', stderr: 'NameError: missing value', stdout: '' } }] };
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
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ }));
    await screen.findByText('analysis failed');
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
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ }));
    expect(await screen.findByText('threshold_m: Input should be less than 5000')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/ }));
    await screen.findByText('sandbox unavailable');
    expect(screen.queryByText('Metrics and per-feature results matched a fixed GIS reference calculation.')).not.toBeInTheDocument();
  });
});

it('submits the SF mock scenario without a token, shows checked proposals, and invalidates changed dimensions', async () => {
  const user = userEvent.setup();
  const area = [-122.433,37.758,-122.417,37.776];
  const ring = [[-122.426,37.766],[-122.424,37.766],[-122.424,37.768],[-122.426,37.768],[-122.426,37.766]];
  const data = {type:'FeatureCollection',scenario_status:'simulated land inventory',features:[population(),{type:'Feature',id:'plot-a',properties:{layer:'candidate_site'},geometry:{type:'Polygon',coordinates:[ring]}}]};
  const candidate = {id:'plot-a',longitude:-122.425,latitude:37.767,newly_served_population:50,served_population:50,footprint:{type:'Polygon',coordinates:[ring]},land_check:{source:'Mock plot',setback_m:3}};
  const completed = {id:'scenario-1',status:'completed',analysis_mode:'scenario',demo_mode:true,summary:'Mock checks completed.',logs:[],result:{reference_verified:false,geometry_verified:true,metrics:{service_type:'clinic',study_area:area,building:{width_m:24,depth_m:18,height_m:12,setback_m:3},eligible_sites:1,sites_evaluated:1,population_total:50,baseline:{weighted_mean_nearest_m:null},candidates:[candidate],site_checks:[],land_inventory:{source:'SF mock',as_of:'2026-09-26'},inventory_status:'no matching service inventory supplied',existing_services_in_area:1,existing_service_counts:{clinic:1,library:0,school:0,community_center:0},service_inventory:{source:'OpenStreetMap mapped facilities',as_of:'2026-05-06',completeness_by_type:{clinic:'unknown'}}}}};
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
  expect(screen.getByLabelText('What do you want to find out?')).toHaveValue('scenario');
  expect(screen.queryByLabelText('Analysis access key')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:/Find nearby services|Compare locations|Estimate population|Check facility sites|Run the analysis/}));
  await user.click(await screen.findByText('Technical details and files'));
  await user.click(screen.getByText('Agent explanation'));
  await screen.findByText('Mock checks completed.');
  expect(await screen.findByTestId('scenario-3d')).toHaveTextContent('plot-a');
  expect(screen.getByText('1 mapped clinic')).toBeInTheDocument();
  expect(screen.getByText(/Source: OpenStreetMap/)).toBeInTheDocument();
  expect(screen.getByText(/simulated plots checked against mapped buildings and road corridors, alongside mapped facility records/)).toBeInTheDocument();
  const post=mock.mock.calls.find(([url,init])=>url==='/api/runs' && init.method==='POST');
  expect(JSON.parse(post[1].body)).toMatchObject({analysis_mode:'scenario',study_area:area,service_type:'clinic',building:{width_m:24,depth_m:18,height_m:12,setback_m:3}});
  expect(post[1].headers.Authorization).toBeUndefined();
  await user.click(screen.getByText(/Adjust building size/));
  await user.clear(screen.getByLabelText('Width (m)'));
  await user.type(screen.getByLabelText('Width (m)'), '30');
  expect(screen.queryByTestId('scenario-3d')).not.toBeInTheDocument();
  expect(screen.queryByText('Mock checks completed.')).not.toBeInTheDocument();
});
