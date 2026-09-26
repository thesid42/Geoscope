import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LeafletMap from './components/LeafletMap.jsx';

const ACCESS_KEY = 'geoscope_access_key';
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const COPY = {
  access: 'Which population areas are farthest from the nearest service, and how many residents are within 400 meters?',
  compare: 'Which candidate serves more residents within 400 meters, and how much does each reduce average distance?',
  exposure: 'How many residents live in the supplied zones, and what share of the study population is inside?',
};
const MODES = [['access', 'Service access'], ['compare', 'Compare candidate sites'], ['exposure', 'Population inside zones']];
const roleOf = (f) => f?.properties?.layer === 'park' ? 'service' : f?.properties?.layer;
const defaultCandidates = (id) => id === 'sf2020' ? [[-122.43, 37.77], [-122.42, 37.76]] : [[-122.331, 47.612], [-122.316, 47.615]];
async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.detail === 'string' ? payload.detail : `Request failed (${response.status}).`);
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
function ResultsPanel({ run, onDownload, downloadError }) {
  if (!run) return null;
  const m = run.result?.metrics ?? {};
  const n = (x) => x == null ? 'N/A' : Number(x).toLocaleString();
  const d = (x) => x == null ? 'N/A' : `${Number(x).toFixed(0)} m`;
  let cards = [];
  if (run.status === 'completed' && run.result) {
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
  const failed = ['failed', 'interrupted'].includes(run.status);
  const title = failed ? 'Run stopped' : ({ access: 'Service access', compare: 'Candidate comparison', exposure: 'Population inside zones' }[run.analysis_mode] ?? 'GIS analysis');
  const files = ['analysis.py', 'result.json', 'result.geojson', 'request.json', 'trace.json', ...(run.attempts ?? []).map((a) => a.script_file)].filter((x, i, all) => x && all.indexOf(x) === i);
  return <div className="result-panel">
    <div className="result-top"><div><div className="eyebrow">AGENT FINDINGS</div><h2>{title}</h2></div><span className={`status-pill${failed ? ' failed' : ''}`}>{run.status}</span></div>
    <p id="summary">{run.summary || run.error || 'The agent is working through the analysis steps.'}</p>
    {cards.length > 0 && <div className="metrics">{cards}</div>}
    {run.plan && <details><summary>Method + agent plan</summary><pre>{run.plan}</pre><ul className="caveats">
      {run.result?.reference_verified === true && <li>Metrics and per-feature results matched a fixed GIS reference calculation.</li>}<li>Distances are straight-line; population polygon representative points are a proxy.</li>
      <li>{run.analysis_mode === 'exposure' ? 'The whole population estimate for each polygon is assigned according to its representative point; this is not an exact resident count inside the zone.' : run.analysis_mode === 'compare' ? 'Candidate ranking uses newly served population within the threshold; sites are illustrative, not feasibility recommendations.' : 'Population proximity is not a walking route or a measure of actual access.'}</li>
      <li>{run.synthetic ? 'Synthetic fixture only; not real-world evidence.' : `Source: ${run.dataset_name}.`}</li>
    </ul></details>}
    {run.status === 'completed' && <div className="downloads">
      {files.map((name) => <button className="download-link" type="button" key={name} onClick={() => onDownload(run.id, name)}>{name} ↓</button>)}
      {downloadError && <span role="alert" className="download-error">{downloadError}</span>}
    </div>}
    {run.logs?.length > 0 && <details className="trace"><summary>Run trace</summary><div id="logs">{run.logs.map((log, i) => <div className="log-row" key={`${log.time ?? i}-${i}`}><b>{(log.status || 'step').toUpperCase()}</b> · {log.text}</div>)}</div></details>}
  </div>;
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [worker, setWorker] = useState({ ok: false, message: 'Checking worker' });
  const [datasetId, setDatasetId] = useState('');
  const [dataset, setDataset] = useState(null);
  const [datasetLoading, setDatasetLoading] = useState(true);
  const [datasetError, setDatasetError] = useState('');
  const [uploadedNames, setUploadedNames] = useState({});
  const [mode, setMode] = useState('access');
  const [threshold, setThreshold] = useState(400);
  const [candidateA, setCandidateA] = useState([-122.43, 37.77]);
  const [candidateB, setCandidateB] = useState([-122.42, 37.76]);
  const [question, setQuestion] = useState(COPY.access);
  const [questionEdited, setQuestionEdited] = useState(false);
  const [accessKey, setAccessKey] = useState(() => { try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ''; } catch { return ''; } });
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
    const counts = { population_features: 0, service_features: 0, zone_features: 0 };
    for (const feature of dataset.features ?? []) {
      const role = roleOf(feature);
      if (role === 'population') counts.population_features++;
      if (role === 'service') counts.service_features++;
      if (role === 'zone') counts.zone_features++;
    }
    return counts;
  }, [dataset]);
  const modeAllowed = (key, source = schema) => source && (key === 'exposure' ? source.zone_features > 0 : source.service_features > 0);
  const canRun = Boolean(config?.analysis_enabled && worker.ok && dataset && !datasetLoading && !runStarting && !activeRunId && !uploading && modeAllowed(mode));

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const c = await readJson(await fetch('/api/config', { signal: controller.signal }));
        setConfig(c);
        setDatasetId(c.real?.id ?? c.demo?.id ?? 'demo');
        try { setWorker(await readJson(await fetch('/api/worker-status', { signal: controller.signal }))); }
        catch (error) { if (error.name === 'AbortError') throw error; setWorker({ ok: false, message: error.message || 'Worker is unavailable.' }); }
      } catch (error) {
        if (error.name !== 'AbortError') { setDatasetError(error.message || 'Service configuration is unavailable.'); setWorker({ ok: false, message: 'Service status unavailable.' }); }
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!datasetId) return undefined;
    const controller = new AbortController();
    const revision = ++datasetRevision.current;
    const url = datasetId === 'demo' ? '/api/datasets/demo' : datasetId === 'sf2020' ? '/api/datasets/real' : `/api/datasets/${encodeURIComponent(datasetId)}`;
    setDatasetLoading(true); setDatasetError(''); setDataset(null); setRun(null); setActiveRunId(null);
    activeRunIdRef.current = null; setResultMap(null); setResultMapError(''); setDownloadError('');
    setCandidateA(defaultCandidates(datasetId)[0]); setCandidateB(defaultCandidates(datasetId)[1]); setThreshold(400);
    fetch(url, { signal: controller.signal }).then(readJson).then((data) => {
      if (revision !== datasetRevision.current) return;
      setDataset(data);
      setMode((previous) => {
        const nextSchema = { service_features: data.features?.filter((f) => roleOf(f) === 'service').length ?? 0, zone_features: data.features?.filter((f) => roleOf(f) === 'zone').length ?? 0 };
        if (previous === 'exposure' && nextSchema.zone_features > 0) return previous;
        if (previous !== 'exposure' && nextSchema.service_features > 0) return previous;
        return nextSchema.zone_features > 0 ? 'exposure' : 'access';
      });
    }).catch((error) => {
      if (error.name !== 'AbortError' && revision === datasetRevision.current) { setDatasetError(error.message || 'Dataset could not be loaded.'); setDataset(null); }
    }).finally(() => { if (revision === datasetRevision.current) setDatasetLoading(false); });
    return () => controller.abort();
  }, [datasetId]);

  useEffect(() => { if (!questionEdited) setQuestion(COPY[mode]); }, [mode, questionEdited]);
  useEffect(() => {
    if (!activeRunId) return undefined;
    const controller = new AbortController(); let stopped = false;
    activeRunIdRef.current = activeRunId;
    const poll = async () => {
      while (!stopped && activeRunIdRef.current === activeRunId) {
        try {
          const next = await readJson(await fetch(`/api/runs/${activeRunId}`, { headers: { Authorization: `Bearer ${accessKey.trim()}` }, signal: controller.signal }));
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
  }, [activeRunId, accessKey]);
  useEffect(() => {
    if (!run?.id || run.status !== 'completed' || !accessKey) return undefined;
    const controller = new AbortController(); const id = run.id;
    setResultMap(null); setResultMapError('');
    fetch(`/api/runs/${encodeURIComponent(id)}/map`, { headers: { Authorization: `Bearer ${accessKey.trim()}` }, signal: controller.signal }).then(readJson).then((data) => {
      if (!controller.signal.aborted && activeRunIdRef.current === null) setResultMap(data);
    }).catch((error) => { if (error.name !== 'AbortError' && !controller.signal.aborted) setResultMapError(error.message || 'Result map is unavailable.'); });
    return () => controller.abort();
  }, [run?.id, run?.status, accessKey]);

  const onModeChange = (value) => { setMode(value); setQuestionEdited(false); };
  const onAccessKeyChange = (value) => { setAccessKey(value); try { window.sessionStorage.setItem(ACCESS_KEY, value.trim()); } catch { /* Storage may be disabled. */ } };
  const onUpload = async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    setUploadError(''); setUploading(true); const body = new FormData(); body.append('file', file);
    try {
      const uploaded = await readJson(await fetch('/api/datasets', { method: 'POST', headers: { Authorization: `Bearer ${accessKey.trim()}` }, body }));
      setUploadedNames((previous) => ({ ...previous, [uploaded.id]: file.name }));
      if (!uploaded.schema?.zone_features && uploaded.schema?.service_features) onModeChange('access');
      else if (!uploaded.schema?.service_features && uploaded.schema?.zone_features) onModeChange('exposure');
      setDatasetLoading(true);
      setDatasetId(uploaded.id);
    } catch (error) { setUploadError(error.message || 'Upload failed.'); }
    finally { setUploading(false); event.target.value = ''; }
  };
  const startRun = async () => {
    if (!canRun) return;
    if (!accessKey.trim()) { document.getElementById('access-key')?.focus(); return; }
    const request = { dataset_id: datasetId, analysis_mode: mode, question, threshold_m: Number(threshold) };
    if (mode === 'compare') { request.candidate_a = candidateA.map(Number); request.candidate_b = candidateB.map(Number); if (![...request.candidate_a, ...request.candidate_b].every(Number.isFinite)) return; }
    setRunStarting(true); setRun({ id: null, status: 'starting', analysis_mode: mode, logs: [] }); setResultMap(null); setResultMapError(''); setDownloadError('');
    try {
      const created = await readJson(await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessKey.trim()}` }, body: JSON.stringify(request) }));
      setActiveRunId(created.id); activeRunIdRef.current = created.id;
    } catch (error) { setRun({ id: null, status: 'failed', analysis_mode: mode, error: error.message || 'Could not start run.', logs: [] }); }
    finally { setRunStarting(false); }
  };
  const onDownload = useCallback(async (runId, name) => {
    setDownloadError('');
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${accessKey.trim()}` } });
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a');
      a.href = url; a.download = name; a.style.position = 'fixed'; a.style.left = '-10000px'; document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setDownloadError(`${name}: ${error.message || 'download failed'}`); }
  }, [accessKey]);

  const sourceNote = datasetId === 'sf2020'
    ? <>2020 Census TIGERweb POP100 + selected parks inventory. Candidate coordinates are illustrative; inventory coverage has documented limits. <a href="/api/source-manifest" target="_blank" rel="noreferrer">Source dataset ↗</a></>
    : datasetId === 'demo' ? 'Fabricated features for demonstration and testing. They do not describe a real neighborhood.'
      : datasetId ? 'User supplied EPSG:4326 GeoJSON. Feature roles and population field were validated.' : '';
  const featureCount = schema ? `${schema.population_features} population areas · ${schema.service_features} services · ${schema.zone_features} zones` : datasetLoading ? 'Loading map data…' : 'No dataset loaded';
  const onCandidateChange = useCallback((which, position) => (which === 'A' ? setCandidateA : setCandidateB)(position), []);
  const mapTitle = datasetId === 'sf2020' ? 'San Francisco · 2020 Census + selected parks' : datasetId === 'demo' ? 'Harborview · synthetic fixture' : uploadedNames[datasetId] ?? 'Uploaded GeoJSON';

  return <>
    <header className="topbar"><a className="brand" href="/"><span className="brand-icon">⌖</span> GEOSCOPE</a><div className="topmeta"><span className={`live-dot${worker.ok ? '' : ' offline'}`}></span><span title={worker.message}>{worker.ok ? 'WORKER READY' : 'WORKER UNAVAILABLE'}</span><span className="top-divider"></span><span>FIELD NOTE&nbsp; 01</span></div></header>
    <main className="shell">
      <section className="intro"><div><div className="eyebrow">POPULATION · PLACES · PATTERNS</div><h1>Ask a question.<br />See it on the map.</h1><p className="lede">A geospatial analyst for service access, candidate sites, and population inside supplied zones. Inspect the method, map, and generated code.</p></div><div className="issue-stamp"><span>RESEARCH<br />DESK</span><span className="stamp-mark">✳</span></div></section>
      <div className="workspace"><aside className="controls">
        <div className="section-heading"><span className="number">01</span><div><h2>Set the study area</h2><p>Choose source features and an analysis.</p></div></div>
        <label htmlFor="dataset">Population + places or zones</label>
        <select id="dataset" value={datasetId} onChange={(e) => { setDatasetLoading(true); setDatasetId(e.target.value); }} disabled={!config || uploading || runStarting || Boolean(activeRunId)}>
          {config?.real && <option value="sf2020">San Francisco · 2020 Census + parks</option>}{config?.demo && <option value="demo">Harborview · synthetic fixture</option>}
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
          <div id="threshold-group" hidden={mode === 'exposure'}><label htmlFor="threshold">Access threshold</label><div className="unit-input"><input id="threshold" type="number" min="100" max="5000" step="100" value={threshold} onChange={(e) => setThreshold(e.target.value)} /><span>m</span></div></div>
          <div id="distance-type" hidden={mode === 'exposure'}><label>Distance type</label><div className="static-input">Straight line <span>↗</span></div></div>
        </div>
        <div id="candidate-controls" hidden={mode !== 'compare'}><div className="section-heading second"><span className="number">02</span><div><h2>Compare candidate sites</h2><p>Use longitude, latitude in EPSG:4326. Drag pins or edit.</p></div></div>
          <CandidateInput letter="A" candidate={candidateA} onChange={setCandidateA} /><CandidateInput letter="B" candidate={candidateB} onChange={setCandidateB} />
        </div>
        <label htmlFor="question" className="question-label">What should the agent answer?</label>
        <textarea id="question" rows="3" value={question} onChange={(e) => { setQuestion(e.target.value); setQuestionEdited(true); }} />
        <div className="access-key-wrap"><label htmlFor="access-key">Analysis access key</label><input id="access-key" type="password" placeholder="Provided by your research lead" autoComplete="off" value={accessKey} onChange={(e) => { setAccessKey(e.target.value); try { sessionStorage.setItem(ACCESS_KEY, e.target.value.trim()); } catch { /* no storage */ } }} /><small>Needed to start a run. The key stays in this tab.</small></div>
        <button id="run-button" className="run-button" type="button" disabled={!canRun} onClick={startRun}><span className="button-icon">↗</span><span>{runStarting ? 'Starting…' : activeRunId ? 'Analysis running…' : 'Run the analysis'}</span><span className="button-arrow">→</span></button>
        <div className="method-note"><span className="note-icon">ⓘ</span><p>Distances are straight-line in a local projected CRS. Census polygon representative points provide a population proxy; routes, access barriers, and actual use are not measured. Exposure assigns each polygon’s full population weight by its representative point and is an approximation.</p></div>
      </aside><section className="map-panel">
        <div className="map-head"><div><div className="eyebrow">SPATIAL OVERVIEW</div><h2>{mapTitle}</h2></div><div className="map-legend"><span><i className="legend-dot people"></i>Population</span><span><i className="legend-dot park"></i>Service</span><span><i className="legend-dot zone"></i>Zone</span>{mode === 'compare' && <span><i className="legend-dot cand"></i>Candidate</span>}</div></div>
        <LeafletMap data={dataset} datasetId={datasetId} resultData={resultMap} mode={mode} candidateA={candidateA} candidateB={candidateB} onCandidateChange={onCandidateChange} />
        <div className="map-foot"><span>{featureCount}</span><span>© OpenStreetMap contributors</span></div>{resultMapError && <div role="alert">{resultMapError}</div>}
        <ResultsPanel run={run} onDownload={onDownload} downloadError={downloadError} />
      </section></div>
      <footer><span>GEOSCOPE / A SMALL GIS AGENT</span><span>Metrics and map are checked against a fixed GIS reference.</span></footer>
    </main>
  </>;
}
