import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LeafletMap from './components/LeafletMap.jsx';
import { DEFAULT_DESIGN, DEFAULT_WALK, explainScenarioCandidate, makeScenarioRequest, validateBuilding, validateDesign, validateStudyArea, validateWalk } from './scenario.js';
const ScenarioViewer = lazy(() => import('./components/ScenarioViewer.jsx'));

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const COPY = {
  scenario: 'Design a facility on each supplied plot, preserve usable open space, and compare nearby walking access before and after.',
  compare: 'Which of two candidate locations newly serves more residents within the service radius?',
  access: 'Which population areas are farthest from the nearest mapped service?',
  exposure: 'What population estimate falls inside the selected study area?',
};
const FEATURED_MODES = [['scenario', 'Design & compare'], ['compare', 'Compare two locations']];
const LEGACY_MODES = [['access', 'Find nearby services'], ['exposure', 'Estimate population in an area']];
const MODES = [...FEATURED_MODES, ...LEGACY_MODES];
const MODE_PRIORITY = ['scenario', 'compare', 'access', 'exposure'];
const isFeaturedMode = (value) => value === 'scenario' || value === 'compare';
const SCENARIO_BUNDLED_IDS = new Set(['nycland', 'localdemo']);
const SERVICE_TYPES = [['clinic', 'Clinic'], ['library', 'Library'], ['school', 'School'], ['community_center', 'Community centre']];
const DEFAULT_BUILDING = { width_m: 24, depth_m: 18, height_m: 12, setback_m: 3 };

const FACILITY_LABEL = { clinic: 'clinic', library: 'library', school: 'school', community_center: 'community centre' };
const FACILITY_PLURAL = { clinic: 'clinics', library: 'libraries', school: 'schools', community_center: 'community centres' };
const STATUS_LABEL = { starting: 'Starting', queued: 'Queued', running: 'Working', completed: 'Done', failed: 'Stopped', interrupted: 'Stopped' };
const MODE_NEED = { scenario: 'candidate plots', access: 'mapped services', compare: 'mapped services', exposure: 'population areas' };
function facilityLabel(type) { return FACILITY_LABEL[type] || 'facility'; }
function facilityPlural(type) { return FACILITY_PLURAL[type] || 'facilities'; }
function statusLabel(status) { return STATUS_LABEL[status] || status || 'Unknown'; }
function runBlockedReason({ config, worker, dataset, datasetLoading, datasetError, runStarting, activeRunId, uploading, areaSelectionActive, mode, allowed, studyArea, building, designMode = true, design = DEFAULT_DESIGN, walk = DEFAULT_WALK }) {
  if (!config) return 'Loading service settings…';
  if (!config.analysis_enabled) return 'Analysis is not enabled on this server.';
  if (worker.status === 'checking') return 'Waiting for the analysis service…';
  if (!worker.ok) return 'Analysis service is unavailable. Use Retry check above, then try again.';
  if (datasetLoading) return 'Still loading the selected dataset…';
  if (datasetError) return `Dataset problem: ${datasetError}`;
  if (!dataset) return 'Choose a dataset before running.';
  if (uploading) return 'Finish uploading before running.';
  if (areaSelectionActive) return 'Finish drawing the study area (two opposite map corners), then run.';
  if (runStarting || activeRunId) return 'An analysis is already in progress.';
  if (!allowed) return `This task needs ${MODE_NEED[mode] || 'matching layers'} in the selected dataset.`;
  if (mode === 'exposure' || mode === 'scenario') {
    const areaError = validateStudyArea(studyArea);
    if (areaError) return areaError;
  }
  if (mode === 'scenario') {
    const designError = designMode ? validateDesign(design) || validateWalk(walk) : validateBuilding(building);
    if (designError) return designError;
  }
  return '';
}
const roleOf = (f) => f?.properties?.layer === 'park' ? 'service' : f?.properties?.layer;
const defaultCandidates = (id, dataset) => {
  if (id === 'sf2020' || id === 'localdemo') return [[-122.43, 37.77], [-122.42, 37.76]];
  if (id === 'nyc2020') return [[-73.9832, 40.7536], [-73.9903, 40.7359]];
  if (id === 'nycland') return [[-73.942, 40.798], [-73.938, 40.804]];
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
  if (id === 'nyc2020') return [-73.995, 40.748, -73.970, 40.764];
  if (id === 'nycland') return [-73.955, 40.790, -73.930, 40.812];
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
  const agenticDesign = Boolean(run.design || run.result?.metrics?.design);
  if (!run.plan && !run.summary && !files.length && !run.attempts?.length && !run.logs?.length) return null;
  return <details className="technical-details" open={failed}>
    <summary>Technical details and files</summary>
    {run.summary && <details><summary>Agent explanation</summary><p>{run.summary}</p></details>}
    {run.plan && <details><summary>Analysis method</summary><pre>{run.plan}</pre><ul className="caveats">
      {verified && <li>Metrics and per-feature results matched a fixed GIS reference calculation.</li>}
      <li>{agenticDesign ? 'Walking times are estimated on the supplied street network; connectors are inferred, entrances are not verified, and population points are coarse census weights.' : run.analysis_mode === 'scenario' ? 'Distances are straight-line to mapped facility records, not walking routes.' : 'Distances are straight-line; population-area representative points are a proxy.'}</li>
      <li>{agenticDesign ? `Submitted designs rank by ${run.result?.metrics?.ranking_basis || 'verified land and walking outcomes'}.` : run.analysis_mode === 'exposure' ? 'Each census area’s full population estimate is assigned by its representative point. This is an estimate for the drawn area, not an exact resident count.' : run.analysis_mode === 'compare' ? 'Candidate ranking is based on newly served population within the selected threshold.' : run.analysis_mode === 'scenario' ? 'Eligible plots are ranked by distance to mapped facilities and by plot area, not by census population.' : 'Population proximity is not a walking route or a measure of actual access.'}</li>
      <li>{run.synthetic ? 'Synthetic fixture only; not real-world evidence.' : `Source: ${run.dataset_name}.`}</li>
    </ul></details>}
    {files.length > 0 && <div className="downloads">{files.map((name) => <button className="download-link" type="button" key={name} onClick={() => onDownload(run.id, name)}>{name} ↓</button>)}{downloadError && <span role="alert" className="download-error">{downloadError}</span>}</div>}
    {run.attempts?.length > 0 && <details className="trace attempt-diagnostics" open={failed}><summary>Execution diagnostics ({run.attempts.length} attempts)</summary>{run.attempts.map((attempt, index) => <section key={`${attempt.attempt ?? index}-${attempt.script_file ?? index}`}><b>Attempt {attempt.attempt ?? index + 1} · {attempt.status || 'unknown'}</b>{attempt.script_file && <p>Script: {attempt.script_file}</p>}{(attempt.diagnostics?.message || attempt.message || attempt.stderr) && <p>{attempt.diagnostics?.message || attempt.message}</p>}{(attempt.diagnostics?.stderr || attempt.stderr) && <pre aria-label={`Attempt ${attempt.attempt ?? index + 1} stderr`}>{attempt.diagnostics?.stderr || attempt.stderr}</pre>}{(attempt.diagnostics?.stdout || attempt.stdout) && <pre aria-label={`Attempt ${attempt.attempt ?? index + 1} stdout`}>{attempt.diagnostics?.stdout || attempt.stdout}</pre>}</section>)}</details>}
    {run.logs?.length > 0 && <details className="trace"><summary>Run trace</summary><div id="logs">{run.logs.map((log, i) => <div className="log-row" key={`${log.time ?? i}-${i}`}><b>{(log.status || 'step').toUpperCase()}</b> · {log.text}</div>)}</div></details>}
  </details>;
}
function ResultsPanel({ run, onDownload, downloadError, dataset, selectedScenarioCandidate, onSelectScenarioCandidate, scenarioView, onScenarioViewChange }) {
  if (!run) return null;
  const m = run.result?.metrics ?? {};
  const failed = ['failed', 'interrupted'].includes(run.status);
  const files = Object.entries(run.artifacts ?? {}).filter(([name, available]) => available === true && /^(analysis\.py|result\.json|result\.geojson|request\.json|trace\.json|analysis-attempt-[1-3]\.py)$/.test(name)).map(([name]) => name);
  const verified = run.status === 'completed' && (run.result?.reference_verified === true || (run.demo_mode === true && run.result?.geometry_verified === true));
  const n = (x) => x == null ? 'N/A' : Number(x).toLocaleString();
  const d = (x) => x == null ? 'N/A' : `${Number(x).toFixed(0)} m`;
  const areaLabel = (x) => x == null ? 'N/A' : `${Number(x).toLocaleString(undefined, { maximumFractionDigits: 0 })} m²`;
  const minutesLabel = (x) => x == null ? 'N/A' : `${Number(x).toFixed(1)} min`;
  const facilityName = facilityLabel(m.service_type);
  const pluralFacility = facilityPlural(m.service_type);
  if (run.status === 'completed' && run.result && run.analysis_mode === 'scenario' && verified) {
    const best = selectedScenarioCandidate ?? m.candidates?.[0] ?? null;
    const existingCount = m.existing_services_in_area ?? m.existing_service_counts?.[m.service_type] ?? null;
    const inventory = m.service_inventory ?? {};
    const inventoryLabel = String(inventory.source ?? '').includes('OpenStreetMap') ? 'OpenStreetMap' : inventory.source || 'source not recorded';
    const scenarioStatus = String(dataset?.scenario_status ?? '').toLowerCase();
    const landIsSimulated = scenarioStatus.includes('simulat') || scenarioStatus.includes('mock') || String(m.land_inventory?.source ?? '').toLowerCase().includes('simulat');
    const selectedRank = best ? (m.candidates ?? []).findIndex((candidate) => candidate.id === best.id) + 1 : 0;
    const selectedReasons = best ? explainScenarioCandidate(best, m.candidates ?? [], m) : [];
    const agentic = Boolean(m.design);
    const bestHeadline = !best ? '' : agentic
      ? `${areaLabel(best.design?.gross_floor_area_m2)} floor area · ${best.design?.floors ?? '—'} floors · ${best.design?.usable_open_space_pct == null ? 'open-space result unknown' : `${Number(best.design.usable_open_space_pct).toFixed(0)}% usable open space`}`
      : best.nearest_existing_service_m == null
        ? `${areaLabel(best.plot_area_m2)} plot · no mapped ${facilityName} in the inventory`
        : `${areaLabel(best.plot_area_m2)} plot · ${d(best.nearest_existing_service_m)} from nearest mapped ${facilityName}`;
    return <div className="result-panel scenario-result-layout">
      <header className="result-outcome">
        <div className="result-top"><div><div className="eyebrow">{run.demo_mode ? 'MOCK' : 'RESULTS'}</div><h2>{agentic ? 'Design & compare' : 'Facility sites'}</h2></div><span className="status-pill">{run.demo_mode ? 'Mock · geometry checked' : 'Checked'}</span></div>
        <div className="scenario-headline" id="summary"><strong>{agentic ? `${n(m.sites_evaluated)} checked designs` : `${n(m.eligible_sites)} of ${n(m.sites_evaluated)} plots fit`}</strong><span>{agentic ? `${m.sites_available == null ? '—' : n(m.sites_available)} source plots · building layout and open space fitted to each submitted plot.` : 'Footprint checked against plot, area, and obstruction layers.'}</span></div>
        {best && <div className="scenario-best"><b>Site {selectedRank}</b><span>{bestHeadline}</span></div>}
      </header>
      <div className="result-main">
        <div className="result-summary">
          <h3 className="scenario-subhead">{agentic ? 'Ranked designs' : 'Ranked sites'}</h3>
          {m.candidates?.length ? <div className="scenario-rankings" role="list">{m.candidates.map((candidate, index) => <button type="button" role="listitem" className={`scenario-rank${best?.id === candidate.id ? ' selected' : ''}`} key={candidate.id} onClick={() => onSelectScenarioCandidate(candidate)} aria-pressed={best?.id === candidate.id}>
            <span className="rank-number" aria-label={`Rank ${index + 1}`}>{index + 1}</span>
            <span className="rank-main"><b>Site {index + 1}</b><small className="rank-meta">Plot {candidate.id} · {areaLabel(candidate.plot_area_m2)} · {agentic ? `${candidate.design?.floors ?? '—'} floors · ${areaLabel(candidate.design?.gross_floor_area_m2)} gross` : `${candidate.land_check?.setback_m ?? '—'} m setback`}</small></span>
            <span className="rank-pop">{agentic ? (candidate.design?.usable_open_space_pct == null ? 'N/A' : `${Number(candidate.design.usable_open_space_pct).toFixed(0)}%`) : candidate.nearest_existing_service_m == null ? areaLabel(candidate.plot_area_m2) : d(candidate.nearest_existing_service_m)}<small>{agentic ? 'usable open space' : candidate.nearest_existing_service_m == null ? 'plot area' : `to nearest ${facilityName}`}</small></span>
          </button>)}</div> : <p className="panel-state empty">{agentic ? 'No submitted plot produced a design that meets these goals.' : 'No eligible plot passed the footprint checks.'}</p>}
          {best && agentic && <section className="design-comparison" aria-label="Walking access comparison">
            <div className="comparison-switch" role="group" aria-label="Show proposed design"><button type="button" aria-pressed={scenarioView === 'before'} onClick={() => onScenarioViewChange('before')}>Before</button><button type="button" aria-pressed={scenarioView === 'after'} onClick={() => onScenarioViewChange('after')}>After</button></div>
            <h3>{scenarioView === 'before' ? 'Current walking access' : 'Walking access with this facility'}</h3>
            <p className="existing-facility-count"><b>Already nearby:</b> {n(existingCount)} mapped {existingCount === 1 ? facilityName : pluralFacility}</p>
            {best.access?.status === 'unavailable' && <p className="scenario-caveat">Walking access could not be estimated{best.access.reason ? `: ${best.access.reason}` : '.'}</p>}
            <div className="access-metrics">
              <MetricCard value={n(best.access?.before_served_population)} label="estimated people served before" />
              <MetricCard value={n(best.access?.after_served_population)} label="estimated people served after" />
              <MetricCard value={n(best.access?.baseline_known === true ? best.access.newly_served_population : null)} label="estimated newly served" />
              <MetricCard value={minutesLabel(best.access?.before_mean_minutes)} label="mean walk before" />
              <MetricCard value={minutesLabel(best.access?.after_mean_minutes)} label="mean walk after" />
              <MetricCard value={minutesLabel(best.access?.mean_walk_reduction_minutes)} label="mean walk reduction" />
            </div>
            <p className="scenario-caveat">Compared population: {n(best.access?.compared_population)} · unmatched population: {n(best.access?.unmatched_population)}. {best.access?.baseline_known === false ? 'Before access and change are unknown because no connected facility inventory was supplied.' : best.access?.baseline_known == null ? 'Before-baseline availability was not reported.' : best.access?.newly_served_population > 0 ? `${n(best.access.newly_served_population)} people move inside the walking limit (${Number(best.access.newly_served_pct ?? 0).toFixed(1)}% of compared population).` : 'This design does not add people inside the walking limit at the selected threshold; the reduction card shows any shorter walks within the already-served population.'} {best.access?.baseline_known === true ? `Walking reach uses a ${best.access.minutes ?? '—'} minute limit at ${best.access.speed_mps ?? '—'} m/s.` : ''} Population points are coarse census weights; connectors are inferred and entrances are not verified.</p>
            <details className="design-rationale"><summary>Why this design</summary><p>{best.design?.floors ?? 'Unknown'} floors provide {areaLabel(best.design?.gross_floor_area_m2)} gross floor area. The design reserves {best.design?.usable_open_space_pct == null ? 'an unknown share' : `${Number(best.design.usable_open_space_pct).toFixed(1)}% usable open space`} against a {m.design?.min_open_space_pct ?? 'unknown'}% minimum goal. {best.design?.strategy ? `Design approach: ${best.design.strategy}. ` : ''}Ranked among submitted designs by {m.ranking_basis || 'service gap, then usable open-space share, then plot ID'}.</p></details>
            <p className="scenario-caveat">{scenarioView === 'before' ? 'The proposed building and reserved open space are hidden in this view.' : 'Green shows reserved open space; it is not a mapped park or an environmental certification.'}</p>
          </section>}{best && !agentic && selectedReasons.length > 0 && <section className="scenario-reasoning" aria-labelledby="scenario-reasoning-title"><h3 id="scenario-reasoning-title">Why Site {selectedRank} is ranked here</h3><ul>{selectedReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><p>Order: farthest from mapped {facilityName}, then largest plot, then plot ID.</p></section>}
          <details className="result-context">
            <summary>{agentic ? 'Sources & assumptions' : 'Area context & limits'}</summary>
            {!agentic && <div className="scenario-existing-service"><b>Already nearby</b><strong>{n(existingCount)} mapped {existingCount === 1 ? facilityName : pluralFacility}</strong><span>Mapped inventory may be incomplete.</span>{(inventory.source || inventory.as_of) && <small>Source: {inventoryLabel}{inventory.as_of ? ` · ${inventory.as_of}` : ''}</small>}{m.existing_service_counts && <details><summary>Counts by type</summary><p>{Object.entries(m.existing_service_counts).map(([type, count]) => `${facilityLabel(type)}: ${n(count)}`).join(' · ')}</p></details>}</div>}
            {!agentic && <p className="scenario-caveat">Facility services and land evidence are {landIsSimulated ? 'simulated plots checked against mapped buildings and road corridors, alongside mapped facility records' : 'limited to supplied records'}. Distances are straight-line, not walking routes. This does not establish real land availability, ownership, zoning approval, or permits.</p>}
            {agentic && <><p className="scenario-caveat">Walking access is an estimate from the supplied street network. Connectors are inferred and entrances are not verified. Population weights are coarse census estimates. Green reserved space is not a mapped park or an environmental certification. Plot status does not establish ownership, zoning approval, or permits.</p><p className="scenario-caveat">Walking network: {best.access?.network_source || 'source not recorded'} · {best.access?.network_as_of || 'date unknown'}.</p></>}
            {(m.site_checks?.length > 0 || m.land_inventory) && <div className="scenario-sources-inline">{m.land_inventory && <div><b>Land evidence · {m.land_inventory.as_of || 'date unknown'}</b><p>{m.land_inventory.source || 'Source not recorded'}</p></div>}{m.site_checks?.length > 0 && <ul className="site-checks">{m.site_checks.map((site) => <li key={site.id}><b>{site.id}: {site.status}</b> · {site.reason} <span>Evidence: {site.source || 'not supplied'}</span></li>)}</ul>}</div>}
          </details>
        </div>
        {best && <div className="result-scene"><h3 className="scenario-subhead">3D view</h3><Suspense fallback={<div className="panel-state" role="status">Preparing 3D footprint view…</div>}><ScenarioViewer area={m.study_area} candidate={best} building={best.building ?? m.building} serviceType={m.service_type} dataset={dataset} scenarioView={scenarioView} agentic={agentic} /></Suspense></div>}
      </div>
      <div className="result-footer"><RunTechnicalDetails run={run} files={files} onDownload={onDownload} downloadError={downloadError} failed={failed} verified={verified} /></div>
    </div>;
  }
  let cards = [];
  const title = failed ? 'Run stopped' : ({ access: 'Nearby services', compare: 'Comparison', exposure: 'Population', scenario: 'Facility sites' }[run.analysis_mode] ?? 'Analysis');
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
      <MetricCard key="served" value={n(m.baseline?.served_population)} label="people within walking-range threshold" />,
      <MetricCard key="underserved" value={n(m.baseline?.underserved_population)} label="people beyond threshold" />,
      <MetricCard key="distance" value={d(m.baseline?.weighted_mean_nearest_m)} label="avg. straight-line distance" />,
    ];
  }
  const headline = failed ? (run.error || run.summary || 'The analysis could not be completed.') : run.status === 'completed' && run.analysis_mode === 'exposure' ? `${n(m.inside_population)} estimated people inside the selected area` : run.status === 'completed' && run.analysis_mode === 'compare' ? `Site ${run.result?.comparison?.preferred_candidate ?? 'tie'} is preferred` : run.status === 'completed' ? `${n(m.baseline?.served_population)} estimated people within ${n(m.threshold_m ?? run.threshold_m)} m` : run.status === 'starting' ? 'Starting the analysis…' : 'Analysis is running. Outcomes will appear here when it finishes.';
  const missingPopulationCoverage = failed && String(run.error ?? '').startsWith('No population sample points fall inside the selected area.');
  return <div className="result-panel">
    <header className="result-outcome">
      <div className="result-top"><div><div className="eyebrow">{verified ? 'RESULTS' : failed ? 'ATTENTION' : 'RUNNING'}</div><h2>{title}</h2></div><span className={`status-pill${failed ? ' failed' : ''}`}>{statusLabel(run.status)}</span></div>
      <p id="summary" className="result-headline">{headline}</p>
    </header>
    {missingPopulationCoverage && <section className="run-recovery" aria-labelledby="population-recovery-title"><h3 id="population-recovery-title">Choose a larger study area</h3><p>The population layer uses one representative point for each supplied area. Draw a rectangle that contains at least one of those points, or upload finer local population data. The land check did not run and no model request was made.</p></section>}
    {cards.length > 0 && <div className="metrics">{cards}</div>}
    {run.status === 'completed' && <details className="result-context"><summary>Estimate limits</summary><p className="result-caveat">Population estimates use census-area representative points; this is not an exact address-level count. Service distances are straight-line, not routes.</p></details>}
    <div className="result-footer"><RunTechnicalDetails run={run} files={files} onDownload={onDownload} downloadError={downloadError} failed={failed} verified={verified} /></div>
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
  const [uploadedMeta, setUploadedMeta] = useState({});
  const uploadedNames = useMemo(() => Object.fromEntries(Object.entries(uploadedMeta).map(([id, meta]) => [id, meta.name])), [uploadedMeta]);
  const [mode, setMode] = useState('scenario');
  const [threshold, setThreshold] = useState(400);
  const [studyArea, setStudyArea] = useState(null);
  const [areaSelectionActive, setAreaSelectionActive] = useState(false);
  const [serviceType, setServiceType] = useState('clinic');
  const [building, setBuilding] = useState(DEFAULT_BUILDING);
  const [designMode, setDesignMode] = useState(true);
  const [design, setDesign] = useState(DEFAULT_DESIGN);
  const [walk, setWalk] = useState(DEFAULT_WALK);
  const [scenarioView, setScenarioView] = useState('after');
  const [selectedScenarioCandidate, setSelectedScenarioCandidate] = useState(null);
  const [candidateA, setCandidateA] = useState([-122.43, 37.77]);
  const [candidateB, setCandidateB] = useState([-122.42, 37.76]);
  const [question, setQuestion] = useState(COPY.scenario);
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
  const datasetSupportsScenario = useCallback((id, meta = uploadedMeta) => {
    if (!id) return false;
    if (SCENARIO_BUNDLED_IDS.has(id)) return true;
    const bundled = [config?.nyc_land, config?.scenario_demo, config?.nyc, config?.real, config?.demo].filter(Boolean);
    const entry = bundled.find((item) => item.id === id);
    if (entry && typeof entry.scenario_capable === 'boolean') return entry.scenario_capable;
    return (meta[id]?.schema?.candidate_site_features ?? 0) > 0;
  }, [config, uploadedMeta]);
  const datasetCatalog = useMemo(() => {
    const rows = [];
    if (config?.nyc_land) rows.push({ id: config.nyc_land.id, label: 'East Harlem', scenario: datasetSupportsScenario(config.nyc_land.id), compare: true });
    if (config?.scenario_demo) rows.push({ id: config.scenario_demo.id, label: 'San Francisco', scenario: datasetSupportsScenario(config.scenario_demo.id), compare: true });
    if (config?.nyc) rows.push({ id: config.nyc.id, label: 'New York', scenario: false, compare: true });
    if (config?.real) rows.push({ id: config.real.id, label: 'San Francisco', scenario: false, compare: true });
    if (config?.demo) rows.push({ id: config.demo.id, label: 'Harborview', scenario: false, compare: true });
    for (const [id, meta] of Object.entries(uploadedMeta)) {
      const scenario = (meta.schema?.candidate_site_features ?? 0) > 0;
      const compare = scenario || (meta.schema?.service_features ?? 0) > 0;
      const exposure = (meta.schema?.population_features ?? 0) > 0;
      rows.push({ id, label: meta.name || 'Uploaded GeoJSON', scenario, compare, exposure });
    }
    return rows;
  }, [config, uploadedMeta, datasetSupportsScenario]);
  const visibleDatasets = useMemo(() => {
    if (mode === 'scenario') return datasetCatalog.filter((row) => row.scenario);
    if (mode === 'compare' || mode === 'access') return datasetCatalog.filter((row) => row.compare || row.scenario);
    if (mode === 'exposure') return datasetCatalog.filter((row) => row.exposure !== false);
    return datasetCatalog;
  }, [datasetCatalog, mode]);

  const canRun = Boolean(config?.analysis_enabled && worker.ok && dataset && !datasetLoading && !runStarting && !activeRunId && !uploading && !areaSelectionActive && modeAllowed(mode) && (mode === 'exposure' ? !validateStudyArea(studyArea) : mode !== 'scenario' || (!validateStudyArea(studyArea) && !(designMode ? (validateDesign(design) || validateWalk(walk)) : validateBuilding(building)))));
  useEffect(() => {
    if (mode !== 'scenario' || !config) return;
    if (datasetId && datasetSupportsScenario(datasetId)) return;
    const fallback = visibleDatasets[0]?.id;
    if (fallback) {
      if (fallback !== datasetId && !datasetLoading) {
        setDatasetLoading(true);
        setDatasetId(fallback);
      }
      return;
    }
    // Facility-site datasets are unavailable in this install — use Compare instead of an empty picker.
    setMode('compare');
  }, [mode, config, datasetId, datasetLoading, datasetSupportsScenario, visibleDatasets]);


  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const c = await readJson(await fetch('/api/config', { signal: controller.signal }));
        setConfig(c);
        setDatasetId(c.nyc_land?.id ?? c.scenario_demo?.id ?? c.nyc?.id ?? c.real?.id ?? c.demo?.id ?? 'demo');
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
    const url = datasetId === 'demo' ? '/api/datasets/demo' : datasetId === 'sf2020' ? '/api/datasets/real' : datasetId === 'nyc2020' ? '/api/datasets/nyc2020' : datasetId === 'nycland' ? '/api/datasets/nycland' : `/api/datasets/${encodeURIComponent(datasetId)}`;
    setDatasetLoading(true); setDatasetError(''); setDataset(null); setRun(null); setActiveRunId(null);
    activeRunIdRef.current = null; setResultMap(null); setResultMapError(''); setDownloadError('');
    setCandidateA(defaultCandidates(datasetId)[0]); setCandidateB(defaultCandidates(datasetId)[1]); setThreshold(400); setStudyArea(null); setAreaSelectionActive(false); setSelectedScenarioCandidate(null); setBuilding(DEFAULT_BUILDING); setDesignMode(true); setDesign(DEFAULT_DESIGN); setWalk(DEFAULT_WALK); setScenarioView('after');
    fetch(url, { signal: controller.signal }).then(readJson).then((data) => {
      if (revision !== datasetRevision.current) return;
      setDataset(data);
      const suggestions = defaultCandidates(datasetId, data); setCandidateA(suggestions[0]); setCandidateB(suggestions[1]);
      setStudyArea(defaultStudyArea(datasetId, data));
      const plotCoordinates = (data.features ?? []).filter((f) => roleOf(f) === 'candidate_site').flatMap((f) => { const out = []; const walk = (v) => Array.isArray(v) && (typeof v[0] === 'number' ? out.push(v) : v.forEach(walk)); walk(f.geometry?.coordinates); return out; });
      if (datasetId === 'localdemo') setStudyArea([-122.433, 37.758, -122.417, 37.776]);
      else if (datasetId === 'nycland') setStudyArea([-73.955, 40.790, -73.930, 40.812]);
      else if (plotCoordinates.length) { const centerLon = plotCoordinates.reduce((sum, point) => sum + point[0], 0) / plotCoordinates.length; const centerLat = plotCoordinates.reduce((sum, point) => sum + point[1], 0) / plotCoordinates.length; setStudyArea([centerLon - 0.005, centerLat - 0.005, centerLon + 0.005, centerLat + 0.005].map((v) => Number(v.toFixed(6)))); }
      setMode((previous) => {
        const nextSchema = { population_features: data.features?.filter((f) => roleOf(f) === 'population').length ?? 0, service_features: data.features?.filter((f) => roleOf(f) === 'service').length ?? 0, zone_features: data.features?.filter((f) => roleOf(f) === 'zone').length ?? 0, candidate_site_features: data.features?.filter((f) => roleOf(f) === 'candidate_site').length ?? 0 };
        const supported = config?.supported_modes ?? MODES.map(([id]) => id);
        const usable = (candidate) => supported.includes(candidate) && (candidate === 'scenario' ? nextSchema.candidate_site_features > 0 : candidate === 'exposure' ? nextSchema.population_features > 0 : nextSchema.service_features > 0);
        if ((datasetId === 'localdemo' || datasetId === 'nycland') && usable('scenario')) return 'scenario';
        if (usable(previous) && isFeaturedMode(previous)) return previous;
        const featured = MODE_PRIORITY.filter(isFeaturedMode).find(usable);
        if (featured) return featured;
        if (usable(previous)) return previous;
        return MODE_PRIORITY.find(usable) ?? 'scenario';
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
      setUploadedMeta((previous) => ({ ...previous, [uploaded.id]: { name: file.name, schema: uploaded.schema ?? {} } }));
      if (uploaded.schema?.candidate_site_features) onModeChange('scenario');
      else if (uploaded.schema?.service_features) onModeChange('compare');
      else if (uploaded.schema?.population_features || uploaded.schema?.zone_features) onModeChange('exposure');
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
      Object.assign(request, makeScenarioRequest({ datasetId, question, studyArea, serviceType, designMode, design, walk, building }));
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
    : datasetId === 'nycland' ? <>Official East Harlem extract: MapPLUTO vacant tax lots, DoITT building footprints, CSCL streets, 2020 Census, and FacDB facilities. Vacant-land class is not a sale or permit finding. <a href="/api/nyc-land-source-manifest" target="_blank" rel="noreferrer">Source dataset ↗</a></>
    : datasetId === 'nyc2020' ? <>2020 Census tracts for all five boroughs, selected NYC Parks properties, and FacDB clinics, libraries, schools, and community centers. Candidate coordinates are illustrative. <a href="/api/nyc-source-manifest" target="_blank" rel="noreferrer">Source dataset ↗</a></>
    : datasetId === 'localdemo' ? '2020 Census population + mapped OpenStreetMap facilities, buildings, and roads; simulated candidate plots. No real land availability is implied.'
    : datasetId === 'demo' ? 'Fabricated features for demonstration and testing. They do not describe a real neighborhood.'
      : datasetId ? 'User supplied EPSG:4326 GeoJSON. Feature roles and population field were validated.' : '';
  const onCandidateChange = useCallback((which, position) => { (which === 'A' ? setCandidateA : setCandidateB)(position); setRun(null); setResultMap(null); setResultMapError(''); }, []);
  const mapTitle = datasetId === 'localdemo' || datasetId === 'sf2020' ? 'San Francisco' : datasetId === 'nycland' ? 'East Harlem' : datasetId === 'nyc2020' ? 'New York' : datasetId === 'demo' ? 'Harborview' : uploadedNames[datasetId] ?? 'Uploaded GeoJSON';
  const blockedReason = runBlockedReason({ config, worker, dataset, datasetLoading, datasetError, runStarting, activeRunId, uploading, areaSelectionActive, mode, allowed: modeAllowed(mode), studyArea, building, designMode, design, walk });
  const modeHint = COPY[mode];

  return <div className="app-frame">
    {config?.demo_mode && <div className="scenario-demo-banner global">LOCAL MOCK MODE — no LLM, no generated-code execution, no cloud inference.</div>}
    <header className="topbar"><a className="brand" href="/"><span className="brand-icon">⌖</span> GEOSCOPE</a><div className="topmeta"><span className={`live-dot${worker.ok ? '' : ' offline'}`}></span><span title={worker.message}>{config?.demo_mode ? 'LOCAL MOCK' : worker.status === 'checking' ? 'CHECKING SERVICE' : worker.ok ? 'ANALYSIS READY' : 'SERVICE UNAVAILABLE'}</span></div></header>
    <main className="shell">
      <section className="intro"><div><h1>Design a facility and compare the places it could serve.</h1><p className="lede">Choose a facility, set its needs, and compare candidate plots with walking access before and after.</p></div></section>
      <div className="workspace"><aside className="controls" aria-label="Analysis controls">
        <div className="controls-scroll">
        {worker.status !== 'ready' && <div className="worker-readiness" role="status"><span>{worker.status === 'checking' ? 'Checking analysis service…' : worker.message}</span><button type="button" onClick={() => { setWorker({ ok: false, status: 'checking', message: 'Checking worker readiness…' }); setWorkerRefresh((value) => value + 1); }} disabled={worker.status === 'checking'}>{worker.status === 'checking' ? 'Checking…' : 'Retry check'}</button></div>}

        <div className="workflow-step primary-step" data-step="1">
          <div className="section-heading"><span className="step-badge" aria-hidden="true">1</span><div><h2>Task</h2></div></div>
          <label htmlFor="analysis-mode">Task</label>
          <select id="analysis-mode" value={mode} onChange={(e) => onModeChange(e.target.value)} disabled={!dataset || datasetLoading || runStarting || Boolean(activeRunId)}>
            {FEATURED_MODES.map(([value, label]) => {
              const allowed = modeAllowed(value);
              const hint = !allowed && schema ? ` (needs ${MODE_NEED[value]})` : '';
              return <option key={value} value={value} disabled={!allowed}>{`${label}${hint}`}</option>;
            })}
            {!isFeaturedMode(mode) && LEGACY_MODES.filter(([value]) => value === mode).map(([value, label]) => (
              <option key={value} value={value}>{`${label} (basic)`}</option>
            ))}
          </select>
          <p className="task-hint">{modeHint}</p>
          {mode === 'scenario' && <>
            <label htmlFor="service-type">Facility</label>
            <select id="service-type" value={serviceType} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setServiceType(e.target.value); clearScenarioResult(); }}>{SERVICE_TYPES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
            <label className="design-mode-toggle"><input type="checkbox" checked={designMode} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setDesignMode(e.target.checked); clearScenarioResult(); }} /> <span>{designMode ? 'Agent chooses the layout' : 'Fixed footprint mode'}</span></label>
            {designMode ? <div className="design-inputs" aria-label="Design goals">
              <p className="scenario-input-note">The agent fits a building to each plot, keeps open space, and compares walking access.</p>
              <div className="building-grid">
                {[['target_floor_area_m2', 'Target floor area', 'm²', 100, 5000, 50], ['max_floors', 'Maximum floors', 'floors', 1, 6, 1], ['min_open_space_pct', 'Minimum open space', '%', 10, 85, 5]].map(([key, label, unit, min, max, step]) => <label key={key} htmlFor={`design-${key}`}>{label}<div className="unit-input"><input id={`design-${key}`} type="number" min={min} max={max} step={step} value={Number.isFinite(design[key]) ? design[key] : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setDesign((current) => ({ ...current, [key]: e.target.value === '' ? NaN : Number(e.target.value) })); clearScenarioResult(); }} /><span>{unit}</span></div></label>)}
                <label htmlFor="design-setback">Setback<div className="unit-input"><input id="design-setback" type="number" min="0" max="20" step="0.5" value={Number.isFinite(design.setback_m) ? design.setback_m : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setDesign((current) => ({ ...current, setback_m: e.target.value === '' ? NaN : Number(e.target.value) })); clearScenarioResult(); }} /><span>m</span></div></label>
              </div>
              <label htmlFor="walk-minutes">Walking time</label><div className="unit-input"><input id="walk-minutes" type="number" min="3" max="20" step="1" value={Number.isFinite(walk.minutes) ? walk.minutes : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setWalk((current) => ({ ...current, minutes: e.target.value === '' ? NaN : Number(e.target.value) })); clearScenarioResult(); }} /><span>minutes</span></div>
              {(validateDesign(design) || validateWalk(walk)) && <small role="alert">{validateDesign(design) || validateWalk(walk)}</small>}
            </div> : <p className="scenario-input-note">Use a fixed footprint and setback for a compatibility check.</p>}
          </>}
          {mode === 'compare' && <p className="park-note" role="note">Compare two proposed locations against the mapped service network. Park records count as services when the dataset includes them.</p>}
          <details className="more-modes legacy-modes">
            <summary>More tools (basic proximity / population)</summary>
            <p className="legacy-modes-note">These answer common GIS questions available elsewhere. Geoscope focuses on facility siting and candidate comparison.</p>
            <label htmlFor="legacy-mode">Basic analysis</label>
            <select id="legacy-mode" value={isFeaturedMode(mode) ? '' : mode} onChange={(e) => { if (e.target.value) onModeChange(e.target.value); }} disabled={!dataset || datasetLoading || runStarting || Boolean(activeRunId)}>
              <option value="" disabled={isFeaturedMode(mode)}>{isFeaturedMode(mode) ? 'Choose a basic tool…' : 'Using a basic tool'}</option>
              {LEGACY_MODES.map(([value, label]) => {
                const allowed = modeAllowed(value);
                const hint = !allowed && schema ? ` (needs ${MODE_NEED[value]})` : '';
                return <option key={value} value={value} disabled={!allowed}>{`${label}${hint}`}</option>;
              })}
            </select>
          </details>
        </div>

        <div className="workflow-step" data-step="2">
          <div className="section-heading"><span className="step-badge" aria-hidden="true">2</span><div><h2>Dataset</h2></div></div>
          <label htmlFor="dataset">Dataset</label>
          <select id="dataset" value={datasetId} onChange={(e) => { setDatasetLoading(true); setDatasetId(e.target.value); }} disabled={!config || uploading || runStarting || Boolean(activeRunId)}>
            {visibleDatasets.map((row) => <option value={row.id} key={row.id}>{row.label}</option>)}
          </select>
          {mode === 'scenario' && <p className="dataset-filter-note">Facility sites need parcel + land-check data (East Harlem lots or SF mock). Other city snapshots stay available under Compare.</p>}
          <div className="source-note">{datasetLoading ? <span role="status">Loading dataset…</span> : sourceNote}{datasetError && <span role="alert"> {datasetError}</span>}</div>
          <details className="upload-settings"><summary>Upload GeoJSON</summary><label className="upload-label" htmlFor="upload">Choose a GeoJSON file <span>↗</span></label><input id="upload" type="file" accept=".json,.geojson,application/geo+json,application/json" onChange={onUpload} disabled={uploading || runStarting || Boolean(activeRunId)} />{uploading && <small role="status">Uploading and validating dataset…</small>}{uploadError && <small role="alert">{uploadError}</small>}</details>
        </div>

        <div className="workflow-step" data-step="3">
          <div className="section-heading"><span className="step-badge" aria-hidden="true">3</span><div><h2>{mode === 'compare' ? 'Sites' : mode === 'scenario' || mode === 'exposure' ? 'Area' : 'Options'}</h2></div></div>
          {(mode === 'scenario' || mode === 'exposure') && <section className="study-area-controls" aria-label="Study area">
            <button type="button" className="select-area-button primary-secondary" disabled={runStarting || Boolean(activeRunId)} onClick={() => { setAreaSelectionActive((active) => !active); clearScenarioResult(); setResultMap(null); }}>{areaSelectionActive ? 'Click two opposite map corners…' : 'Draw area on map'}</button>
            {studyArea?.every(Number.isFinite) && <small className="area-readout">About {areaDimensions(studyArea)}</small>}
            {areaSelectionActive && <small role="status">Click two opposite corners on the map.</small>}
            {mode === 'exposure' && <p className="population-caveat">Uses census-area weights by representative point, not exact addresses.</p>}
            <details className="area-coordinate-details"><summary>Edit coordinates</summary><div className="bbox-fields">{[['west', 0], ['south', 1], ['east', 2], ['north', 3]].map(([label, i]) => <label key={label} htmlFor={`area-${label}`}>{label}<input id={`area-${label}`} type="number" step="0.000001" value={Number.isFinite(studyArea?.[i]) ? studyArea[i] : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { const next = studyArea ? [...studyArea] : [NaN, NaN, NaN, NaN]; next[i] = e.target.value === '' ? NaN : Number(e.target.value); setStudyArea(next); clearScenarioResult(); setResultMap(null); }} /></label>)}</div></details>
            {studyArea && validateStudyArea(studyArea) && <small role="alert">{validateStudyArea(studyArea)}</small>}
          </section>}
          <div id="candidate-controls" hidden={mode !== 'compare'}>
            <p className="step-help">Drag map pins or edit coordinates.</p>
            <CandidateInput letter="A" candidate={candidateA} disabled={runStarting || Boolean(activeRunId)} onChange={(position) => onCandidateChange('A', position)} /><CandidateInput letter="B" candidate={candidateB} disabled={runStarting || Boolean(activeRunId)} onChange={(position) => onCandidateChange('B', position)} />
          </div>
          <details className="advanced-settings advanced-bundle">
            <summary>Advanced</summary>
            {mode === 'scenario' && <div className="advanced-block" id="scenario-controls" aria-label="Facility scenario settings">
              {!designMode && <>
                <details className="building-settings" open={false}><summary>Building · {Number.isFinite(building.width_m) ? building.width_m : '—'}×{Number.isFinite(building.depth_m) ? building.depth_m : '—'}×{Number.isFinite(building.height_m) ? building.height_m : '—'} m · setback {Number.isFinite(building.setback_m) ? building.setback_m : '—'} m</summary><div className="building-grid">{[['width_m', 'Width'], ['depth_m', 'Depth'], ['height_m', 'Height'], ['setback_m', 'Setback']].map(([key, label]) => <label key={key} htmlFor={`building-${key}`}>{label} (m)<input id={`building-${key}`} type="number" min={key === 'height_m' ? 3 : key === 'setback_m' ? 0 : 5} max={key === 'height_m' ? 80 : key === 'setback_m' ? 20 : 100} value={Number.isFinite(building[key]) ? building[key] : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setBuilding((current) => ({ ...current, [key]: e.target.value === '' ? NaN : Number(e.target.value) })); clearScenarioResult(); }} /></label>)}</div></details>
                {validateBuilding(building) && <small role="alert">{validateBuilding(building)}</small>}
                <p className="scenario-input-note">Fixed footprint mode uses supplied parcels, buildings, and road corridors.</p>
              </>}
              {designMode && <details className="walking-assumptions"><summary>Walking assumptions</summary><div className="building-grid"><label htmlFor="walk-speed">Walking speed (m/s)<input id="walk-speed" type="number" min="0.5" max="2" step="0.1" value={Number.isFinite(walk.speed_mps) ? walk.speed_mps : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setWalk((current) => ({ ...current, speed_mps: e.target.value === '' ? NaN : Number(e.target.value) })); clearScenarioResult(); }} /></label><label htmlFor="walk-snap">Maximum snap distance (m)<input id="walk-snap" type="number" min="10" max="200" step="10" value={Number.isFinite(walk.max_snap_m) ? walk.max_snap_m : ''} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setWalk((current) => ({ ...current, max_snap_m: e.target.value === '' ? NaN : Number(e.target.value) })); clearScenarioResult(); }} /></label></div><p className="scenario-input-note">Estimated paths use inferred street connectors; entrances are not verified.</p>{validateWalk(walk) && <small role="alert">{validateWalk(walk)}</small>}</details>}
            </div>}
            {mode !== 'exposure' && mode !== 'scenario' && <div className="advanced-block" id="threshold-group">
              <label htmlFor="threshold">Service radius (m)</label>
              <div className="unit-input"><input id="threshold" type="number" min="100" max="5000" step="100" value={threshold} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setThreshold(e.target.value); clearScenarioResult(); }} /><span>m</span></div>
              {mode !== 'scenario' && <div id="distance-type" className="static-input distance-type">Straight-line distance</div>}
            </div>}
            <div className="advanced-block">
              <label htmlFor="question" className="question-label">{mode === 'scenario' && designMode ? 'Design preference' : 'Analyst question'}</label>
              <textarea id="question" rows="2" value={question} disabled={runStarting || Boolean(activeRunId)} onChange={(e) => { setQuestion(e.target.value); setQuestionEdited(true); if (mode === 'scenario') clearScenarioResult(); }} />
            </div>
          </details>
        </div>
        </div>
        <div className="workflow-step run-step" data-step="4">
          <div className="section-heading"><span className="step-badge" aria-hidden="true">4</span><div><h2>Run</h2></div></div>
          {!canRun && blockedReason && <p className="run-disabled-hint" role="status">{blockedReason}</p>}
          <button id="run-button" className="run-button" type="button" disabled={!canRun} onClick={startRun}><span className="button-icon">↗</span><span>{runStarting ? 'Starting…' : activeRunId ? 'Working…' : mode === 'exposure' ? 'Estimate population' : mode === 'scenario' ? 'Design & compare' : mode === 'compare' ? 'Compare locations' : 'Find nearby services'}</span><span className="button-arrow">→</span></button>
        </div>
      </aside><section className="map-panel" aria-label="Map and analysis results">
        <div className="map-head"><div><p className="eyebrow">MAP · RESULTS</p><h2>{mapTitle}</h2></div>{datasetLoading && <span className="status-pill" role="status">Loading</span>}{!datasetLoading && datasetError && <span className="status-pill failed" role="alert">Unavailable</span>}</div>
        <div className="workspace-panes">
          <div className="map-stage" aria-label="Map stage">
            {datasetLoading && <div className="panel-state" role="status">Loading map layers for this dataset…</div>}
            {!datasetLoading && datasetError && <div className="panel-state error" role="alert"><strong>Dataset could not load.</strong><span>{datasetError}</span></div>}
            {!datasetLoading && !datasetError && !dataset && <div className="panel-state empty" role="status">Select a dataset to show the map.</div>}
            <LeafletMap data={dataset} datasetId={datasetId} resultData={resultMap} mode={mode} candidateA={candidateA} candidateB={candidateB} onCandidateChange={onCandidateChange} scenarioArea={['scenario', 'exposure'].includes(mode) && studyArea?.every(Number.isFinite) ? studyArea : null} scenarioCandidates={mode === "scenario" && scenarioResultAllowed ? scenarioCandidates : []} selectedCandidateId={selectedScenarioCandidate?.id ?? scenarioCandidates[0]?.id} onScenarioAreaSelected={onScenarioAreaSelected} areaSelectionActive={areaSelectionActive && ['scenario', 'exposure'].includes(mode) && !runStarting && !activeRunId} interactionsLocked={runStarting || Boolean(activeRunId)} onSelectScenarioCandidate={selectScenarioCandidate} scenarioSiteChecks={scenarioResultAllowed ? (run.result?.metrics?.site_checks ?? []) : []} scenarioView={scenarioView} />
            {resultMapError && <div className="panel-state error" role="alert">{resultMapError}</div>}
          </div>
          <div className="results-stage" aria-label="Results stage">
            {!run && !datasetLoading && !datasetError && <div className="panel-state empty result-empty" role="status"><strong>No results yet</strong><span>Pick a task, dataset, and run — ranks, 3D, and downloads appear here.</span></div>}
            <ResultsPanel run={run} onDownload={onDownload} downloadError={downloadError} dataset={dataset} selectedScenarioCandidate={selectedScenarioCandidate} onSelectScenarioCandidate={selectScenarioCandidate} scenarioView={scenarioView} onScenarioViewChange={setScenarioView} />
          </div>
        </div>
      </section></div>
    </main>
    <footer className="app-footer"><span>GEOSCOPE</span><span>{config?.demo_mode ? 'Local fixed-reference simulation' : 'Checked against a fixed GIS reference.'}</span></footer>
  </div>;
}
