import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { MapView } from './components/MapView';
import { loadObservatoryData, type ObservatoryData } from './app/data';
import { AUTHORITY_LABELS, OBSERVATORY_CONFIG, SEVERITY_ORDER, SEVERITY_STYLES } from './domain/config';
import { groupPersistentLocations } from './domain/analysis';
import { availableAuthorities, availableYears, DEFAULT_FILTERS, filterRecords, summarizeRecords, type DimensionFilter, type FilterState } from './domain/filters';
import { DATA_QUALITY_METADATA } from './domain/dataQuality';
import type { CollisionRecord, PersistentLocation, Severity } from './domain/model';
import { recordsInViewport, summarizeCasualtySeverities, type ViewportBounds } from './domain/viewport';
import './styles.css';

const numberFormat = new Intl.NumberFormat('en-GB');

const displayNumber = (value: number | null): string => value === null ? '—' : numberFormat.format(value);

const displayDate = (value: string | undefined): string => {
  if (!value) return 'not recorded';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(date);
};

const severityDescription = (severity: Severity): string => {
  if (severity === 'fatal') return 'Fatal';
  if (severity === 'serious') return 'Serious';
  if (severity === 'slight') return 'Slight';
  return 'Unknown';
};

type DataState = { status: 'loading' | 'ready' | 'error'; data: ObservatoryData | null; error: string | null };
const initialDataState: DataState = { status: 'loading', data: null, error: null };

const useObservatoryData = (): { status: 'loading' | 'ready' | 'error'; data: ObservatoryData | null; error: string | null } => {
  const [state, setState] = useState<DataState>(initialDataState);
  useEffect(() => {
    let active = true;
    loadObservatoryData().then((data) => {
      if (active) setState({ status: 'ready', data, error: null });
    }).catch((error: unknown) => {
      if (active) setState({ status: 'error', data: null, error: error instanceof Error ? error.message : 'The collision dataset could not be loaded.' });
    });
    return () => { active = false; };
  }, []);
  return state;
};

const StatCard = ({ label, value, accent, detail }: { label: string; value: string; accent?: Severity; detail?: string }) => (
  <div className={`stat-card ${accent ? `stat-${accent}` : ''}`}>
    <span className="stat-label">{label}</span>
    <strong className="stat-value">{value}</strong>
    {detail && <span className="stat-detail">{detail}</span>}
  </div>
);

const DataQualityNote = ({ data }: { data: ObservatoryData }) => {
  const title = data.metadata.qualityWarningTitle ?? DATA_QUALITY_METADATA.warning.title;
  const text = data.metadata.qualityWarning ?? DATA_QUALITY_METADATA.warning.text;
  const sourceUrl = data.metadata.qualityWarningSource ?? DATA_QUALITY_METADATA.warning.sources[0]?.url;
  return (
    <section className="quality-note" aria-labelledby="quality-note-heading">
      <div className="quality-icon" aria-hidden="true">!</div>
      <div>
        <h2 id="quality-note-heading">{title}</h2>
        <p>{text}</p>
        {sourceUrl && <p className="source-line">Source note: <a href={sourceUrl} target="_blank" rel="noreferrer">DfT recording-quality note</a></p>}
      </div>
    </section>
  );
};

const Summary = ({ records, casualtyCoverage }: { records: CollisionRecord[]; casualtyCoverage?: string }) => {
  const summary = useMemo(() => summarizeRecords(records), [records]);
  const incompleteMetrics = [
    { label: 'Casualties', unknown: summary.casualtiesUnknown },
    { label: 'Fatalities', unknown: summary.fatalitiesUnknown },
    { label: 'Seriously injured', unknown: summary.seriousCasualtiesUnknown },
    { label: 'KSI casualties', unknown: summary.ksiCasualtiesUnknown },
  ].filter((metric) => metric.unknown > 0);
  const casualtyAvailable = casualtyCoverage !== 'unavailable' && (
    [summary.casualties, summary.fatalities, summary.seriousCasualties, summary.ksiCasualties].some((value) => value !== null) || incompleteMetrics.length > 0
  );
  const casualtyMetric = (label: string, value: number | null, unknown: number) => (
    <div className={unknown ? 'casualty-metric incomplete' : 'casualty-metric'}>
      <span>{label}{unknown ? '*' : ''}</span>
      <strong>{displayNumber(value)}</strong>
      {unknown > 0 && <small>{numberFormat.format(unknown)} not recorded</small>}
    </div>
  );
  return (
    <section className="summary-panel" aria-labelledby="summary-heading">
      <div className="section-heading-row">
        <div>
          <p className="section-kicker">Filtered regional view</p>
          <h2 id="summary-heading">Current totals</h2>
        </div>
        <span className="summary-context">All matching records, independent of viewport</span>
      </div>
      <div className="stats-grid">
        <StatCard label="Collisions" value={displayNumber(summary.collisions)} detail="reported injury collisions" />
        <StatCard label="Fatal" value={displayNumber(summary.fatalCollisions)} accent="fatal" />
        <StatCard label="Serious" value={displayNumber(summary.seriousCollisions)} accent="serious" />
        <StatCard label="Slight" value={displayNumber(summary.slightCollisions)} accent="slight" />
      </div>
      {summary.unknownSeverity > 0 && <p className="inline-note">{numberFormat.format(summary.unknownSeverity)} collision{summary.unknownSeverity === 1 ? '' : 's'} have no recognized severity.</p>}
      {casualtyAvailable && (
        <div className="casualty-strip" aria-label="Casualty totals">
          {casualtyMetric('Casualties', summary.casualties, summary.casualtiesUnknown)}
          {casualtyMetric('Fatalities', summary.fatalities, summary.fatalitiesUnknown)}
          {casualtyMetric('Seriously injured', summary.seriousCasualties, summary.seriousCasualtiesUnknown)}
          {casualtyMetric('KSI casualties', summary.ksiCasualties, summary.ksiCasualtiesUnknown)}
        </div>
      )}
      {incompleteMetrics.length > 0 && <p className="inline-note">Totals marked * sum recorded values; {incompleteMetrics.map((metric, index) => <span key={metric.label}>{index > 0 ? '; ' : ''}{metric.label} has {numberFormat.format(metric.unknown)} unrecorded value{metric.unknown === 1 ? '' : 's'}</span>)}.</p>}
      {casualtyCoverage === 'partial' && incompleteMetrics.length === 0 && <p className="inline-note">Casualty totals are partial and are not a complete count of people affected.</p>}
    </section>
  );
};

const viewportValue = (value: number | null, recordCount: number): string => recordCount === 0 ? '0' : displayNumber(value);

const ViewportSummary = ({ records, matchingCount }: { records: CollisionRecord[]; matchingCount: number }) => {
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 540px)').matches === true);
  const summary = useMemo(() => summarizeRecords(records), [records]);
  const casualty = useMemo(() => summarizeCasualtySeverities(records), [records]);
  const incomplete = records.filter((record) => record.casualtyCount === null || record.fatalities === null || record.seriousCasualties === null || record.casualtyCount < (record.fatalities ?? 0) + (record.seriousCasualties ?? 0)).length;
  const collisionMetrics = [
    { label: 'Fatal', value: summary.fatalCollisions, className: 'fatal' },
    { label: 'Serious', value: summary.seriousCollisions, className: 'serious' },
    { label: 'Slight', value: summary.slightCollisions, className: 'slight' },
    { label: 'Unknown', value: summary.unknownSeverity, className: 'unknown' },
  ];
  const casualtyMetrics = [
    { label: 'Fatalities', value: casualty.fatalities, unknown: casualty.fatalitiesUnknown, className: 'fatal' },
    { label: 'Seriously injured', value: casualty.serious, unknown: casualty.seriousUnknown, className: 'serious' },
    { label: 'Slightly injured', value: casualty.slight, unknown: casualty.slightUnknown, className: 'slight' },
  ];
  return <section className="viewport-panel" aria-labelledby="viewport-summary-heading">
    <div className="viewport-panel-heading">
      <div><p className="section-kicker">Current map extent</p><h2 id="viewport-summary-heading">Visible totals</h2></div>
      <div className="viewport-heading-tools"><span className="viewport-count">{numberFormat.format(records.length)} of {numberFormat.format(matchingCount)} visible<br />{viewportValue(summary.casualties, records.length)} casualties</span><button className="viewport-toggle" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>{collapsed ? 'Show breakdown' : 'Hide breakdown'}</button></div>
    </div>
    {!collapsed && <>
      <div className="viewport-breakdown">
      <div className="viewport-breakdown-group">
        <h3>Collision severity <span>events</span></h3>
        <div className="viewport-metrics">
          {collisionMetrics.map((metric) => <div className={`viewport-metric metric-${metric.className}`} key={metric.label}><span>{metric.label}</span><strong>{numberFormat.format(metric.value)}</strong></div>)}
        </div>
      </div>
      <div className="viewport-breakdown-group">
        <h3>Casualty severity <span>{viewportValue(summary.casualties, records.length)} casualties</span></h3>
        <div className="viewport-metrics">
          {casualtyMetrics.map((metric) => <div className={`viewport-metric metric-${metric.className}`} key={metric.label}><span>{metric.label}{metric.unknown > 0 ? '*' : ''}</span><strong>{viewportValue(metric.value, records.length)}</strong></div>)}
        </div>
      </div>
      </div>
      <p className="viewport-note">Updates as you pan, zoom or filter. Casualties are people injured in these collisions.</p>
      <details className="viewport-method"><summary>About these totals</summary><p>Collision severity counts events. Slightly injured is derived from recorded casualties minus fatalities and serious injuries. {records.length === 0 ? 'No matching records are visible.' : incomplete > 0 ? `${numberFormat.format(incomplete)} matching record${incomplete === 1 ? '' : 's'} lack a complete casualty-severity split.` : 'All three casualty-severity inputs are recorded for these records.'}</p></details>
    </>}
  </section>;
};

const MultiSelectGroup = ({ label, options, selected, onChange }: { label: string; options: string[]; selected: string[]; onChange: (value: string, checked: boolean) => void }) => (
  <fieldset className="filter-fieldset">
    <legend>{label}</legend>
    <div className="checkbox-grid">
      {options.map((option) => (
        <label className="check-option" key={option}>
          <input type="checkbox" checked={selected.includes(option)} onChange={(event) => onChange(option, event.target.checked)} />
          <span>{AUTHORITY_LABELS[option] ?? option}</span>
        </label>
      ))}
    </div>
  </fieldset>
);

const SeverityFilter = ({ selected, onChange }: { selected: Severity[]; onChange: (severity: Severity, checked: boolean) => void }) => (
  <fieldset className="filter-fieldset">
    <legend>Collision severity</legend>
    <div className="severity-options">
      {SEVERITY_ORDER.map((severity) => (
        <label className="severity-option" key={severity} style={{ '--severity-colour': SEVERITY_STYLES[severity].colour } as CSSProperties}>
          <input type="checkbox" checked={selected.includes(severity)} onChange={(event) => onChange(severity, event.target.checked)} />
          <span className="severity-dot" aria-hidden="true" />
          <span>{severityDescription(severity)}</span>
        </label>
      ))}
    </div>
  </fieldset>
);

const InvolvementSelect = ({ label, value, disabled, onChange }: { label: string; value: DimensionFilter; disabled: boolean; onChange: (value: DimensionFilter) => void }) => (
  <label className="select-field">
    <span>{label}</span>
    <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as DimensionFilter)}>
      <option value="all">All records</option>
      <option value="yes">Involved</option>
      <option value="no">Not involved</option>
      <option value="unknown">Not recorded</option>
    </select>
  </label>
);

const Filters = ({ records, filters, setFilters, metadata, onReset }: { records: CollisionRecord[]; filters: FilterState; setFilters: Dispatch<SetStateAction<FilterState>>; metadata: ObservatoryData['metadata']; onReset: () => void }) => {
  const years = availableYears(records);
  const authorities = availableAuthorities(records);
  const involvementSupported = metadata.involvementCoverage !== 'unavailable' && records.some((record) => record.pedestrianInvolved !== null || record.cycleInvolved !== null || record.motorcycleInvolved !== null);
  const toggle = (key: 'years' | 'authorities' | 'severities', value: number | string | Severity, checked: boolean) => setFilters((current) => {
    const values = current[key] as Array<number | string | Severity>;
    const next = checked ? [...values, value] : values.filter((candidate) => candidate !== value);
    return { ...current, [key]: next } as FilterState;
  });
  return (
    <section className="filters-panel" aria-labelledby="filters-heading">
      <div className="section-heading-row">
        <div><p className="section-kicker">Explore the evidence</p><h2 id="filters-heading">Filters</h2></div>
        <button className="text-button" type="button" onClick={onReset}>Reset</button>
      </div>
      <p className="filter-hint">No selection includes all values.</p>
      <fieldset className="filter-fieldset">
        <legend>Calendar year{filters.years.length ? ` (${filters.years.length} selected)` : ''}</legend>
        <div className="year-options">
          {years.map((year) => <label className="check-option" key={year}><input type="checkbox" checked={filters.years.includes(year)} onChange={(event) => toggle('years', year, event.target.checked)} /><span>{year}</span></label>)}
        </div>
        {!years.length && <p className="muted">No year values were found in the loaded records.</p>}
      </fieldset>
      <MultiSelectGroup label="Local authority" options={authorities} selected={filters.authorities} onChange={(value, checked) => toggle('authorities', value, checked)} />
      <SeverityFilter selected={filters.severities} onChange={(value, checked) => toggle('severities', value, checked)} />
      <div className="involvement-grid">
        <InvolvementSelect label="Pedestrian involvement" value={filters.pedestrian} disabled={!involvementSupported} onChange={(value) => setFilters((current) => ({ ...current, pedestrian: value }))} />
        <InvolvementSelect label="Cycle involvement" value={filters.cycle} disabled={!involvementSupported} onChange={(value) => setFilters((current) => ({ ...current, cycle: value }))} />
        <InvolvementSelect label="Motorcycle involvement" value={filters.motorcycle} disabled={!involvementSupported} onChange={(value) => setFilters((current) => ({ ...current, motorcycle: value }))} />
      </div>
      {!involvementSupported && <p className="inline-note">Road-user involvement is unavailable in this snapshot, so those filters are disabled.</p>}
      {involvementSupported && records.some((record) => record.pedestrianInvolved === null || record.cycleInvolved === null || record.motorcycleInvolved === null) && <p className="inline-note">Unknown involvement stays separate from a recorded “No”.</p>}
    </section>
  );
};

const CouncilBreakdown = ({ records }: { records: CollisionRecord[] }) => {
  const summary = useMemo(() => summarizeRecords(records), [records]);
  const max = Math.max(...summary.authorities.map((authority) => authority.collisions), 1);
  return (
    <section className="breakdown-panel" aria-labelledby="breakdown-heading">
      <div className="section-heading-row"><div><p className="section-kicker">Filtered records</p><h2 id="breakdown-heading">By local authority</h2></div></div>
      <div className="authority-list">
        {summary.authorities.map((authority) => <div className="authority-row" key={authority.authority}>
          <div className="authority-row-heading"><span>{AUTHORITY_LABELS[authority.authority] ?? authority.authority}</span><strong>{numberFormat.format(authority.collisions)}</strong></div>
          <div className="bar-track"><span className="bar-fill" style={{ width: `${Math.max(2, (authority.collisions / max) * 100)}%` }} /></div>
          <span className="authority-detail">{authority.fatalCollisions} fatal · {authority.seriousCollisions} serious · {authority.slightCollisions} slight</span>
        </div>)}
      </div>
    </section>
  );
};

const PersistentPanel = ({ locations, radiusMetres, onRadiusChange, selectedId, onSelect }: { locations: PersistentLocation[]; radiusMetres: number; onRadiusChange: (radius: number) => void; selectedId: string | null; onSelect: (location: PersistentLocation) => void }) => (
  <section className="persistent-panel" aria-labelledby="persistent-heading">
    <div className="section-heading-row"><div><p className="section-kicker">Spatial concentration</p><h2 id="persistent-heading">Persistent locations</h2></div><span className="result-count">{locations.length}</span></div>
    <p className="panel-copy">A persistent location has at least {OBSERVATORY_CONFIG.grouping.minCollisions} collisions across at least {OBSERVATORY_CONFIG.grouping.minYears} distinct calendar years in the active selection. The purple overlay groups these same collision records; it adds no collisions, and grouping is calculated from the filtered regional selection independently of the current viewport. It shows repeated frequency, not exposure-adjusted risk or an official site assessment.</p>
    <details className="method-disclosure"><summary>How the grouping works</summary><p>Selected collisions are sorted by stable collision ID. The first unassigned collision anchors a group, then still-unassigned collisions within the radius of that anchor join it. This deterministic anchored method avoids chain-merging distant points; a group's overall diameter can reach twice the radius.</p></details>
    <label className="range-field"><span>Anchor radius <strong>{radiusMetres}m</strong></span><input type="range" min="50" max={OBSERVATORY_CONFIG.grouping.maxRadiusMetres} step="10" value={radiusMetres} onChange={(event) => onRadiusChange(Number(event.target.value))} /></label>
    {locations.length ? <ol className="location-list">{locations.slice(0, 8).map((location, index) => <li key={location.id}><button type="button" className={`location-item ${selectedId === location.id ? 'selected' : ''}`} onClick={() => onSelect(location)}><span className="location-rank">{String(index + 1).padStart(2, '0')}</span><span className="location-copy"><strong>{location.collisions} collisions</strong><span>{location.years.join(' · ')} calendar years</span><small>{location.fatalCollisions} fatal · {location.seriousCollisions} serious · {location.slightCollisions} slight</small></span><span className="location-arrow" aria-hidden="true">↗</span></button></li>)}</ol> : <div className="empty-panel"><strong>No persistent locations in this selection</strong><span>Try more years or clear a filter. A single calendar year cannot meet the persistence threshold.</span></div>}
  </section>
);

const ProvenancePanel = ({ data }: { data: ObservatoryData }) => {
  const metadata = data.metadata;
  const processing = metadata.processingSteps?.length ? metadata.processingSteps : ['Normalize source collision records to the internal point model', 'Validate coordinates and retain only the four study-area authorities', 'Calculate bounded spatial concentrations from the active selection'];
  const boundarySource = data.boundaryProvenance?.source;
  return <details className="provenance-panel">
    <summary>Data provenance and limitations</summary>
    <div className="provenance-content">
      <dl className="provenance-list">
        <div><dt>Upstream dataset</dt><dd>{metadata.upstreamDataset ?? metadata.source ?? 'DfT STATS19 reported road collision data'}</dd></div>
        <div><dt>Included years</dt><dd>{metadata.includedYears?.join(', ') || 'not recorded'}</dd></div>
        <div><dt>Latest available year</dt><dd>{metadata.latestYear ?? 'not recorded'}</dd></div>
        <div><dt>Generated</dt><dd>{displayDate(metadata.generatedAt)}</dd></div>
        <div><dt>Retrieved</dt><dd>{displayDate(metadata.retrievedAt)}</dd></div>
        <div><dt>Licence</dt><dd>{metadata.licence ?? 'not recorded'}{metadata.licenceUrl && <> · <a href={metadata.licenceUrl} target="_blank" rel="noreferrer">source</a></>}</dd></div>
        <div><dt>Records accepted</dt><dd>{numberFormat.format(data.records.length)}{data.invalidCount ? ` · ${numberFormat.format(data.invalidCount)} invalid point${data.invalidCount === 1 ? '' : 's'} excluded` : ''}</dd></div>
        {boundarySource && <div><dt>Regional outline</dt><dd>{boundarySource.dataset ?? boundarySource.publisher ?? 'ONS local-authority boundary product'}{boundarySource.datasetUrl && <> · <a href={boundarySource.datasetUrl} target="_blank" rel="noreferrer">dataset</a></>}{boundarySource.attribution && <><br />{boundarySource.attribution}</>}</dd></div>}
      </dl>
      <h3>Processing disclosed</h3>
      <ul>{processing.map((step) => <li key={step}>{step}</li>)}</ul>
      {metadata.limitations?.length ? <><h3>Known limitations</h3><ul>{metadata.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></> : null}
      <p className="provenance-source">{metadata.sourceUrl ? <a href={metadata.sourceUrl} target="_blank" rel="noreferrer">Open source documentation</a> : 'Source documentation is recorded in the repository README and generated manifest.'}</p>
    </div>
  </details>;
};

const LoadingState = () => <main className="state-page"><div className="state-card"><span className="loading-spinner" aria-hidden="true" /><p className="section-kicker">Loading local snapshot</p><h1>Preparing the observatory</h1><p>Reading the generated collision GeoJSON and manifest.</p></div></main>;

const ErrorState = ({ message }: { message: string }) => <main className="state-page"><div className="state-card error-state"><div className="error-mark" aria-hidden="true">!</div><p className="section-kicker">Data unavailable</p><h1>Could not load the collision snapshot</h1><p>{message}</p><p className="muted">Run <code>npm run data:refresh</code> after installing dependencies, then reload the local app.</p></div></main>;

export const App = () => {
  const state = useObservatoryData();
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [radiusMetres, setRadiusMetres] = useState<number>(OBSERVATORY_CONFIG.grouping.defaultRadiusMetres);
  const [selectedLocation, setSelectedLocation] = useState<PersistentLocation | null>(null);
  const [showPersistentLocations, setShowPersistentLocations] = useState(false);
  const [resetViewSignal, setResetViewSignal] = useState(0);
  const [viewportBounds, setViewportBounds] = useState<ViewportBounds | null>(null);
  const records = useMemo(() => state.data?.records ?? [], [state.data]);
  const filteredRecords = useMemo(() => filterRecords(records, filters), [records, filters]);
  const viewportRecords = useMemo(() => viewportBounds ? recordsInViewport(filteredRecords, viewportBounds) : null, [filteredRecords, viewportBounds]);
  const locations = useMemo(() => groupPersistentLocations(filteredRecords, radiusMetres, OBSERVATORY_CONFIG.grouping.minCollisions, OBSERVATORY_CONFIG.grouping.minYears), [filteredRecords, radiusMetres]);
  const resetFilters = () => { setFilters(DEFAULT_FILTERS); setSelectedLocation(null); };
  const resetMapView = () => { setSelectedLocation(null); setResetViewSignal((value) => value + 1); };
  const focusLocation = (location: PersistentLocation) => { setSelectedLocation(location); setShowPersistentLocations(true); };

  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error' || !state.data) return <ErrorState message={state.error ?? 'The collision dataset could not be loaded.'} />;
  const data = state.data;
  const latestYear = data.metadata.latestYear ?? availableYears(records)[0];
  const sourceLabel = data.metadata.source ?? data.metadata.upstreamDataset ?? 'DfT STATS19';
  return <div className="app-shell">
    <header className="app-header"><div className="header-inner"><div className="brand-mark" aria-hidden="true"><span>WE</span><i /></div><div><p className="eyebrow">West of England · Road safety evidence</p><h1>{OBSERVATORY_CONFIG.title}</h1><p className="subtitle">{OBSERVATORY_CONFIG.subtitle}</p></div><div className="header-status"><span className="status-dot" aria-hidden="true" />Local snapshot<br /><strong>{latestYear ? `through ${latestYear}` : sourceLabel}</strong><nav className="header-links" aria-label="Project links"><a href="https://awjreynolds.github.io/">All projects</a><a href="https://github.com/awjreynolds/weca-collision-map">Source</a></nav></div></div></header>
    <main className="workspace">
      <section className="map-column" aria-label="Regional collision map"><div className="map-toolbar"><div><span className="map-toolbar-label">Map view</span><strong>{numberFormat.format(filteredRecords.length)} matching collision{filteredRecords.length === 1 ? '' : 's'}</strong></div><div className="map-toolbar-actions"><label className="map-toggle"><input type="checkbox" checked={showPersistentLocations} onChange={(event) => setShowPersistentLocations(event.target.checked)} /><span>Persistent locations</span></label><button className="map-reset" type="button" onClick={resetMapView}>Reset to region</button></div></div><div className="map-frame"><MapView records={filteredRecords} regionRecords={records} locations={locations} boundaries={data.boundaries} resetViewSignal={resetViewSignal} focusLocation={selectedLocation} showPersistentLocations={showPersistentLocations} onLocationSelect={(location) => { setSelectedLocation(location); setShowPersistentLocations(true); }} onViewportBoundsChange={(nextBounds) => setViewportBounds((current) => current && current.west === nextBounds.west && current.east === nextBounds.east && current.south === nextBounds.south && current.north === nextBounds.north ? current : nextBounds)} />{viewportRecords ? <ViewportSummary records={viewportRecords} matchingCount={filteredRecords.length} /> : <div className="viewport-panel viewport-loading"><span className="section-kicker">Current map extent</span><strong>Reading visible records…</strong></div>}<div className="map-legend" aria-label="Severity legend"><span>Severity</span>{SEVERITY_ORDER.map((severity) => <span key={severity}><i style={{ backgroundColor: SEVERITY_STYLES[severity].colour }} />{severityDescription(severity)}</span>)}<span><i className="legend-cluster" />Cluster</span>{showPersistentLocations && <span><i className="legend-hotspot" />Persistent location</span>}</div>{filteredRecords.length === 0 && <div className="map-empty"><strong>No records match these filters</strong><span>Clear or broaden a filter to restore the map.</span></div>}</div></section>
      <aside className="sidebar"><div className="sidebar-scroll"><DataQualityNote data={data} /><Summary records={filteredRecords} casualtyCoverage={data.metadata.casualtyCoverage} /><Filters records={records} filters={filters} setFilters={setFilters} metadata={data.metadata} onReset={resetFilters} /><CouncilBreakdown records={filteredRecords} /><PersistentPanel locations={locations} radiusMetres={radiusMetres} onRadiusChange={(value) => { setRadiusMetres(value); setSelectedLocation(null); }} selectedId={selectedLocation?.id ?? null} onSelect={focusLocation} /><ProvenancePanel data={data} /><p className="footer-note">Reported STATS19 injury collisions are a record of reported harm, not every incident on the road network. {sourceLabel} · {data.sourcePath}</p></div></aside>
    </main>
  </div>;
};
