export const STARTER_PROJECTS = [
  { id: 'sf-library', datasetId: 'localdemo', serviceType: 'library', city: 'San Francisco', title: 'Find a place for a library', description: 'Compare library layouts and walking access in a prepared neighborhood.', source: 'Demo parcels with mapped surroundings', question: 'Design a compact library that preserves useful open space and compare walking access before and after.' },
  { id: 'nyc-clinic', datasetId: 'nycland', serviceType: 'clinic', city: 'East Harlem', title: 'Explore a neighborhood clinic', description: 'Test a clinic layout against supplied lot, building and street records.', source: 'Official lot records; availability unverified', question: 'Design a neighborhood clinic that meets the floor-area goal, preserves useful open space, and improves walking access.' },
];

function NeighborhoodIllustration() {
  return <figure className="dashboard-illustration">
    <div className="illustration-heading"><span>A little space. A new possibility.</span><span className="illustration-dot" aria-hidden="true" /></div>
    <svg viewBox="0 0 440 290" role="img" aria-label="Illustration of a proposed building, open space and surrounding streets">
      <rect x="10" y="10" width="420" height="270" rx="18" fill="#e8eee7" />
      <path d="M138 10V280M292 10V280M10 151H430" stroke="#fff" strokeWidth="24" />
      <path d="M138 10V280M292 10V280M10 151H430" stroke="#d5dfd5" strokeWidth="1.5" strokeDasharray="5 6" />
      <g fill="#bccbbb" stroke="#a9bda8" strokeWidth="1"><rect x="31" y="30" width="82" height="41" rx="5" /><rect x="45" y="89" width="68" height="37" rx="5" /><rect x="319" y="33" width="80" height="87" rx="5" /><rect x="30" y="182" width="72" height="65" rx="5" /><rect x="167" y="187" width="44" height="57" rx="5" /><rect x="231" y="189" width="37" height="71" rx="5" /><rect x="318" y="193" width="92" height="47" rx="5" /></g>
      <rect x="162" y="29" width="106" height="101" rx="7" fill="#c8deb3" stroke="#628658" strokeWidth="2" strokeDasharray="5 3" />
      <g fill="#85ab73"><circle cx="182" cy="108" r="8" /><circle cx="205" cy="108" r="8" /><circle cx="250" cy="49" r="8" /><circle cx="250" cy="72" r="8" /></g>
      <path d="M184 53L209 39L235 53L209 68Z" fill="#f4c796" /><path d="M184 53V88L209 102V68Z" fill="#df9b60" /><path d="M209 68L235 53V88L209 102Z" fill="#c57c44" />
      <path d="M191 68L202 74M191 80L202 86M217 77L228 71M217 88L228 82" stroke="#fff0d9" strokeWidth="3" />
      <path d="M212 128V151H293V219" fill="none" stroke="#547d86" strokeWidth="3" strokeDasharray="4 6" strokeLinecap="round" />
      <circle cx="293" cy="219" r="6" fill="#547d86" stroke="white" strokeWidth="3" />
    </svg>
    <figcaption><span><i className="legend-building" />Proposed building</span><span><i className="legend-space" />Open space</span><small>Illustration only</small></figcaption>
  </figure>;
}

export default function Dashboard({ starters, onStart, onResume, hasWorkspace, busy, currentCity, currentTask, runStatus, loading, error }) {
  const recommended = starters[0];
  return <main className="dashboard-main" aria-label="Geoscope dashboard">
    <section className="dashboard-hero" aria-labelledby="dashboard-title">
      <div className="dashboard-introduction">
        <p className="dashboard-eyebrow">WELCOME TO GEOSCOPE</p>
        <h1 id="dashboard-title">See what could fit in your neighborhood.</h1>
        <p className="dashboard-lede">Explore a place for a clinic, library, school or community centre. Let the agent test building layouts, leave room for open space, and compare walking access.</p>
        <button className="dashboard-start" type="button" onClick={() => busy ? onResume() : onStart(recommended)}>{busy ? 'Return to your analysis' : "Let's get started"}<span aria-hidden="true">→</span></button>
        <p className="dashboard-start-note">{busy ? 'Your analysis is still running in the background.' : recommended ? `Start with a ${recommended.serviceType} in ${recommended.city}. The area and design goals are already set.` : 'Open the workspace to choose your area and task.'}</p>
        {!busy && <p className="dashboard-reassurance">Review the setup first, then start the analysis from your workspace.</p>}
      </div>
      <NeighborhoodIllustration />
    </section>
    {hasWorkspace && <section className="dashboard-resume" aria-label="Current exploration"><div><p className="dashboard-eyebrow">CURRENT SESSION</p><h2>{currentCity} <span>· {currentTask}</span></h2><p>{busy ? 'Analysis in progress' : runStatus === 'completed' ? 'Your results are ready' : 'Your current workspace is ready to continue'}</p></div><button type="button" onClick={onResume}>Continue exploring <span aria-hidden="true">→</span></button></section>}
    <section className="dashboard-steps" aria-labelledby="steps-heading">
      <div className="dashboard-section-heading"><h2 id="steps-heading">From a question to a clearer picture</h2><p>Three steps. No GIS experience needed.</p></div>
      <ol><li><span>01</span><div><h3>Choose a place</h3><p>Use a prepared neighborhood or draw an area on the map.</p></div></li><li><span>02</span><div><h3>Tell it what to build</h3><p>Choose a facility. The agent tests layouts against your space goals.</p></div></li><li><span>03</span><div><h3>Compare the change</h3><p>See the design in 3D and inspect walking access before and after.</p></div></li></ol>
    </section>
    <section className="dashboard-starters" aria-labelledby="starters-heading">
      <div className="dashboard-section-heading"><h2 id="starters-heading">Try a starting point</h2><p>Prepared examples to help you learn the flow.</p></div>
      {loading && <p className="dashboard-message" role="status">Loading available examples...</p>}
      {error && <p className="dashboard-message" role="status">Examples could not load. Open the workspace for connection details.</p>}
      {!loading && !error && !starters.length && <p className="dashboard-message">Use the workspace to explore the datasets available on this installation.</p>}
      <div className="starter-grid">{starters.map((starter) => <button type="button" className="starter-card" key={starter.id} disabled={busy} onClick={() => onStart(starter)} aria-label={`Try a ${starter.serviceType} in ${starter.city}`}><span className="starter-city">{starter.city}</span><h3>{starter.title}</h3><p>{starter.description}</p><span className="starter-source">{starter.source}</span><span className="starter-action">Open example <span aria-hidden="true">→</span></span></button>)}</div>
      {busy && <p className="dashboard-message">Finish the current analysis before opening a new example.</p>}
    </section>
    <p className="dashboard-data-note">Geoscope tests scenarios using supplied land and population data. Results are estimates, not construction approvals.</p>
  </main>;
}
