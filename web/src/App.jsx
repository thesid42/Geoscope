import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LeafletMap from './components/LeafletMap.jsx';
import { validateBuilding, validateStudyArea } from './scenario.js';
const ScenarioViewer = lazy(() => import('./components/ScenarioViewer.jsx'));

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const COPY = { access: 'Which population areas are farthest from the nearest service, and how many residents are within 400 meters?', compare: 'Which candidate serves more residents within 400 meters, and how much does each reduce average distance?', exposure: 'What population estimate falls inside the selected study area, and how much falls outside?', scenario: 'Which supplied plots meet the requested facility and clearance rules, and how do eligible sites compare?' };
const MODES = [['access', 'Find nearby services'], ['compare', 'Compare two locations'], ['exposure', 'Estimate population in an area'], ['scenario', 'Check facility sites']];
const SERVICE_TYPES = [['clinic', 'Clinic'], ['library', 'Library'], ['school', 'School'], ['community_center', 'Community center']];
const DEFAULT_BUILDING = { width_m: 24, depth_m: 18, height_m: 12, setback_m: 3 };
const roleOf = (f) => f?.properties?.layer === 'park' ? 'service' : f?.properties?.layer;
const defaultCandidates = (id, dataset) => {
  if (id === 'sf2020' || id === 'localdemo') return [[-122.43, 37.77], [-122.42, 37.76]];
  let west = Infinity; let east = -Infinity; let south = Infinity; let north = -Infinity;
  for (const feature of dataset?.features ?? []) {
    const stack = [feature.geometry?.coordinates];
    while (stack.length) {
      const value = stack.pop();
      if (!Array.isArray(value)) continue;
      if (typeof value[0] === 'number' && typeof value[1] === 'number') {
        west = Math.min(west, value[0]); east = Math.max(east, value[0]);
        south = Math.min(south, value[1]); north = Math.max(north, value[1]);
      } else for (const child of value) stack.push(child);
    }
  }
  if (![west, east, south, north].every(Number.isFinite)) return [[0, 0], [0.001, 0.001]];
  const centerX = (west + east) / 2; const centerY = (south + north) / 2;
  const dx = Math.max((east - west) * 0.18, 0.0001); const dy = Math.max((north - south) * 0.18, 0.0001);
  return [[Math.max(west, centerX - dx), Math.max(south, centerY - dy)], [Math.min(east, centerX + dx), Math.min(north, centerY + dy)]];
};
function datasetExtent(dataset) {
  let west = Infinity; let east = -Infinity; let south = Infinity; let north = -Infinity;
  for (const feature of dataset?.features ?? []) {
    const stack = [feature.geometry?.coordinates];
    while (stack.length) {
      const value = stack.pop();
      if (!Array.isArray(value)) continue;
      if (typeof value[0] === 'number' && typeof value[1] === 'number') {
        west = Math.min(west, value[0]); east = Math.max(east, value[0]);
        south = Math.min(south, value[1]); north = Math.max(north, value[1]);
      } else for (const child of value) stack.push(child);
    }
  }
  return [west, south, east, north].every(Number.isFinite) ? [west, south, east, north] : null;
}
function defaultStudyArea(id, dataset) {
  if (id === 'localdemo' || id === 'sf2020') return [-122.433, 37.758, -122.417, 37.776];
  const extent = datasetExtent(dataset);
  if (!extent) return null;
  const [west, south, east, north] = extent; const cx = (west + east) / 2; const cy = (south + north) / 2;
  const dx = Math.min(Math.max((east - west) * 0.18, 0.003), 0.03);
  const dy = Math.min(Math.max((north - south) * 0.18, 0.003), 0.03);
  return [cx - dx, cy - dy, cx + dx, cy + dy].map((value) => Number(value.toFixed(6)));
}
function areaDimensions(area) {
  if (!area?.every(Number.isFinite)) return null;
  const [west, south, east, north] = area;
  const radians = (value) => value * Math.PI / 180;
  const distance = (lon1, lat1, lon2, lat2) => {
    const dLat = radians(lat2 - lat1); const dLon = radians(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const midLon = (west + east) / 2; const midLat = (south + north) / 2;
  const format = (meters) => meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  return `${format(distance(west, midLat, east, midLat))} by ${format(distance(midLon, south, midLon, north))}`;
}
function formatDetail(detail) {
  const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 400);
  if (typeof detail === 'string') return clean(detail) || 'Request failed.';
  if (Array.isArray(detail)) {
    const messages = detail.slice(0, 5).map((item) => {
      if (typeof item === 'string') return clean(item);
      const location = Array.isArray(item?.loc) ? item.loc.filter((part) => !['body', 'query', 'path'].includes(part)).join('.') : '';
      const message = clean(item?.msg ?? item?.message ?? 'Invalid value.');
      return location ? `${clean(location)}: ${message}` : message;
    }).filter(Boolean);
    return messages.join(' · ') || 'Request validation failed.';
  }
  return clean(detail?.msg ?? detail?.message ?? 'Request failed.') || 'Request failed.';
}
async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(formatDetail(payload?.detail) || `Request failed (${response.status}).`);
  return payload;
}
function MetricCard({ value, label }) { return <div className="metric"><div className="value">{value}</div><div className="label">{label}</div></div>; }
function CandidateInput({ letter, candidate, onChange, disabled = false }) {
  const kind = letter.toLowerCase();
  return <div className="candidate-row"><span className={`candidate-tag ${kind}`}>{letter}</span><label htmlFor={`candidate-${kind}-lon`}>Candidate {letter}</label><div className="coordinate">
    <input id={`candidate-${kind}-lon`} type="number" step="0.0001" value={candidate[0]} disabled={disabled} aria-label={`Candidate ${letter} longitude`} onChange={(e) => onChange([e.target.value, candidate[1]])} />
    <input id={`candidate-${kind}-lat`} type="number" step="0.0001" value={candidate[1]} disabled={disabled} aria-label={`Candidate ${letter} latitude`} onChange={(e) => onChange([candidate[0], e.target.value])} />
  </div></div>;
}
function RunTechnicalDetails({ run, files, onDownload, downloadError, failed, verified }) {
  if (!run.plan && !run.summary && !files.length && !run.attempts?.length && !run.logs?.length) return null;
  return <details className="technical-details" open={failed}>
    <summary>Technical details and files</summary>
    {run.summary && <details><summary>Agent explanation</summary><p>{run.summary}</p></details>}
    {run.plan && <details><summary>Analysis method</summary><pre>{run.plan}</pre><ul className="caveats">
      {verified && <li>Metrics and per-feature results matched a fixed GIS reference calculation.</li>}
      <li>Distances are straight-line; population-area representative points are a proxy.</li>
      <li>{run.analysis_mode === 'exposure' ? 'Each census area’s full population estimate is assigned by its representative point. This is an estimate for the drawn area, not an exact resident count.' : run.analysis_mode === 'compare' ? 'Candidate ranking is based on newly served population within the selected threshold.' : 'Population proximity is not a walking route or a measure of actual access.'}</li>
      <li>{run.synthetic ? 'Synthetic fixture only; not real-world evidence.' : `Source: ${run.dataset_name}.`}</li>
    </ul></details>}
    {files.length > 0 && <div className="downloads">{files.map((name) => <button className="download-link" type="button" key={name} onClick={() => onDownload(run.id, name)}>{name} ↓</button>)}{downloadError && <span role="alert" className="download-error">{downloadError}</span>}</div>}
    {run.attempts?.length > 0 && <details className="trace attempt-diagnostics" open={failed}><summary>Execution diagnostics ({run.attempts.length} attempts)</summary>{run.attempts.map((attempt, index) => <section key={`${attempt.attempt ?? index}-${attempt.script_file ?? index}`}><b>Attempt {attempt.attempt ?? index + 1} · {attempt.status || 'unknown'}</b>{attempt.script_file && <p>Script: {attempt.script_file}</p>}{(attempt.diagnostics?.message || attempt.message || attempt.stderr) && <p>{attempt.diagnostics?.message || attempt.message}</p>}{(attempt.diagnostics?.stderr || attempt.stderr) && <pre aria-label={`Attempt ${attempt.attempt ?? index + 1} stderr`}>{attempt.diagnostics?.stderr || attempt.stderr}</pre>}{(attempt.diagnostics?.stdout || attempt.stdout) && <pre aria-label={`Attempt ${attempt.attempt ?? index + 1} stdout`}>{attempt.diagnostics?.stdout || attempt.stdout}</pre>}</section>)}</details>}
    {run.logs?.length > 0 && <details className="trace"><summary>Run trace</summary><div id="logs">{run.logs.map((log, i) => <div className="log-row" key={`${log.time ?? i}-${i}`}><b>{(log.status || 'step').toUpperCase()}</b> · {log.text}</div>)}</div></details>}
  </details>;
}
function ResultsPanel({ run, onDownload, downloadError, dataset, selectedScenarioCandidate, onSelectScenarioCandidate }) {
  if (!run) return null;
  const m = run.result?.metrics ?? {};
  const failed = ['failed', 'interrupted'].includes(run.status);
  const files = Object.entries(run.artifacts ?? {}).filter(([name, available]) => available === true && /^(analysis\.py|result\.json|result\.geojson|request\.json|trace\.json|analysis-attempt-[1-3]\.py)$/.test(name)).map(([name]) => name);
  const verified = run.status === 'completed' && (run.result?.reference_verified === true || (run.demo_mode === true && run.result?.geometry_verified === true));
  const n = (x) => x == null ? 'N/A' : Number(x).toLocaleString();
  const d = (x) => x == null ? 'N/A' : `${Number(x).toFixed(0)} m`;
  const facilityName = ({ clinic: 'clinic', library: 'library', school: 'school', community_center: 'community center' })[m.service_type] || 'facility';
  const pluralFacility = ({ clinic: 'clinics', library: 'libraries', school: 'schools', community_center: 'community centers' })[m.service_type] || 'facilities';
  if (run.status === 'completed' && run.result && run.analysis_mode === 'scenario' && verified) {
    const gross = m.inventory_status === 'no matching service inventory supplied';
    const best = selectedScenarioCandidate ?? m.candidates?.[0] ?? null;
    const existingCount = m.existing_services_in_area ?? m.existing_service_counts?.[m.service_type] ?? null;
    const inventory = m.service_inventory ?? {};
    const inventoryLabel = String(inventory.source ?? '').includes('OpenStreetMap') ? 'OpenStreetMap' : inventory.source || 'source not recorded';
    const scenarioStatus = String(dataset?.scenario_status ?? '').toLowerCase();
    const landIsSimulated = scenarioStatus.includes('simulat') || scenarioStatus.includes('mock') || String(m.land_inventory?.source ?? '').toLowerCase().includes('simulat');
    return <div className="result-panel">
      <div className="result-top"><div><div className="eyebrow">{run.demo_mode ? 'SF MOCK SIMULATION · LOCAL FIXED REFERENCE' : 'VERIFIED SCENARIO'}</div><h2>Facility site results</h2></div><span className="status-pill">{run.demo_mode ? 'mock · geometry checked' : 'checked'}</span></div>
      {run.demo_mode && <p className="scenario-demo-banner">SF MOCK SIMULATION — local fixed-reference calculation; no cloud agent run.</p>}
      <div className="scenario-headline"><strong>{n(m.eligible_sites)} of {n(m.sites_evaluated)} plots fit</strong><span>Building footprint checked against supplied plot, area, and obstruction layers.</span></div>
      {best && <div className="scenario-best"><b>Site {(m.candidates ?? []).findIndex((candidate) => candidate.id === best.id) + 1}</b><span>{gross ? 'Covered by proposal' : `+${n(best.newly_served_population)} estimated people within ${n(m.threshold_m)} m`}</span></div>}
      {!gross && m.candidates?.length > 0 && m.candidates.every((site) => site.newly_served_population === 0) && <p className="scenario-caveat">These plots fit, but none adds estimated population coverage at this distance. A building that fits is not automatically needed.</p>}
      <div className="scenario-existing-service"><b>Already in this area</b><strong>{n(existingCount)} mapped {existingCount === 1 ? facilityName : pluralFacility}</strong><span>Mapped records of this facility type. Coverage may be incomplete; missing records do not prove a service is absent.</span>{(inventory.source || inventory.as_of) && <small>Source: {inventoryLabel}{inventory.as_of ? ` · ${inventory.as_of}` : ''}</small>}{m.existing_service_counts && <details><summary>Counts by facility type</summary><p>{Object.entries(m.existing_service_counts).map(([type, count]) => `${type.replaceAll('_', ' ')}: ${n(count)}`).join(' · ')}</p></details>}</div>
      <p className="scenario-caveat">Population is an estimate from census-area representative points. Facility services and land evidence are {landIsSimulated ? 'simulated plots and obstructions, alongside mapped facility records' : 'limited to supplied records'}; this does not establish real land availability, ownership, zoning approval, or permits.</p>
      <h3 className="scenario-subhead">Best eligible sites</h3>
      {m.candidates?.length ? <div className="scenario-rankings">{m.candidates.map((candidate, index) => <button type="button" className={`scenario-rank${best?.id === candidate.id ? ' selected' : ''}`} key={candidate.id} onClick={() => onSelectScenarioCandidate(candidate)}>
        <span className="rank-number">{index + 1}</span><span className="rank-main"><b>Site {index + 1}</b><small>Plot {candidate.id} · fit verified · {candidate.land_check?.setback_m ?? '—'} m clearance</small></span><span className="rank-pop">{n(gross ? candidate.served_population : candidate.newly_served_population)}<small>{gross ? 'estimated covered' : 'estimated additional'}</small></span>
      </button>)}</div> : <p>No eligible supplied plot passed the requested footprint checks. No building placement is shown.</p>}
      {(m.site_checks?.length > 0 || m.land_inventory) && <details className="scenario-sources"><summary>Land checks and sources</summary>{m.land_inventory && <div><b>Supplied land evidence · {m.land_inventory.as_of || 'date not recorded'}</b><p>{m.land_inventory.source || 'Source not recorded'}</p></div>}{m.site_checks?.length > 0 && <ul className="site-checks">{m.site_checks.map((site) => <li key={site.id}><b>{site.id}: {site.status}</b> · {site.reason} <span>Evidence: {site.source || 'not supplied'}</span></li>)}</ul>}</details>}
      {best && <Suspense fallback={<div role="status">Preparing 3D footprint view…</div>}><ScenarioViewer area={m.study_area} candidate={best} building={m.building} serviceType={m.service_type} dataset={dataset} /></Suspense>}
      <RunTechnicalDetails run={run} files={files} onDownload={onDownload} downloadError={downloadError} failed={failed} verified={verified} />
    </div>;
  }
  let cards = [];
  const title = failed ? 'Run stopped' : ({ access: 'Nearby services', compare: 'Site comparison', exposure: 'Population estimate', scenario: 'Facility scenario' }[run.analysis_mode] ?? 'GIS analysis');
  if (run.status === 'completed' && run.result) {
    if (run.analysis_mode === 'exposure') cards = [
      <MetricCard key="inside" value={n(m.inside_population)} label="estimated population inside area" />,
      <MetricCard key="share" value={m.share_inside_pct == null ? 'N/A' : `${Number(m.share_inside_pct).toFixed(1)}%`} label="share of total population" />,
      <MetricCard key="outside" value={n(m.outside_population)} label="estimated population outside area" />,
    ];
    else if (run.analysis_mode === 'compare') cards = [
      <MetricCard key="a" value={n(m.candidate_a?.newly_served_population)} label="A · newly served" />,
      <MetricCard key="b" value={n(m.candidate_b?.newly_served_population)} label="B · newly served" />,
      <MetricCard key="preferred" value={run.result.comparison?.preferred_candidate ?? 'Tie'} label="preferred by newly served population" />,
    ];
    else cards = [
      <MetricCard key="served" value={n(m.baseline?.served_population)} label="population within threshold" />,
      <MetricCard key="underserved" value={n(m.baseline?.underserved_population)} label="population beyond threshold" />,
      <MetricCard key="distance" value={d(m.baseline?.weighted_mean_nearest_m)} label="weighted mean distance" />,
    ];
  }
  const headline = failed ? (run.error || run.summary || 'The analysis could not be completed.') : run.status === 'completed' && run.analysis_mode === 'exposure' ? `${n(m.inside_population)} estimated people inside the selected area` : run.status === 'completed' && run.analysis_mode === 'compare' ? `Site ${run.result?.comparison?.preferred_candidate ?? 'tie'} is preferred` : run.status === 'completed' ? `${n(m.baseline?.served_population)} estimated people within ${n(m.threshold_m ?? run.threshold_m)} m` : 'Your analysis is running.';
  return <div className="result-panel">
    <div className="result-top"><div><div className="eyebrow">{verified ? 'CHECKED FINDINGS' : 'ANALYSIS STATUS'}</div><h2>{title}</h2></div><span className={`status-pill${failed ? ' failed' : ''}`}>{run.status}</span></div>
    <p id="summary" className="result-headline">{headline}</p>
    {run.status === 'completed' && <p className="result-caveat">Population estimates use census-area representative points; this is not an exact address-level count. Service distances are straight-line, not routes.</p>}
    {cards.length > 0 && <div className="metrics">{cards}</div>}
    <RunTechnicalDetails run={run} files={files} onDownload={onDownload} downloadError={downloadError} failed={failed} verified={verified} />
  </div>;
}
export default function App() {
  useEffect(() => { try { window.sessionStorage.removeItem("geoscope_access_key"); } catch { /* No browser-stored bearer remains. */ } }, []);
  const [config, setConfig] = useState(null);
  const [worker, setWorker] = useState({ ok: false, status: 'checking', message: 'Checking worker readiness…' });
  const [workerRefresh, setWorkerRefresh] = useState(0);
  const [datasetId, setDatasetId] = useState('');
  const [dataset, setDataset] = useState(null);
  const [datasetLoading, setDatasetLoading] = useState(true);
  const [datasetError, setDatasetError] = useState('');
  const [uploadedNames, setUploadedNames] = useState({});
  const [mode, setMode] = useState('access');
  const [threshold, setThreshold] = useState(400);
  const [studyArea, setStudyArea] = useState(null);
  const [areaSelectionActive, setAreaSelectionActive] = useState(false);
  const [serviceType, setServiceType] = useState('clinic');
  const [building, setBuilding] = useState(DEFAULT_BUILDING);
  const [selectedScenarioCandidate, setSelectedScenarioCandidate] = useState(null);
  const [candidateA, setCandidateA] = useState([-122.43, 37.77]);
  const [candidateB, setCandidateB] = useState([-122.42, 37.76]);
  const [question, setQuestion] = useState(COPY.access);
  const [questionEdited, setQuestionEdited] = useState(false);
  const [run, setRun] = useState(null);
  const [activeRunId, setActiveRunId] = useState(null);
  const [resultMap, setResultMap] = useState(null);
  const [resultMapError, setResultMapError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [runStarting, setRunStarting] = useState(false);
  const datasetRevision = useRef(0);
  const activeRunIdRef = useRef(null);
  const schema = useMemo(() => {
    if (!dataset) return null;
    const counts = { population_features: 0, service_features: 0, zone_features: 0, candidate_site_features: 0 };
    for (const feature of dataset.features ?? []) {
      const role = roleOf(feature);
      if (role === 'population') counts.population_features++;
      if (role === 'service') counts.service_features++;
      if (role === 'zone') counts.zone_features++;
      if (role === 'candidate_site') counts.candidate_site_features++;
    }
    return counts;
  }, [dataset]);
  const scenarioResultAllowed = Boolean(run?.status === 'completed' && run.analysis_mode === 'scenario' && (run.result?.reference_verified === true || (run.demo_mode === true && run.result?.geometry_verified === true)));
  const scenarioCandidates = useMemo(() => scenarioResultAllowed ? (run.result?.metrics?.candidates ?? []).map((candidate, index) => ({ ...candidate, rank: index + 1 })) : [], [scenarioResultAllowed, run?.result?.metrics?.candidates]);
  const selectScenarioCandidate = useCallback((candidate) => setSelectedScenarioCandidate(candidate), []);
  const modeAllowed = (key, source = schema) => source && (!config?.supported_modes || config.supported_modes.includes(key)) && (key === 'scenario' ? source.candidate_site_features > 0 : key === 'exposure' ? source.population_features > 0 : source.service_features > 0);
  const canRun = Boolean(config?.analysis_enabled && worker.ok && dataset && !datasetLoading && !runStarting && !activeRunId && !uploading && !areaSelectionActive && modeAllowed(mode) && (mode === 'exposure' ? !validateStudyArea(studyArea) : mode !== 'scenario' || (!validateStudyArea(studyArea) && !validateBuilding(building))));

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const c = await readJson(await fetch('/api/config', { signal: controller.signal }));
        setConfig(c);
        setDatasetId(c.scenario_demo?.id ?? c.real?.id ?? c.demo?.id ?? 'demo');
      } catch (error) {
        if (error.name !== 'AbortError') { setDatasetError(error.message || 'Service configuration is unavailable.'); setWorker({ ok: false, status: 'unavailable', message: 'Service status unavailable.' }); }
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let disposed = false; let checking = false; let requestController = null;
    const checkWorker = async () => {
      if (disposed || checking) return;
      checking = true; requestController = new AbortController();
      const timeout = window.setTimeout(() => requestController?.abort(), 5000);
      try {
        const status = await readJson(await fetch('/api/worker-status', { signal: requestController.signal }));
        if (!disposed) setWorker({ ...status, ok: Boolean(status.ok), status: status.ok ? 'ready' : 'unavailable', message: status.message || (typeof status.sandbox === 'string' ? status.sandbox : status.sandbox?.reason) || (status.ok ? 'Analysis worker is ready.' : 'Analysis worker is not ready.') });
      } catch (error) {
        if (!disposed) setWorker({ ok: false, status: 'unavailable', message: error.name === 'AbortError' ? 'Worker readiness check timed out.' : error.message || 'Worker status could not be checked.' });
      } finally { window.clearTimeout(timeout); requestController = null; checking = false; }
    };
    checkWorker();
    const interval = window.setInterval(checkWorker, 15000);
    return () => { disposed = true; window.clearInterval(interval); requestController?.abort(); };
  }, [workerRefresh]);
  useEffect(() => {
    if (!datasetId) return undefined;
    const controller = new AbortController();
    const revision = ++datasetRevision.current;
    const url = datasetId === 'demo' ? '/api/datasets/demo' : datasetId === 'sf2020' ? '/api/datasets/real' : `/api/datasets/${encodeURIComponent(datasetId)}`;
    setDatasetLoading(true); setDatasetError(''); setDataset(null); setRun(null); setActiveRunId(null);
    activeRunIdRef.current = null; setResultMap(null); setResultMapError(''); setDownloadError('');
    setCandidateA(defaultCandidates(datasetId)[0]); setCandidateB(defaultCandidates(datasetId)[1]); setThreshold(400); setStudyArea(null); setAreaSelectionActive(false); setSelectedScenarioCandidate(null); setBuilding(DEFAULT_BUILDING);
    fetch(url, { signal: controller.signal }).then(readJson).then((data) => {
      if (revision !== datasetRevision.current) return;
      setDataset(data);
      const suggestions = defaultCandidates(datasetId, data); setCandidateA(suggestions[0]); setCandidateB(suggestions[1]);
      setStudyArea(defaultStudyArea(datasetId, data));
      const plotCoordinates = (data.features ?? []).filter((f) => roleOf(f) === 'candidate_site').flatMap((f) => { const out = []; const walk = (v) => Array.isArray(v) && (typeof v[0] === 'number' ? out.push(v) : v.forEach(walk)); walk(f.geometry?.coordinates); return out; });
      if (datasetId === 'localdemo') setStudyArea([-122.433, 37.758, -122.417, 37.776]);
      else if (plotCoordinates.length) { const centerLon = plotCoordinates.reduce((sum, point) => sum + point[0], 0) / plotCoordinates.length; const centerLat = plotCoordinates.reduce((sum, point) => sum + point[1], 0) / plotCoordinates.length; setStudyArea([centerLon - 0.005, centerLat - 0.005, centerLon + 0.005, centerLat + 0.005].map((v) => Number(v.toFixed(6)))); }
      setMode((previous) => {
        const nextSchema = { population_features: data.features?.filter((f) => roleOf(f) === 'population').length ?? 0, service_features: data.features?.filter((f) => roleOf(f) === 'service').length ?? 0, zone_features: data.features?.filter((f) => roleOf(f) === 'zone').length ?? 0, candidate_site_features: data.features?.filter((f) => roleOf(f) === 'candidate_site').length ?? 0 };
        const supported = config?.supported_modes ?? MODES.map(([id]) => id);
        const usable = (candidate) => supported.includes(candidate) && (candidate === 'scenario' ? nextSchema.candidate_site_features > 0 : candidate === 'exposure' ? nextSchema.population_features > 0 : nextSchema.service_features > 0);
        if (datasetId === 'localdemo' && usable('scenario')) return 'scenario';
        if (usable(previous)) return previous;
        return ['scenario', 'access', 'compare', 'exposure'].find(usable) ?? 'access';
      });
    }).catch((error) => {
      if (error.name !== 'AbortError' && revision === datasetRevision.current) { setDatasetError(error.message || 'Dataset could not be loaded.'); setDataset(null); }
    }).finally(() => { if (revision === datasetRevision.current) setDatasetLoading(false); });
    return () => controller.abort();
  }, [datasetId]);

  useEffect(() => { if (!questionEdited) setQuestion(COPY[mode]); }, [mode, questionEdited]);
  useEffect(() => { if (scenarioResultAllowed) setSelectedScenarioCandidate(run.result?.metrics?.candidates?.[0] ?? null); else setSelectedScenarioCandidate(null); }, [run?.id, run?.status, scenarioResultAllowed]);
  useEffect(() => {
    if (!activeRunId) return undefined;
    const controller = new AbortController(); let stopped = false;
    activeRunIdRef.current = activeRunId;
    const poll = async () => {
      while (!stopped && activeRunIdRef.current === activeRunId) {
        try {
          const next = await readJson(await fetch(`/api/runs/${activeRunId}`, { signal: controller.signal }));
          if (stopped || activeRunIdRef.current !== activeRunId) return;
          setRun(next);
          if (TERMINAL.has(next.status)) { activeRunIdRef.current = null; setActiveRunId(null); return; }
        } catch (error) {
          if (error.name === 'AbortError' || stopped) return;
          setRun((current) => ({ ...(current ?? { id: activeRunId, analysis_mode: mode }), status: 'failed', error: `Could not retrieve run status: ${error.message || 'network error'}` }));
          activeRunIdRef.current = null; setActiveRunId(null); return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    };
    poll();
    return () => { stopped = true; controller.abort(); };
  }, [activeRunId]);
  useEffect(() => {
    if (!run?.id || run.status !== 'completed') return undefined;
    const controller = new AbortController(); const id = run.id;
    setResultMap(null); setResultMapError('');
    fetch(`/api/runs/${encodeURIComponent(id)}/map`, { signal: controller.signal }).then(readJson).then((data) => {
      if (!controller.signal.aborted && activeRunIdRef.current === null) setResultMap(data);
    }).catch((error) => { if (error.name !== 'AbortError' && !controller.signal.aborted) setResultMapError(error.message || 'Result map is unavailable.'); });
    return () => controller.abort();
  }, [run?.id, run?.status]);

  const clearScenarioResult = () => { setRun(null); setResultMap(null); setResultMapError(''); setSelectedScenarioCandidate(null); };
  const onScenarioAreaSelected = useCallback((area) => { setStudyArea(area); setAreaSelectionActive(false); setRun(null); setResultMap(null); setResultMapError(''); setSelectedScenarioCandidate(null); }, []);
  const onModeChange = (value) => { clearScenarioResult(); setResultMap(null); setResultMapError(''); setAreaSelectionActive(false); setMode(value); setQuestionEdited(false); };
  const onUpload = async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    setUploadError(''); setUploading(true); const body = new FormData(); body.append('file', file);
    try {
      const uploaded = await readJson(await fetch('/api/datasets', { method: 'POST', body }));
      setUploadedNames((previous) => ({ ...previous, [uploaded.id]: file.name }));
      if (uploaded.schema?.candidate_site_features) onModeChange('scenario');
      else if (!uploaded.schema?.zone_features && uploaded.schema?.service_features) onModeChange('access');
      else if (!uploaded.schema?.service_features && uploaded.schema?.zone_features) onModeChange('exposure');
      setDatasetLoading(true);
      setDatasetId(uploaded.id);
    } catch (error) { setUploadError(error.message || 'Upload failed.'); }
    finally { setUploading(false); event.target.value = ''; }
  };
  const startRun = async () => {
    if (!canRun) return;
    const request = { dataset_id: datasetId, analysis_mode: mode, question, threshold_m: Number(threshold) };
    if (mode === 'exposure') request.study_area = studyArea.map(Number);
    if (mode === 'scenario') {
      request.study_area = studyArea.map(Number); request.service_type = serviceType; request.building = { width_m: Number(building.width_m), depth_m: Number(building.depth_m), height_m: Number(building.height_m), setback_m: Number(building.setback_m) };
    }
    if (mode === 'compare') { request.candidate_a = candidateA.map(Number); request.candidate_b = candidateB.map(Number); if (![...request.candidate_a, ...request.candidate_b].every(Number.isFinite)) return; }
    setRunStarting(true); setRun({ id: null, status: 'starting', analysis_mode: mode, logs: [] }); setSelectedScenarioCandidate(null); setResultMap(null); setResultMapError(''); setDownloadError('');
    try {
      const created = await readJson(await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', }, body: JSON.stringify(request) }));
      setActiveRunId(created.id); activeRunIdRef.current = created.id;
    } catch (error) { setRun({ id: null, status: 'failed', analysis_mode: mode, error: error.message || 'Could not start run.', logs: [] }); }
    finally { setRunStarting(false); }
  };
  const onDownload = useCallback(async (runId, name) => {
    setDownloadError('');
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`, {});
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a');
      a.href = url; a.download = name; a.style.position = 'fixed'; a.style.left = '-10000px'; document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setDownloadError(`${name}: ${error.message || 'download failed'}`); }
  }, []);

  const sourceNote = datasetId === 'sf2020'
    ? <>2020 Census TIGERweb POP100 + selected parks inventory. Candidate coordinates are illustrative; inventory coverage has documented limits. <a href="/api/source-manifest" target="_blank" rel="noreferrer">Source dataset ↗</a></>
    : datasetId === 'localdemo' ? '2020 Census population + mapped OpenStreetMap facilities; simulated plots and obstructions. No real land availability is implied.'
    : datasetId === 'demo' ? 'Fabricated features for demonstration and testing. They do not describe a real neighborhood.'
      : datasetId ? 'User supplied EPSG:4326 GeoJSON. Feature roles and population field were validated.' : '';
  const featureCount = schema ? `${schema.population_features} population areas · ${schema.service_features} services · ${schema.zone_features} zones · ${schema.candidate_site_features} candidate plots` : datasetLoading ? 'Loading map data…' : 'No dataset loaded';
  const onCandidateChange = useCallback((which, position) => { (which === 'A' ? setCandidateA : setCandidateB)(position); setRun(null); setResultMap(null); setResultMapError(''); }, []);
  const mapTitle = datasetId === 'localdemo' ? 'San Francisco · simulated scenario land' : datasetId === 'sf2020' ? 'San Francisco · 2020 Census + selected parks' : datasetId === 'demo' ? 'Harborview · synthetic fixture' : uploadedNames[datasetId] ?? 'Uploaded GeoJSON';

  return <>
    {config?.demo_mode && <div className="scenario-demo-banner global">LOCAL MOCK MODE — no LLM, no generated-code execution, no cloud inference.</div>}<header className="topbar"><a className="brand" href="/"><span className="brand-icon">⌖</span> GEOSCOPE</a><div className="topmeta"><span className={`live-dot${worker.ok ? '' : ' offline'}`}></span><span title={worker.message}>{config?.demo_mode ? 'LOCAL MOCK · NO LLM' : worker.status === 'checking' ? 'WORKER CHECKING' : worker.ok ? 'WORKER READY' : 'WORKER UNAVAILABLE'}</span><span className="top-divider"></span><span>FIELD NOTE&nbsp; 01</span></div></header>
    <main className="shell">
      <section className="intro"><div><div className="eyebrow">POPULATION · PLACES · PATTERNS</div><h1>Ask a question.<br />See it on the map.</h1><p className="lede">Choose a question, draw an area when needed, and get a clear result on the map.</p></div><div className="issue-stamp"><span>RESEARCH<br />DESK</span><span className="stamp-mark">✳</span></div></section>
      <div className="workspace"><aside className="controls">
        <div className="section-heading"><span className="number">01</span><div><h2>Choose your task</h2><p>Start with a dataset, then pick what you want to find out.</p></div></div>
        {worker.status === 'ready' ? <details className="worker-readiness"><summary>Analysis service ready</summary><p>{worker.message}</p><button type="button" onClick={() => { setWorker({ ok: false, status: 'checking', message: 'Checking worker readiness…' }); setWorkerRefresh((value) => value + 1); }}>Check again</button></details> : <div className="worker-readiness" role="status"><span>{worker.status === 'checking' ? 'Checking analysis service…' : worker.message}</span><button type="button" onClick={() => { setWorker({ ok: false, status: 'checking', message: 'Checking worker readiness…' }); setWorkerRefresh((value) => value + 1); }} disabled={worker.status === 'checking'}>{worker.status === 'checking' ? 'Checking…' : 'Retry check'}</button></div>}
        <label htmlFor="dataset">Population + places or zones</label>
        <select id="dataset" value={datasetId} onChange={(e) => { setDatasetLoading(true); setDatasetId(e.target.value); }} disabled={!config || uploading || runStarting || Boolean(activeRunId)}>
          {config?.scenario_demo && <option value={config.scenario_demo.id}>San Francisco · simulated scenario parcels</option>}{config?.real && <option value={config.real.id}>San Francisco · 2020 Census + parks</option>}{config?.demo && <option value={config.demo.id}>Harborview · synthetic fixture</option>}
          {Object.entries(uploadedNames).map(([id, name]) => <option value={id} key={id}>{name} · uploaded</option>)}
        </select>
        <div className="source-note">{sourceNote}{datasetError && <span role="alert"> {datasetError}</span>}</div>
        <details className="upload-settings"><summary>Use your own data</summary><label className="upload-label" htmlFor="upload">Choose a GeoJSON file <span>↗</span></label><input id="upload" type="file" accept=".json,.geojson,application/geo+json,application/json" onChange={onUpload} disabled={uploading || runStarting || Boolean(activeRunId)} />{uploading && <small role="status">Uploading and validating dataset…</small>}{uploadError && <small role="alert">{uploadError}</small>}</details>
        <label htmlFor="analysis-mode" className="mode-label">What do you want to find out?</label>
        <select id="analysis-mode" value={mode} onChange={(e) => onModeChange(e.target.value)} disabled={!dataset || datasetLoading || runStarting || Boolean(activeRunId)}>
          {MODES.map(([value, label]) => <option key={value} value={value} disabled={!modeAllowed(value)}>{label}</option>)}
        </select>
        {(mode === 'scenario' || mode === 'exposure') && <section className="study-area-controls" aria-label="Study area">
          <h3>{mode === 'exposure' ? 'Where should we count people?' : 'Where should the building fit?'}</h3>
          <p>{mode === 'exposure' ? 'Draw a rectangle on the map. The estimate uses this area; any other mapped zones remain context only.' : 'Choose the area for parcel and footprint checks.'}</p>
          <button type="button" className="select-area-button primary-secondary" disabled={runStarting || Boolean(activeRunId)} onClick={() => { setAreaSelectionActive((active) => !active); clearScenarioResult(); setResultMap(null); }}>{areaSelectionActive ? 'Click two opposite map corners…' : 'Draw area on map'}</button>
          {studyArea?.every(Number.isFinite) && <small className="area-readout">Selected area · about {areaDimensions(studyArea)}</small>}
          {areaSelectionActive && <small role="status">Click two opposite corners on the map.</small>}
          {mode === 'exposure' && <p className="population-caveat">Estimated population uses whole census-area weights assigned by representative point, not exact resident locations.</p>}
          <details className="area-coordinate-details"><summary>Edit area coordinates</summary><div className="bbox-fields">{[['west', 0], ['south', 1], ['east', 2], ['north', 3]].map(([label, i]) => <label key={label} htmlFor={`area-${label}`}>{label}<input id={`area-${label}`} type="number" step="0.000001" value={Number.isFinite(studyArea?.[i]) ? studyArea[i] : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { const next = studyArea ? [...studyArea] : [NaN, NaN, NaN, NaN]; next[i] = e.target.value === '' ? NaN : Number(e.target.value); setStudyArea(next); clearScenarioResult(); setResultMap(null); }} /></label>)}</div></details>
          {studyArea && validateStudyArea(studyArea) && <small role="alert">{validateStudyArea(studyArea)}</small>}
        </section>}
        {mode !== 'exposure' && <details className="advanced-settings"><summary>{mode === 'scenario' ? 'Coverage threshold' : 'Advanced settings'}</summary>
          <div className="field-grid"><div id="threshold-group"><label htmlFor="threshold">Service threshold</label><div className="unit-input"><input id="threshold" type="number" min="100" max="5000" step="100" value={threshold} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setThreshold(e.target.value); clearScenarioResult(); }} /><span>m</span></div></div>{mode !== 'scenario' && <div id="distance-type"><label>Distance type</label><div className="static-input">Straight line <span>↗</span></div></div>}</div>
        </details>}
        {mode === 'scenario' && <section id="scenario-controls" aria-label="Facility scenario settings">
          <div className="section-heading second"><span className="number">02</span><div><h2>Facility scenario</h2><p>Review supplied parcels and requested building size.</p></div></div>
          <label htmlFor="service-type">Proposed facility type</label><select id="service-type" value={serviceType} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setServiceType(e.target.value); clearScenarioResult(); }}>{SERVICE_TYPES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
          <details className="building-settings"><summary>Adjust building size · {Number.isFinite(building.width_m) ? building.width_m : '—'} × {Number.isFinite(building.depth_m) ? building.depth_m : '—'} m footprint · {Number.isFinite(building.height_m) ? building.height_m : '—'} m high</summary><div className="building-grid">{[['width_m', 'Width'], ['depth_m', 'Depth'], ['height_m', 'Height'], ['setback_m', 'Setback']].map(([key, label]) => <label key={key} htmlFor={`building-${key}`}>{label} (m)<input id={`building-${key}`} type="number" min={key === 'height_m' ? 3 : key === 'setback_m' ? 0 : 5} max={key === 'height_m' ? 80 : key === 'setback_m' ? 20 : 100} value={Number.isFinite(building[key]) ? building[key] : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setBuilding((current) => ({ ...current, [key]: e.target.value === '' ? NaN : Number(e.target.value) })); clearScenarioResult(); }} /></label>)}</div></details>
          {validateBuilding(building) && <small role="alert">{validateBuilding(building)}</small>}
          <p className="scenario-input-note">Footprint fit is tested against candidate parcels, supplied buildings/restrictions, and the requested setback. Evidence can be simulated; this is not a real land-availability finding.</p>
        </section>}
        <div id="candidate-controls" hidden={mode !== 'compare'}><div className="section-heading second"><span className="number">02</span><div><h2>Compare candidate sites</h2><p>Use longitude, latitude in EPSG:4326. Drag pins or edit.</p></div></div>
          <CandidateInput letter="A" candidate={candidateA} disabled={runStarting || Boolean(activeRunId)} onChange={(position) => onCandidateChange('A', position)} /><CandidateInput letter="B" candidate={candidateB} disabled={runStarting || Boolean(activeRunId)} onChange={(position) => onCandidateChange('B', position)} />
        </div>
        <details className="advanced-settings"><summary>Customize the question</summary><label htmlFor="question" className="question-label">Question for the analyst</label><textarea id="question" rows="3" value={question} onChange={(e) => { setQuestion(e.target.value); setQuestionEdited(true); }} /></details>

        <button id="run-button" className="run-button" type="button" disabled={!canRun} onClick={startRun}><span className="button-icon">↗</span><span>{runStarting ? 'Starting…' : activeRunId ? 'Working…' : mode === 'exposure' ? 'Estimate population' : mode === 'scenario' ? 'Check facility sites' : mode === 'compare' ? 'Compare locations' : 'Find nearby services'}</span><span className="button-arrow">→</span></button>
        <details className="method-note"><summary>How the estimates work</summary><p>Distances are straight-line in a local projected CRS. Population is estimated with census-area representative points; the full area weight is assigned by its representative point. This is not an exact resident count, route, or measure of actual access.</p></details>
      </aside><section className="map-panel">
        <div className="map-head"><div><div className="eyebrow">{config?.demo_mode ? 'LOCAL MOCK · SF SIMULATION' : 'SPATIAL OVERVIEW'}</div><h2>{mapTitle}</h2></div></div>
        <LeafletMap data={dataset} datasetId={datasetId} resultData={resultMap} mode={mode} candidateA={candidateA} candidateB={candidateB} onCandidateChange={onCandidateChange} scenarioArea={['scenario', 'exposure'].includes(mode) && studyArea?.every(Number.isFinite) ? studyArea : null} scenarioCandidates={mode === "scenario" && scenarioResultAllowed ? scenarioCandidates : []} selectedCandidateId={selectedScenarioCandidate?.id ?? scenarioCandidates[0]?.id} onScenarioAreaSelected={onScenarioAreaSelected} areaSelectionActive={areaSelectionActive && ['scenario', 'exposure'].includes(mode) && !runStarting && !activeRunId} interactionsLocked={runStarting || Boolean(activeRunId)} onSelectScenarioCandidate={selectScenarioCandidate} scenarioSiteChecks={scenarioResultAllowed ? (run.result?.metrics?.site_checks ?? []) : []} />
        <div className="map-foot"><span>{featureCount}</span><span>© OpenStreetMap contributors</span></div>{resultMapError && <div role="alert">{resultMapError}</div>}
        <ResultsPanel run={run} onDownload={onDownload} downloadError={downloadError} dataset={dataset} selectedScenarioCandidate={selectedScenarioCandidate} onSelectScenarioCandidate={selectScenarioCandidate} />
      </section></div>
      <footer><span>GEOSCOPE / A SMALL GIS AGENT</span><span>{config?.demo_mode ? 'Local fixed-reference simulation · no cloud agent run.' : 'Metrics and map are checked against a fixed GIS reference.'}</span></footer>
    </main>
  </>;
}
