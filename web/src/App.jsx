import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LeafletMap from './components/LeafletMap.jsx';
import { validateBuilding, validateStudyArea } from './scenario.js';
const ScenarioViewer = lazy(() => import('./components/ScenarioViewer.jsx'));

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const COPY = { access: 'Which population areas are farthest from the nearest service, and how many residents are within 400 meters?', compare: 'Which candidate serves more residents within 400 meters, and how much does each reduce average distance?', exposure: 'How many residents live in the supplied zones, and what share of the study population is inside?', scenario: 'Which supplied plots meet the requested facility and clearance rules, and how do eligible sites compare?' };
const MODES = [['access', 'Service access'], ['compare', 'Compare candidate sites'], ['exposure', 'Population inside zones'], ['scenario', 'Facility scenario']];
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
function CandidateInput({ letter, candidate, onChange }) {
  const kind = letter.toLowerCase();
  return <div className="candidate-row"><span className={`candidate-tag ${kind}`}>{letter}</span><label htmlFor={`candidate-${kind}-lon`}>Candidate {letter}</label><div className="coordinate">
    <input id={`candidate-${kind}-lon`} type="number" step="0.0001" value={candidate[0]} aria-label={`Candidate ${letter} longitude`} onChange={(e) => onChange([e.target.value, candidate[1]])} />
    <input id={`candidate-${kind}-lat`} type="number" step="0.0001" value={candidate[1]} aria-label={`Candidate ${letter} latitude`} onChange={(e) => onChange([candidate[0], e.target.value])} />
  </div></div>;
}
function ResultsPanel({ run, onDownload, downloadError, dataset, selectedScenarioCandidate, onSelectScenarioCandidate }) {
  if (!run) return null;
  const m = run.result?.metrics ?? {};
  const failed = ['failed', 'interrupted'].includes(run.status);
  const files = Object.entries(run.artifacts ?? {}).filter(([name, available]) => available === true && /^(analysis\.py|result\.json|result\.geojson|request\.json|trace\.json|analysis-attempt-[1-3]\.py)$/.test(name)).map(([name]) => name);
  const verified = run.status === 'completed' && (run.result?.reference_verified === true || (run.demo_mode === true && run.result?.geometry_verified === true));
  const n = (x) => x == null ? 'N/A' : Number(x).toLocaleString();
  const d = (x) => x == null ? 'N/A' : `${Number(x).toFixed(0)} m`;
  let cards = [];
  if (run.status === 'completed' && run.result) {
    if (run.analysis_mode === 'scenario' && verified) {
      const gross = m.inventory_status === 'no matching service inventory supplied';
      cards = [
        <MetricCard key="sites" value={n(m.eligible_sites)} label={`eligible plots · ${n(m.sites_evaluated)} checked`} />,
        <MetricCard key="population" value={n(m.population_total)} label="population weight in selected area" />,
        <MetricCard key="baseline" value={d(m.baseline?.weighted_mean_nearest_m)} label="baseline mean to matching inventory" />,
      ];
      const best = selectedScenarioCandidate ?? m.candidates?.[0] ?? null;
      return <div className="result-panel">
        <div className="result-top"><div><div className="eyebrow">{run.demo_mode ? "SF MOCK SIMULATION · LOCAL FIXED REFERENCE" : "VERIFIED SCENARIO"}</div><h2>Eligible {({ clinic: 'clinic', library: 'library', school: 'school', community_center: 'community center' })[m.service_type] || 'facility'} plots</h2></div><span className="status-pill">{run.demo_mode ? "mock · geometry checked" : "checked"}</span></div>
        {run.demo_mode && <p className="scenario-demo-banner">SF MOCK SIMULATION — local fixed-reference calculation; no cloud agent run. All land and service records in this scenario are simulated.</p>}<p id="summary">{run.summary || 'Candidate building footprints were checked against the supplied plots, study boundary, buildings, and restrictions.'}</p>
        <div className="metrics">{cards}</div>
        <div className="scenario-integrity"><b>Supplied land evidence · {m.land_inventory?.as_of || 'date not recorded'}</b><span>{m.land_inventory?.source || 'Source not recorded'}</span><span>Plot fit, area fit, building overlap, restriction overlap, and {Number(best?.land_check?.setback_m ?? m.building?.setback_m)} m setback checked against supplied layers.</span><strong>{gross ? 'Covered by proposal' : 'Additional coverage vs supplied matching inventory'}</strong></div>
        <p className="scenario-caveat">Population polygon weights are assigned by representative point, not exact resident addresses. Scenario dataset and land evidence are simulated for this San Francisco mockup; this does not establish real land availability, ownership, zoning approval, or permits.</p>
        <h3 className="scenario-subhead">Ranked eligible parcels</h3>
        {m.candidates?.length ? <div className="scenario-rankings">{m.candidates.map((candidate, index) => <button type="button" className={`scenario-rank${best?.id === candidate.id ? ' selected' : ''}`} key={candidate.id} onClick={() => onSelectScenarioCandidate(candidate)}>
          <span className="rank-number">{index + 1}</span><span className="rank-main"><b>{candidate.id}</b><small>{candidate.land_check?.source || 'Land evidence source not recorded'} · {candidate.land_check?.setback_m ?? '—'} m setback</small></span><span className="rank-pop">{n(gross ? candidate.served_population : candidate.newly_served_population)}<small>{gross ? 'covered by proposal' : 'additional coverage'}</small></span>
        </button>)}</div> : <p>No eligible supplied parcel passed the requested footprint checks. No building placement is shown.</p>}
        {m.site_checks?.length > 0 && <details><summary>Parcel checks ({m.site_checks.length})</summary><ul className="site-checks">{m.site_checks.map((site) => <li key={site.id}><b>{site.id}: {site.status}</b> · {site.reason} <span>Evidence: {site.source || 'not supplied'}</span></li>)}</ul></details>}
        {best && <Suspense fallback={<div role="status">Preparing 3D footprint view…</div>}><ScenarioViewer area={m.study_area} candidate={best} building={m.building} serviceType={m.service_type} dataset={dataset} /></Suspense>}
        {run.plan && <details><summary>Method + agent plan</summary><pre>{run.plan}</pre><ul className="caveats"><li>{run.demo_mode ? 'Local fixed-reference simulation; no LLM execution or independent agent-to-reference verification.' : 'Metrics and parcel checks matched a fixed GIS reference calculation.'}</li><li>Geometric fit is checked against the supplied plot and blocker layers; land status depends on provided evidence.</li></ul></details>}
        {files.length > 0 && <div className="downloads">{files.map((name) => <button className="download-link" type="button" key={name} onClick={() => onDownload(run.id, name)}>{name} ↓</button>)}{downloadError && <span role="alert" className="download-error">{downloadError}</span>}</div>}
        {run.attempts?.length > 0 && <details className="trace attempt-diagnostics" open={failed}><summary>Execution diagnostics ({run.attempts.length} attempts)</summary>{run.attempts.map((attempt, index) => <section key={`${attempt.attempt ?? index}-${attempt.script_file ?? index}`}><b>Attempt {attempt.attempt ?? index + 1} · {attempt.status || 'unknown'}</b>{attempt.script_file && <p>Script: {attempt.script_file}</p>}{(attempt.diagnostics?.message || attempt.diagnostics?.stderr || attempt.message || attempt.stderr) && <p>{attempt.diagnostics?.message || attempt.message}</p>}{(attempt.diagnostics?.stderr || attempt.stderr) && <pre aria-label={`Attempt ${attempt.attempt ?? index + 1} stderr`}>{attempt.diagnostics?.stderr || attempt.stderr}</pre>}{(attempt.diagnostics?.stdout || attempt.stdout) && <pre aria-label={`Attempt ${attempt.attempt ?? index + 1} stdout`}>{attempt.diagnostics?.stdout || attempt.stdout}</pre>}</section>)}</details>}
    {run.logs?.length > 0 && <details className="trace"><summary>Run trace</summary><div id="logs">{run.logs.map((log, i) => <div className="log-row" key={`${log.time ?? i}-${i}`}><b>{(log.status || 'step').toUpperCase()}</b> · {log.text}</div>)}</div></details>}
      </div>;
    }
    if (run.analysis_mode === 'exposure') cards = [
      <MetricCard key="inside" value={n(m.inside_population)} label="population assigned inside supplied zones" />,
      <MetricCard key="share" value={m.share_inside_pct == null ? 'N/A' : `${Number(m.share_inside_pct).toFixed(1)}%`} label="share of total population" />,
      <MetricCard key="outside" value={n(m.outside_population)} label="population assigned outside zones" />,
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
  const title = failed ? 'Run stopped' : ({ access: 'Service access', compare: 'Candidate comparison', exposure: 'Population inside zones', scenario: 'Facility scenario' }[run.analysis_mode] ?? 'GIS analysis');
  return <div className="result-panel">
    <div className="result-top"><div><div className="eyebrow">AGENT FINDINGS</div><h2>{title}</h2></div><span className={`status-pill${failed ? ' failed' : ''}`}>{run.status}</span></div>
    <p id="summary">{run.summary || run.error || 'The agent is working through the analysis steps.'}</p>
    {cards.length > 0 && <div className="metrics">{cards}</div>}
    {run.plan && <details><summary>Method + agent plan</summary><pre>{run.plan}</pre><ul className="caveats">
      {verified && <li>Metrics and per-feature results matched a fixed GIS reference calculation.</li>}<li>Distances are straight-line; population polygon representative points are a proxy.</li>
      <li>{run.analysis_mode === 'exposure' ? 'The whole population estimate for each polygon is assigned according to its representative point; this is not an exact resident count inside the zone.' : run.analysis_mode === 'compare' ? 'Candidate ranking uses newly served population within the threshold; sites are illustrative, not feasibility recommendations.' : 'Population proximity is not a walking route or a measure of actual access.'}</li>
      <li>{run.synthetic ? 'Synthetic fixture only; not real-world evidence.' : `Source: ${run.dataset_name}.`}</li>
    </ul></details>}
    {files.length > 0 && <div className="downloads">{files.map((name) => <button className="download-link" type="button" key={name} onClick={() => onDownload(run.id, name)}>{name} ↓</button>)}{downloadError && <span role="alert" className="download-error">{downloadError}</span>}</div>}
    {run.attempts?.length > 0 && <details className="trace attempt-diagnostics" open={failed}><summary>Execution diagnostics ({run.attempts.length} attempts)</summary>{run.attempts.map((attempt, index) => <section key={`${attempt.attempt ?? index}-${attempt.script_file ?? index}`}><b>Attempt {attempt.attempt ?? index + 1} · {attempt.status || 'unknown'}</b>{attempt.script_file && <p>Script: {attempt.script_file}</p>}{(attempt.diagnostics?.message || attempt.diagnostics?.stderr || attempt.message || attempt.stderr) && <p>{attempt.diagnostics?.message || attempt.message}</p>}{(attempt.diagnostics?.stderr || attempt.stderr) && <pre aria-label={`Attempt ${attempt.attempt ?? index + 1} stderr`}>{attempt.diagnostics?.stderr || attempt.stderr}</pre>}{(attempt.diagnostics?.stdout || attempt.stdout) && <pre aria-label={`Attempt ${attempt.attempt ?? index + 1} stdout`}>{attempt.diagnostics?.stdout || attempt.stdout}</pre>}</section>)}</details>}
    {run.logs?.length > 0 && <details className="trace"><summary>Run trace</summary><div id="logs">{run.logs.map((log, i) => <div className="log-row" key={`${log.time ?? i}-${i}`}><b>{(log.status || 'step').toUpperCase()}</b> · {log.text}</div>)}</div></details>}
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
  const scenarioCandidates = scenarioResultAllowed ? (run.result?.metrics?.candidates ?? []).map((candidate, index) => ({ ...candidate, rank: index + 1 })) : [];  const modeAllowed = (key, source = schema) => source && (!config?.supported_modes || config.supported_modes.includes(key)) && (key === 'scenario' ? source.candidate_site_features > 0 : key === 'exposure' ? source.zone_features > 0 : source.service_features > 0);
  const canRun = Boolean(config?.analysis_enabled && worker.ok && dataset && !datasetLoading && !runStarting && !activeRunId && !uploading && modeAllowed(mode) && (mode !== 'scenario' || (!validateStudyArea(studyArea) && !validateBuilding(building))));

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
    setCandidateA(defaultCandidates(datasetId)[0]); setCandidateB(defaultCandidates(datasetId)[1]); setThreshold(400); setStudyArea(null); setSelectedScenarioCandidate(null); setBuilding(DEFAULT_BUILDING);
    fetch(url, { signal: controller.signal }).then(readJson).then((data) => {
      if (revision !== datasetRevision.current) return;
      setDataset(data);
      const suggestions = defaultCandidates(datasetId, data); setCandidateA(suggestions[0]); setCandidateB(suggestions[1]);
      const plotCoordinates = (data.features ?? []).filter((f) => roleOf(f) === 'candidate_site').flatMap((f) => { const out = []; const walk = (v) => Array.isArray(v) && (typeof v[0] === 'number' ? out.push(v) : v.forEach(walk)); walk(f.geometry?.coordinates); return out; });
      if (datasetId === 'localdemo') setStudyArea([-122.433, 37.758, -122.417, 37.776]);
      else if (plotCoordinates.length) { const centerLon = plotCoordinates.reduce((sum, point) => sum + point[0], 0) / plotCoordinates.length; const centerLat = plotCoordinates.reduce((sum, point) => sum + point[1], 0) / plotCoordinates.length; setStudyArea([centerLon - 0.005, centerLat - 0.005, centerLon + 0.005, centerLat + 0.005].map((v) => Number(v.toFixed(6)))); }
      setMode((previous) => {
        if (config?.supported_modes?.length && !config.supported_modes.includes(previous)) return config.supported_modes.includes('scenario') ? 'scenario' : config.supported_modes[0];
        const nextSchema = { service_features: data.features?.filter((f) => roleOf(f) === 'service').length ?? 0, zone_features: data.features?.filter((f) => roleOf(f) === 'zone').length ?? 0, candidate_site_features: data.features?.filter((f) => roleOf(f) === 'candidate_site').length ?? 0 };
        if (previous === 'scenario' && nextSchema.candidate_site_features > 0) return previous;
        if (previous === 'exposure' && nextSchema.zone_features > 0) return previous;
        if (previous !== 'exposure' && previous !== 'scenario' && nextSchema.service_features > 0) return previous;
        return nextSchema.candidate_site_features > 0 ? 'scenario' : nextSchema.zone_features > 0 ? 'exposure' : 'access';
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
  const onModeChange = (value) => { if (mode === 'scenario' || value === 'scenario') clearScenarioResult(); setMode(value); setQuestionEdited(false); };
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
    : datasetId === 'localdemo' ? '2020 Census population; simulated service, parcel, building, and restriction records. No real land availability is implied.'
    : datasetId === 'demo' ? 'Fabricated features for demonstration and testing. They do not describe a real neighborhood.'
      : datasetId ? 'User supplied EPSG:4326 GeoJSON. Feature roles and population field were validated.' : '';
  const featureCount = schema ? `${schema.population_features} population areas · ${schema.service_features} services · ${schema.zone_features} zones · ${schema.candidate_site_features} candidate plots` : datasetLoading ? 'Loading map data…' : 'No dataset loaded';
  const onCandidateChange = useCallback((which, position) => (which === 'A' ? setCandidateA : setCandidateB)(position), []);
  const mapTitle = datasetId === 'localdemo' ? 'San Francisco · simulated scenario land' : datasetId === 'sf2020' ? 'San Francisco · 2020 Census + selected parks' : datasetId === 'demo' ? 'Harborview · synthetic fixture' : uploadedNames[datasetId] ?? 'Uploaded GeoJSON';

  return <>
    {config?.demo_mode && <div className="scenario-demo-banner global">LOCAL MOCK MODE — no LLM, no generated-code execution, no cloud inference.</div>}<header className="topbar"><a className="brand" href="/"><span className="brand-icon">⌖</span> GEOSCOPE</a><div className="topmeta"><span className={`live-dot${worker.ok ? '' : ' offline'}`}></span><span title={worker.message}>{config?.demo_mode ? 'LOCAL MOCK · NO LLM' : worker.status === 'checking' ? 'WORKER CHECKING' : worker.ok ? 'WORKER READY' : 'WORKER UNAVAILABLE'}</span><span className="top-divider"></span><span>FIELD NOTE&nbsp; 01</span></div></header>
    <main className="shell">
      <section className="intro"><div><div className="eyebrow">POPULATION · PLACES · PATTERNS</div><h1>Ask a question.<br />See it on the map.</h1><p className="lede">A geospatial analyst for service access, candidate sites, and population inside supplied zones. Inspect the method, map, and generated code.</p></div><div className="issue-stamp"><span>RESEARCH<br />DESK</span><span className="stamp-mark">✳</span></div></section>
      <div className="workspace"><aside className="controls">
        <div className="section-heading"><span className="number">01</span><div><h2>Set the study area</h2><p>Choose source features and an analysis.</p></div></div>
        <div className="worker-readiness" role="status"><span>{worker.status === 'checking' ? 'Checking worker readiness…' : worker.message}</span><button type="button" onClick={() => { setWorker({ ok: false, status: 'checking', message: 'Checking worker readiness…' }); setWorkerRefresh((value) => value + 1); }} disabled={worker.status === 'checking'}>Retry worker check</button></div>
        <label htmlFor="dataset">Population + places or zones</label>
        <select id="dataset" value={datasetId} onChange={(e) => { setDatasetLoading(true); setDatasetId(e.target.value); }} disabled={!config || uploading || runStarting || Boolean(activeRunId)}>
          {config?.scenario_demo && <option value={config.scenario_demo.id}>San Francisco · simulated scenario parcels</option>}{config?.real && <option value={config.real.id}>San Francisco · 2020 Census + parks</option>}{config?.demo && <option value={config.demo.id}>Harborview · synthetic fixture</option>}
          {Object.entries(uploadedNames).map(([id, name]) => <option value={id} key={id}>{name} · uploaded</option>)}
        </select>
        <div className="source-note">{sourceNote}{datasetError && <span role="alert"> {datasetError}</span>}</div>
        <label className="upload-label" htmlFor="upload">Or bring your own GeoJSON <span>↗</span></label>
        <input id="upload" type="file" accept=".json,.geojson,application/geo+json,application/json" onChange={onUpload} disabled={uploading || runStarting || Boolean(activeRunId)} />
        {uploading && <small role="status">Uploading and validating dataset…</small>}{uploadError && <small role="alert">{uploadError}</small>}
        <label htmlFor="analysis-mode" className="mode-label">Analysis</label>
        <select id="analysis-mode" value={mode} onChange={(e) => onModeChange(e.target.value)} disabled={!dataset || datasetLoading || runStarting || Boolean(activeRunId)}>
          {MODES.map(([value, label]) => <option key={value} value={value} disabled={!modeAllowed(value)}>{label}</option>)}
        </select>
        <div className="field-grid">
          <div id="threshold-group" hidden={mode === 'exposure'}><label htmlFor="threshold">Access threshold</label><div className="unit-input"><input id="threshold" type="number" min="100" max="5000" step="100" value={threshold} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setThreshold(e.target.value); if (mode === 'scenario') clearScenarioResult(); }} /><span>m</span></div></div>
          <div id="distance-type" hidden={mode === 'exposure'}><label>Distance type</label><div className="static-input">Straight line <span>↗</span></div></div>
        </div>
        {mode === 'scenario' && <section id="scenario-controls" aria-label="Facility scenario settings">
          <div className="section-heading second"><span className="number">02</span><div><h2>Facility scenario</h2><p>Filter verified supplied parcels; no invented grid sites.</p></div></div>
          <label htmlFor="service-type">Proposed facility type</label><select id="service-type" value={serviceType} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setServiceType(e.target.value); clearScenarioResult(); }}>{SERVICE_TYPES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
          <label>Study rectangle · EPSG:4326</label><button type="button" className="select-area-button" disabled={runStarting || Boolean(activeRunId)} onClick={() => setAreaSelectionActive((active) => !active)}>{areaSelectionActive ? 'Click two map corners…' : 'Select area on map'}</button>
          {areaSelectionActive && <small role="status">Click two opposite corners on the map to set a rectangular study area.</small>}
          <div className="bbox-fields">{[['west', 0], ['south', 1], ['east', 2], ['north', 3]].map(([label, i]) => <label key={label} htmlFor={`area-${label}`}>{label}<input id={`area-${label}`} type="number" step="0.000001" value={Number.isFinite(studyArea?.[i]) ? studyArea[i] : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { const next = studyArea ? [...studyArea] : [NaN, NaN, NaN, NaN]; next[i] = e.target.value === '' ? NaN : Number(e.target.value); setStudyArea(next); clearScenarioResult(); }} /></label>)}</div>
          {studyArea && validateStudyArea(studyArea) && <small role="alert">{validateStudyArea(studyArea)}</small>}
          <div className="building-grid">{[['width_m', 'Width'], ['depth_m', 'Depth'], ['height_m', 'Height'], ['setback_m', 'Setback']].map(([key, label]) => <label key={key} htmlFor={`building-${key}`}>{label} (m)<input id={`building-${key}`} type="number" min={key === 'height_m' ? 3 : key === 'setback_m' ? 0 : 5} max={key === 'height_m' ? 80 : key === 'setback_m' ? 20 : 100} value={building[key]} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setBuilding((current) => ({ ...current, [key]: e.target.value === '' ? NaN : Number(e.target.value) })); clearScenarioResult(); }} /></label>)}</div>
          {validateBuilding(building) && <small role="alert">{validateBuilding(building)}</small>}
          <p className="scenario-input-note">Footprint fit is tested against candidate parcels, supplied buildings/restrictions, and the requested setback. Evidence can be simulated; this is not a real land-availability finding.</p>
        </section>}
        <div id="candidate-controls" hidden={mode !== 'compare'}><div className="section-heading second"><span className="number">02</span><div><h2>Compare candidate sites</h2><p>Use longitude, latitude in EPSG:4326. Drag pins or edit.</p></div></div>
          <CandidateInput letter="A" candidate={candidateA} onChange={setCandidateA} /><CandidateInput letter="B" candidate={candidateB} onChange={setCandidateB} />
        </div>
        <label htmlFor="question" className="question-label">What should the agent answer?</label>
        <textarea id="question" rows="3" value={question} onChange={(e) => { setQuestion(e.target.value); setQuestionEdited(true); }} />

        <button id="run-button" className="run-button" type="button" disabled={!canRun} onClick={startRun}><span className="button-icon">↗</span><span>{runStarting ? 'Starting…' : activeRunId ? 'Analysis running…' : 'Run the analysis'}</span><span className="button-arrow">→</span></button>
        <div className="method-note"><span className="note-icon">ⓘ</span><p>Distances are straight-line in a local projected CRS. Census polygon representative points provide a population proxy; routes, access barriers, and actual use are not measured. Exposure assigns each polygon’s full population weight by its representative point and is an approximation.</p></div>
      </aside><section className="map-panel">
        <div className="map-head"><div><div className="eyebrow">{config?.demo_mode ? 'LOCAL MOCK · SF SIMULATION' : 'SPATIAL OVERVIEW'}</div><h2>{mapTitle}</h2></div><div className="map-legend"><span><i className="legend-dot people"></i>Population</span><span><i className="legend-dot park"></i>Service</span><span><i className="legend-dot zone"></i>Zone</span>{mode === 'compare' && <span><i className="legend-dot cand"></i>Candidate</span>}</div></div>
        <LeafletMap data={dataset} datasetId={datasetId} resultData={resultMap} mode={mode} candidateA={candidateA} candidateB={candidateB} onCandidateChange={onCandidateChange} scenarioArea={mode === "scenario" && studyArea?.every(Number.isFinite) ? studyArea : null} scenarioCandidates={mode === "scenario" && scenarioResultAllowed ? scenarioCandidates : []} selectedCandidateId={selectedScenarioCandidate?.id ?? scenarioCandidates[0]?.id} onScenarioAreaSelected={onScenarioAreaSelected} areaSelectionActive={areaSelectionActive && !runStarting && !activeRunId} />
        <div className="map-foot"><span>{featureCount}</span><span>© OpenStreetMap contributors</span></div>{resultMapError && <div role="alert">{resultMapError}</div>}
        <ResultsPanel run={run} onDownload={onDownload} downloadError={downloadError} dataset={dataset} selectedScenarioCandidate={selectedScenarioCandidate} onSelectScenarioCandidate={setSelectedScenarioCandidate} />
      </section></div>
      <footer><span>GEOSCOPE / A SMALL GIS AGENT</span><span>{config?.demo_mode ? 'Local fixed-reference simulation · no cloud agent run.' : 'Metrics and map are checked against a fixed GIS reference.'}</span></footer>
    </main>
  </>;
}
