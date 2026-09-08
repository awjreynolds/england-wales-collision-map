import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisGroup, AnalysisHarmFilter, AnalysisPayload, BBox, CollisionDetail, DatasetManifest, QueryFilters, SchoolCoverageProvenance, SchoolRecord, SummaryMetrics, ViewPayload } from '../service/contract';
import { loadAnalysis, loadCollisionDetail, loadManifest, loadSchools, loadSummary, loadView, ApiRequestError, type QueryOptions, queryString } from './app/data';
import { parseZoomParam, retryableSchoolOffset } from './app/uiState';
import { MapView } from './components/MapView';
import './styles.css';

const numberFormat = new Intl.NumberFormat('en-GB');
const WEST_OF_ENGLAND = ['E06000022', 'E06000023', 'E06000024', 'E06000025'];
const SCHOOL_PAGE_SIZE = 200;
const DEFAULT_FILTERS: QueryFilters = { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' };
const severityLabel = (value: string): string => value[0].toUpperCase() + value.slice(1);
const format = (value: number | null | undefined): string => value === null || value === undefined ? '—' : numberFormat.format(value);
const bboxLabel = (bbox: BBox | null): string => bbox ? `${bbox.south.toFixed(2)}° to ${bbox.north.toFixed(2)}° N` : 'national extent';
const sameBBox = (left: BBox | null, right: BBox): boolean => Boolean(left && Math.abs(left.west - right.west) < 1e-7 && Math.abs(left.south - right.south) < 1e-7 && Math.abs(left.east - right.east) < 1e-7 && Math.abs(left.north - right.north) < 1e-7);
const copy = {
  title: 'England & Wales Collision Map',
  subtitle: 'A national evidence view for reported injury collisions, persistent locations and school proximity screens.',
};

type LoadState = { manifest: DatasetManifest | null; error: string | null };
type SummaryState = { selected: SummaryMetrics | null; viewport: SummaryMetrics | null; datasetVersion: string | null; loading: boolean; stale: boolean; error: string | null };

const parseInitialState = (): { filters: QueryFilters; radius: number; harm: AnalysisHarmFilter; schoolDistance?: 500 | 1000; bbox?: BBox; zoom?: number; schoolId?: string } => {
  if (typeof window === 'undefined') return { filters: DEFAULT_FILTERS, radius: 100, harm: 'all' };
  const params = new URLSearchParams(window.location.search);
  const csv = (key: string) => (params.get(key) ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const years = csv('years').map(Number).filter((year) => Number.isInteger(year));
  const severities = csv('severity').filter((value): value is QueryFilters['severities'][number] => ['fatal', 'serious', 'slight', 'unknown'].includes(value));
  const country = params.get('country');
  const filters: QueryFilters = { years, authorities: csv('authorities'), severities, ...(country === 'England' || country === 'Wales' ? { country } : {}), pedestrian: (params.get('pedestrian') as QueryFilters['pedestrian']) || 'all', cycle: (params.get('cycle') as QueryFilters['cycle']) || 'all', motorcycle: (params.get('motorcycle') as QueryFilters['motorcycle']) || 'all' };
  const radius = [50, 100, 200, 500].includes(Number(params.get('radius'))) ? Number(params.get('radius')) : 100;
  const harm = (['all', 'ksi', 'repeated-ksi', 'slight-only'] as const).includes(params.get('harm') as AnalysisHarmFilter) ? params.get('harm') as AnalysisHarmFilter : 'all';
  const schoolDistance = params.get('schoolDistance') === '500' ? 500 : params.get('schoolDistance') === '1000' ? 1000 : undefined;
  const bboxValues = (params.get('bbox') ?? '').split(',').map(Number);
  const bbox = bboxValues.length === 4 && bboxValues.every(Number.isFinite) && bboxValues[1] >= -90 && bboxValues[3] <= 90 && bboxValues[1] <= bboxValues[3] ? { west: bboxValues[0], south: bboxValues[1], east: bboxValues[2], north: bboxValues[3] } : undefined;
  const zoom = parseZoomParam(params.get('zoom'));
  const schoolId = params.get('schoolId')?.trim() || undefined;
  return { filters, radius, harm, schoolDistance, bbox, zoom, schoolId };
};

const paramsFor = (filters: QueryFilters, bbox?: BBox, zoom?: number, radius?: number, harmFilter?: AnalysisHarmFilter, schoolDistanceMetres?: 500 | 1000, schoolId?: string): QueryOptions => ({ filters, ...(bbox ? { bbox } : {}), ...(zoom === undefined ? {} : { zoom }), ...(radius === undefined ? {} : { radiusMetres: radius }), ...(harmFilter ? { harmFilter } : {}), ...(schoolDistanceMetres ? { schoolDistanceMetres } : {}), ...(schoolId ? { schoolId } : {}) });
const selectionBBox = (manifest: DatasetManifest, filters: QueryFilters): BBox => {
  const authorities = manifest.authorities?.filter((authority) => filters.authorities.includes(authority.code) && authority.bbox);
  const scoped = authorities?.length ? authorities : manifest.authorities?.filter((authority) => filters.country ? authority.country === filters.country && authority.bbox : false);
  if (!scoped?.length) return manifest.extent;
  return { west: Math.min(...scoped.map((authority) => authority.bbox!.west)), south: Math.min(...scoped.map((authority) => authority.bbox!.south)), east: Math.max(...scoped.map((authority) => authority.bbox!.east)), north: Math.max(...scoped.map((authority) => authority.bbox!.north)) };
};
type AuthorityLabelRecord = Pick<NonNullable<DatasetManifest['authorities']>[number], 'name' | 'code'>;
const displayAuthorityName = (authority: AuthorityLabelRecord, authorities: AuthorityLabelRecord[]): string => {
  const normalized = authority.name.trim().toLocaleLowerCase('en-GB');
  const duplicate = authorities.filter((candidate) => candidate.name.trim().toLocaleLowerCase('en-GB') === normalized).length > 1;
  return duplicate ? `${authority.name} (${authority.code})` : authority.name;
};
const UK_SEARCH_BOUNDS: BBox = { west: -6.5, south: 49.8, east: 2.2, north: 55.9 };
type PlaceResult = { bbox: BBox; label: string };
type PhotonFeature = { geometry?: { type?: string; coordinates?: unknown }; properties?: { name?: unknown; city?: unknown; town?: unknown; village?: unknown; postcode?: unknown; countrycode?: unknown; extent?: unknown } };
const finiteCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bboxContains = (bbox: BBox, longitude: number, latitude: number): boolean => longitude >= bbox.west && longitude <= bbox.east && latitude >= bbox.south && latitude <= bbox.north;
const placeInEnglandOrWales = (manifest: DatasetManifest | null, longitude: number, latitude: number): boolean => {
  if (!bboxContains(UK_SEARCH_BOUNDS, longitude, latitude)) return false;
  const authorityBounds = (manifest?.authorities ?? []).map((authority) => authority.bbox).filter((value): value is BBox => Boolean(value));
  return authorityBounds.length ? authorityBounds.some((bbox) => bboxContains(bbox, longitude, latitude)) : Boolean(manifest?.extent && bboxContains(manifest.extent, longitude, latitude));
};
const extentBBox = (value: unknown): BBox | null => {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(finiteCoordinate)) return null;
  const [firstLongitude, firstLatitude, secondLongitude, secondLatitude] = value;
  return { west: Math.min(firstLongitude, secondLongitude), east: Math.max(firstLongitude, secondLongitude), south: Math.min(firstLatitude, secondLatitude), north: Math.max(firstLatitude, secondLatitude) };
};
const placeLabel = (properties: PhotonFeature['properties']): string => [properties?.name, properties?.city ?? properties?.town ?? properties?.village, properties?.postcode].filter((value): value is string => typeof value === 'string' && value.trim() !== '').join(', ');

const StatCard = ({ label, value, note }: { label: string; value: string; note?: string }) => <div className="stat-card"><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{note && <span className="stat-detail">{note}</span>}</div>;

const Metrics = ({ metrics, label, updating, stale }: { metrics: SummaryMetrics | null; label: string; updating?: boolean; stale?: boolean }) => <section className="summary-panel national-summary"><div className="section-heading-row"><div><p className="section-kicker">{label}</p><h2>{updating ? 'Updating totals…' : stale ? 'Totals unavailable' : 'Exact reported totals'}</h2></div>{metrics && !stale && <span className="summary-context">{metrics.yearsRepresented.join(' · ') || 'No year selected'}</span>}</div><div className="stats-grid"><StatCard label="Collisions" value={stale ? '—' : format(metrics?.collisions)} note="reported injury events" /><StatCard label="Fatal" value={stale ? '—' : format(metrics?.collisionSeverity.fatal)} note="collision events" /><StatCard label="Serious" value={stale ? '—' : format(metrics?.collisionSeverity.serious)} note="collision events" /><StatCard label="Slight" value={stale ? '—' : format(metrics?.collisionSeverity.slight)} note="collision events" /></div><div className="casualty-strip"><div className="casualty-metric"><span>Casualties</span><strong>{stale ? '—' : format(metrics?.casualties.total.value)}</strong></div><div className="casualty-metric"><span>Fatalities</span><strong>{stale ? '—' : format(metrics?.casualties.fatalities.value)}</strong></div><div className="casualty-metric"><span>Seriously injured</span><strong>{stale ? '—' : format(metrics?.casualties.serious.value)}</strong></div><div className="casualty-metric"><span>Slightly injured</span><strong>{stale ? '—' : format(metrics?.casualties.slight.value)}</strong></div><div className="casualty-metric"><span>KSI collisions</span><strong>{stale ? '—' : format(metrics?.ksiCollisions)}</strong></div></div>{metrics && !stale && !metrics.complete && <p className="inline-note">Some casualty fields are unrecorded; totals sum recorded values and retain unknown counts.</p>}</section>;

const Filters = ({ manifest, filters, onChange, onPreset, onReset }: { manifest: DatasetManifest; filters: QueryFilters; onChange: (next: QueryFilters) => void; onPreset: () => void; onReset: () => void }) => {
  const toggle = (key: 'years' | 'authorities' | 'severities', value: string | number, checked: boolean) => { const current = filters[key] as Array<string | number>; const next = checked ? [...current, value] : current.filter((item) => item !== value); onChange({ ...filters, [key]: next } as QueryFilters); };
  return <section className="filters-panel" aria-labelledby="filters-heading"><div className="section-heading-row"><div><p className="section-kicker">Define the selection</p><h2 id="filters-heading">Filters</h2></div><button className="text-button" type="button" onClick={onReset}>Reset</button></div><div className="filter-actions"><button type="button" className="preset-button" onClick={onPreset}>West of England preset</button><button type="button" className="text-button" onClick={() => onChange(DEFAULT_FILTERS)}>England &amp; Wales</button></div><fieldset className="filter-fieldset"><legend>Country</legend><div className="choice-row"><label><input type="radio" name="country" checked={!filters.country} onChange={() => onChange({ ...filters, country: undefined, authorities: [] })} /> England &amp; Wales</label><label><input type="radio" name="country" checked={filters.country === 'England'} onChange={() => onChange({ ...filters, country: 'England', authorities: [] })} /> England</label><label><input type="radio" name="country" checked={filters.country === 'Wales'} onChange={() => onChange({ ...filters, country: 'Wales', authorities: [] })} /> Wales</label></div></fieldset><fieldset className="filter-fieldset"><legend>Calendar year</legend><div className="year-options">{manifest.years.map((year) => <label className="check-option" key={year}><input type="checkbox" checked={filters.years.includes(year)} onChange={(event) => toggle('years', year, event.target.checked)} /><span>{year}</span></label>)}</div><p className="filter-hint">No year selected includes all available years.</p></fieldset><fieldset className="filter-fieldset"><legend>Local authority</legend><div className="authority-options">{(manifest.authorities ?? []).map((authority) => <label className="check-option" key={authority.code}><input type="checkbox" checked={filters.authorities.includes(authority.code)} onChange={(event) => toggle('authorities', authority.code, event.target.checked)} /><span>{displayAuthorityName(authority, manifest.authorities ?? [])}</span></label>)}</div></fieldset><fieldset className="filter-fieldset"><legend>Collision severity</legend><div className="severity-options">{['fatal', 'serious', 'slight', 'unknown'].map((severity) => <label className="severity-option" key={severity}><input type="checkbox" checked={filters.severities.includes(severity as QueryFilters['severities'][number])} onChange={(event) => toggle('severities', severity, event.target.checked)} /><i className={`severity-dot severity-${severity}`} /><span>{severityLabel(severity)}</span></label>)}</div></fieldset><div className="involvement-grid"><label className="select-field"><span>Pedestrian involvement</span><select value={filters.pedestrian} onChange={(event) => onChange({ ...filters, pedestrian: event.target.value as QueryFilters['pedestrian'] })}><option value="all">All records</option><option value="yes">Involved</option><option value="no">Not involved</option><option value="unknown">Not recorded</option></select></label><label className="select-field"><span>Cycle involvement</span><select value={filters.cycle} onChange={(event) => onChange({ ...filters, cycle: event.target.value as QueryFilters['cycle'] })}><option value="all">All records</option><option value="yes">Involved</option><option value="no">Not involved</option><option value="unknown">Not recorded</option></select></label><label className="select-field"><span>Motorcycle involvement</span><select value={filters.motorcycle} onChange={(event) => onChange({ ...filters, motorcycle: event.target.value as QueryFilters['motorcycle'] })}><option value="all">All records</option><option value="yes">Involved</option><option value="no">Not involved</option><option value="unknown">Not recorded</option></select></label></div></section>;
};

const PlaceSearch = ({ onSearch, status }: { onSearch: (query: string) => void; status: string | null }) => { const [value, setValue] = useState(''); return <section className="search-panel"><p className="section-kicker">Find a place</p><h2>Town or postcode</h2><form onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSearch(value.trim()); }}><div className="search-row"><input aria-label="Town or postcode" value={value} onChange={(event) => setValue(event.target.value)} placeholder="e.g. Cardiff or BS1" /><button type="submit">Search</button></div></form>{status && <p className="inline-note">{status}</p>}<p className="search-method">Search runs only when submitted via the public <a href="https://photon.komoot.io/" target="_blank" rel="noreferrer">Photon</a> geocoder using OpenStreetMap data.</p></section>; };

const groupMetric = (metric: { value: number | null; unknownRecords: number }): string => {
  if (metric.value === null) return metric.unknownRecords ? `Not recorded (${format(metric.unknownRecords)})` : 'Not recorded';
  return metric.unknownRecords ? `${format(metric.value)} (${format(metric.unknownRecords)} not recorded)` : format(metric.value);
};

const AnalysisGroupDetail = ({ group, onClose }: { group: AnalysisGroup; onClose: () => void }) => {
  const nearest = group.schoolProximity.nearestSchool;
  return <section className="analysis-selection" aria-labelledby="analysis-selection-heading">
    <div className="section-heading-row"><div><p className="section-kicker">Selected persistent location</p><h3 id="analysis-selection-heading">Group inspection</h3></div><button className="text-button" type="button" onClick={onClose}>Close</button></div>
    <dl className="analysis-detail-grid">
      <div><dt>Recurrence</dt><dd>{format(group.collisions)} collisions across {group.yearsRepresented.join(' · ')}</dd></div>
      <div><dt>Collision harm</dt><dd>{format(group.harm.collisionSeverity.fatal)} fatal · {format(group.harm.collisionSeverity.serious)} serious · {format(group.harm.collisionSeverity.slight)} slight · {format(group.harm.ksiCollisions)} KSI collisions</dd></div>
      <div><dt>Casualty harm</dt><dd>{groupMetric(group.harm.casualties.fatalities)} fatal · {groupMetric(group.harm.casualties.serious)} serious · {groupMetric(group.harm.casualties.slight)} slight</dd></div>
      <div><dt>Nearest listed school</dt><dd>{nearest ? `${Math.round(nearest.distanceMetres)}m · ${nearest.school.name}` : 'No listed school within 1km'}</dd></div>
    </dl>
    <p className="analysis-selection-note">School distance is measured from the group anchor. The whole group may extend beyond the anchor radius, so this is a screening signal for investigation rather than a conclusion about the site or route.</p>
  </section>;
};

const AnalysisPanel = ({ groups, coverage, provenance, inputRecords, edgeWarning, radius, harm, schoolDistance, analysisScope, selectedGroup, onGroupSelect, onGroupClose, onRun, onRadius, onHarm, onSchoolDistance, running, blocked, error }: { groups: AnalysisGroup[]; coverage: AnalysisPayload['schoolCoverage']; provenance: SchoolCoverageProvenance[]; inputRecords: number | null; edgeWarning: boolean; radius: number; harm: AnalysisHarmFilter; schoolDistance?: 500 | 1000; analysisScope: BBox | null; selectedGroup: AnalysisGroup | null; onGroupSelect: (group: AnalysisGroup) => void; onGroupClose: () => void; onRun: () => void; onRadius: (value: number) => void; onHarm: (value: AnalysisHarmFilter) => void; onSchoolDistance: (value?: 500 | 1000) => void; running: boolean; blocked: boolean; error: string | null }) => {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [groups]);
  const visibleGroups = showAll ? groups : groups.slice(0, 8);
  return <section className="analysis-panel"><div className="section-heading-row"><div><p className="section-kicker">Bounded spatial screen</p><h2>Persistent locations</h2></div>{groups.length > 0 && <span className="result-count">{groups.length}</span>}</div><p className="panel-copy">Run this analysis for the visible map extent. It groups repeated reported collisions around a stable anchor and screens anchors against published school points at 500m and 1km. The map shows up to 200 local school points; analysis searches the full catalogue.</p>{analysisScope && <p className="analysis-scope-note">Saved analysis area: {bboxLabel(analysisScope)}. Panning or zooming changes the live map only; rerun the analysis to update this saved screen.</p>}<label className="range-field"><span>Anchor radius <strong>{radius}m</strong></span><select value={radius} onChange={(event) => onRadius(Number(event.target.value))}><option value="50">50m</option><option value="100">100m</option><option value="200">200m</option><option value="500">500m</option></select></label><div className="analysis-controls"><label><span>Harm class</span><select value={harm} onChange={(event) => onHarm(event.target.value as AnalysisHarmFilter)}><option value="all">All grouped collisions</option><option value="ksi">At least one KSI collision</option><option value="repeated-ksi">Repeated KSI collisions</option><option value="slight-only">Slight-only harm</option></select></label><label><span>School screen</span><select value={schoolDistance ?? ''} onChange={(event) => onSchoolDistance(event.target.value ? Number(event.target.value) as 500 | 1000 : undefined)}><option value="">Show all groups</option><option value="500">Within 500m</option><option value="1000">Within 1km</option></select></label></div>{inputRecords !== null && inputRecords > 10000 && <p className="limit-warning">This view contains {format(inputRecords)} matching records. Narrow the map or filters below 10,000 before analysis.</p>}{error && <p className="limit-warning">{error}</p>}<button className="primary-button" type="button" onClick={onRun} disabled={running || blocked}>{running ? 'Analysing…' : 'Analyse this area'}</button>{edgeWarning && <p className="inline-note">Some groups touch the analysis boundary. Expand the map and rerun before interpreting the coverage.</p>}{groups.length > 0 && <><div className="coverage-grid">{coverage.map((item) => <div key={item.distanceMetres}><span>{item.distanceMetres === 500 ? '500m' : '1km'} school coverage</span><strong>{item.percentage === null ? '—' : `${item.percentage}%`}</strong><small>{item.matchingLocations} of {item.totalLocations} anchors</small></div>)}</div><p className="analysis-method-note">Coverage is calculated from whole groups using each group’s anchor point; the nearest-school distance is measured from that anchor. A group may extend beyond the anchor radius.</p><ol className="analysis-list">{visibleGroups.map((group, index) => <li key={group.id}><button type="button" className={`analysis-location ${selectedGroup?.id === group.id ? 'selected' : ''}`} aria-pressed={selectedGroup?.id === group.id} onClick={() => onGroupSelect(group)}><span className="location-rank">{String(index + 1).padStart(2, '0')}</span><span className="location-copy"><strong>{format(group.collisions)} collisions</strong><span>{group.yearsRepresented.join(' · ')} · {format(group.harm.ksiCollisions)} KSI collision{group.harm.ksiCollisions === 1 ? '' : 's'}</span><small>Harm: {groupMetric(group.harm.casualties.fatalities)} fatal · {groupMetric(group.harm.casualties.serious)} serious · {groupMetric(group.harm.casualties.slight)} slight casualties</small><small>{group.schoolProximity.nearestSchool ? `${Math.round(group.schoolProximity.nearestSchool.distanceMetres)}m to ${group.schoolProximity.nearestSchool.school.name}` : 'No school within 1km'}</small></span><span className="location-arrow" aria-hidden="true">↗</span></button></li>)}</ol>{groups.length > 8 && <button className="text-button analysis-list-toggle" type="button" onClick={() => setShowAll((current) => !current)}>{showAll ? 'Show fewer locations' : `Show all ${format(groups.length)} locations`}</button>}{selectedGroup && <AnalysisGroupDetail group={selectedGroup} onClose={onGroupClose} />}</>}{provenance.length > 0 && <details className="method-disclosure"><summary>School coverage source</summary>{provenance.map((item) => <p key={`${item.country}-${item.dataset}`}>{item.country}: {item.publisher} · {item.totalRows.toLocaleString()} source rows, {item.coordinateRows.toLocaleString()} with coordinates. {item.note}</p>)}</details>}</section>;
};

const DetailPanel = ({ detail, loading, onClose }: { detail: CollisionDetail | null; loading: boolean; onClose: () => void }) => !detail && !loading ? null : <section className="detail-panel"><div className="section-heading-row"><div><p className="section-kicker">Selected collision</p><h2>{loading ? 'Loading detail…' : detail?.roadName ?? 'Reported collision'}</h2></div><button className="text-button" type="button" onClick={onClose}>Close</button></div>{detail && <><div className="detail-grid"><span>Date<strong>{detail.date ?? detail.year ?? 'Not recorded'}</strong></span><span>Severity<strong>{severityLabel(detail.severity)}</strong></span><span>Authority<strong>{detail.authorityName ?? detail.authorityCode ?? 'Not recorded'}</strong></span><span>Casualties<strong>{format(detail.casualtyCount)}</strong></span><span>Fatalities<strong>{format(detail.fatalities)}</strong></span><span>Seriously injured<strong>{format(detail.seriousCasualties)}</strong></span></div><details className="method-disclosure"><summary>Linked casualty and vehicle evidence</summary><pre className="evidence-json">{JSON.stringify(detail.evidence, null, 2)}</pre></details></>}</section>;

export const App = () => {
  const initial = useMemo(parseInitialState, []);
  const [loadState, setLoadState] = useState<LoadState>({ manifest: null, error: null });
  const [filters, setFilters] = useState<QueryFilters>(initial.filters);
  const [bbox, setBBox] = useState<BBox | null>(null);
  const [zoom, setZoom] = useState(5);
  const [radius, setRadius] = useState(initial.radius);
  const [harm, setHarm] = useState<AnalysisHarmFilter>(initial.harm);
  const [schoolDistance, setSchoolDistance] = useState<500 | 1000 | undefined>(initial.schoolDistance);
  const [view, setView] = useState<ViewPayload | null>(null);
  const [summary, setSummary] = useState<SummaryState>({ selected: null, viewport: null, datasetVersion: null, loading: false, stale: true, error: null });
  const [analysis, setAnalysis] = useState<{ groups: AnalysisGroup[]; coverage: AnalysisPayload['schoolCoverage']; provenance: SchoolCoverageProvenance[]; inputRecords: number | null; edgeWarning: boolean; error: string | null }>({ groups: [], coverage: [], provenance: [], inputRecords: null, edgeWarning: false, error: null });
  const [analysisRequest, setAnalysisRequest] = useState<QueryOptions | null>(null);
  const [analysisScope, setAnalysisScope] = useState<BBox | null>(null);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [schools, setSchools] = useState<SchoolRecord[]>([]);
  const [schoolQuery, setSchoolQuery] = useState('');
  const [schoolSearch, setSchoolSearch] = useState('');
  const [schoolOffset, setSchoolOffset] = useState(0);
  const [schoolRefresh, setSchoolRefresh] = useState(0);
  const [schoolLoading, setSchoolLoading] = useState(false);
  const [schoolError, setSchoolError] = useState<string | null>(null);
  const [schoolHasMore, setSchoolHasMore] = useState(false);
  const [showAllSchools, setShowAllSchools] = useState(false);
  const [selectedSchoolId, setSelectedSchoolId] = useState<string | undefined>();
  const [selectedCollisionId, setSelectedCollisionId] = useState<string | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<[number, number] | null>(null);
  const [selectedAnalysisGroup, setSelectedAnalysisGroup] = useState<AnalysisGroup | null>(null);
  const [detail, setDetail] = useState<CollisionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [focusBBox, setFocusBBox] = useState<BBox | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [placeStatus, setPlaceStatus] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const analysisSequence = useRef(0);
  const detailSequence = useRef(0);
  const detailController = useRef<AbortController | null>(null);
  const placeSequence = useRef(0);
  const placeController = useRef<AbortController | null>(null);
  const schoolSequence = useRef(0);
  const schoolFailedOffset = useRef<number | null>(null);
  const placeCache = useRef(new Map<string, PlaceResult>());
  const placeLastRequestAt = useRef(0);

  useEffect(() => { const controller = new AbortController(); loadManifest(controller.signal).then((response) => { const initialBBox = initial.bbox ?? selectionBBox(response.data, initial.filters); setLoadState({ manifest: response.data, error: null }); setBBox(initialBBox); setFocusBBox(initialBBox); setZoom(initial.zoom ?? 5); setSelectedSchoolId(initial.schoolId); }).catch((error: unknown) => { if ((error as Error).name !== 'AbortError') setLoadState({ manifest: null, error: error instanceof Error ? error.message : 'The national manifest could not be loaded.' }); }); return () => controller.abort(); }, [initial]);
  const manifest = loadState.manifest;
  const activeBBox = bbox ?? manifest?.extent ?? null;
  const requestOptions = useMemo(() => activeBBox ? paramsFor(filters, activeBBox, zoom, radius, harm, schoolDistance, selectedSchoolId) : null, [activeBBox, filters, harm, radius, schoolDistance, selectedSchoolId, zoom]);
  useEffect(() => {
    if (!manifest || !requestOptions) return undefined;
    const controller = new AbortController(); const sequence = ++requestSequence.current; setSummary((current) => ({ ...current, loading: true, stale: true, error: null }));
    const selectedOptions = paramsFor(filters, undefined, undefined, radius, harm, schoolDistance, selectedSchoolId);
    Promise.all([loadView(requestOptions, controller.signal), loadSummary(selectedOptions, controller.signal), loadSummary(requestOptions, controller.signal)]).then(([viewResponse, selectedResponse, viewportResponse]) => {
      if (sequence !== requestSequence.current) return;
      if (viewResponse.datasetVersion !== manifest.datasetVersion || selectedResponse.datasetVersion !== manifest.datasetVersion || viewportResponse.datasetVersion !== manifest.datasetVersion) {
        setSummary((current) => ({ ...current, loading: false, stale: true, error: 'The dataset changed while this view was loading. Reload the page to synchronise the map.' }));
        return;
      }
      setView(viewResponse.data); setSummary({ selected: selectedResponse.data.metrics, viewport: viewportResponse.data.metrics, datasetVersion: viewResponse.datasetVersion, loading: false, stale: false, error: null });
    }).catch((error: unknown) => { if (sequence === requestSequence.current && (error as Error).name !== 'AbortError') setSummary((current) => ({ ...current, loading: false, stale: true, error: error instanceof Error ? error.message : 'The national view could not be loaded.' })); });
    return () => controller.abort();
  }, [manifest, requestOptions, filters, radius, harm, schoolDistance, selectedSchoolId]);
  useEffect(() => { if (!manifest || !analysisRequest) return undefined; const controller = new AbortController(); const sequence = ++analysisSequence.current; setAnalysisRunning(true); loadAnalysis(analysisRequest, controller.signal).then((response) => { if (sequence !== analysisSequence.current) return; if (response.datasetVersion !== manifest.datasetVersion) { setAnalysis((current) => ({ ...current, error: 'The dataset changed while this analysis was loading. Rerun the analysis after reloading the page.' })); setAnalysisRunning(false); return; } setAnalysis({ groups: response.data.groups, coverage: response.data.schoolCoverage, provenance: response.data.schoolCoverageProvenance ?? [], inputRecords: response.data.inputRecords, edgeWarning: response.data.edgeWarning, error: null }); setAnalysisRunning(false); }).catch((error: unknown) => { if (sequence !== analysisSequence.current || (error as Error).name === 'AbortError') return; setAnalysis((current) => ({ ...current, error: error instanceof ApiRequestError && error.code === 'analysis_limit_exceeded' ? 'Narrow the analysis area or filters below 10,000 matching records.' : error instanceof Error ? error.message : 'Analysis could not be completed.' })); setAnalysisRunning(false); }); return () => controller.abort(); }, [analysisRequest, manifest]);
  useEffect(() => { analysisSequence.current += 1; setAnalysisRequest(null); setAnalysisScope(null); setAnalysisRunning(false); setSelectedAnalysisGroup(null); setAnalysis({ groups: [], coverage: [], provenance: [], inputRecords: null, edgeWarning: false, error: null }); }, [filters, harm, radius, schoolDistance, selectedSchoolId]);
  useEffect(() => { if (!activeBBox || !manifest) return; const params = queryString(paramsFor(filters, activeBBox, zoom, radius, harm, schoolDistance, selectedSchoolId)); window.history.replaceState(null, '', `${window.location.pathname}?${params}`); }, [activeBBox, filters, harm, manifest, radius, schoolDistance, selectedSchoolId, zoom]);
  useEffect(() => {
    if (!activeBBox || !manifest) return undefined;
    const controller = new AbortController();
    const sequence = ++schoolSequence.current;
    const requestedOffset = schoolSearch ? schoolOffset : 0;
    const offset = schoolSearch ? retryableSchoolOffset(requestedOffset, schoolFailedOffset.current) : requestedOffset;
    if (offset !== requestedOffset) setSchoolOffset(offset);
    const options = schoolSearch ? { ...paramsFor(filters, undefined, undefined, undefined, undefined, undefined, undefined), query: schoolSearch, limit: SCHOOL_PAGE_SIZE, offset } : { ...paramsFor(filters, activeBBox, undefined, undefined, undefined, undefined, undefined), limit: SCHOOL_PAGE_SIZE };
    setSchoolLoading(true); setSchoolError(null);
    loadSchools(options, controller.signal).then((response) => {
      if (sequence !== schoolSequence.current) return;
      if (response.datasetVersion !== manifest.datasetVersion) { setSchools([]); setSchoolHasMore(false); setSchoolError('The school catalogue changed while loading. Reload the page to synchronise it.'); setSchoolLoading(false); return; }
      const incoming = response.data.schools;
      schoolFailedOffset.current = null;
      setSchools((current) => {
        if (!schoolSearch || offset === 0) return incoming;
        const seen = new Set(current.map((school) => school.id));
        return [...current, ...incoming.filter((school) => !seen.has(school.id))];
      });
      setSchoolHasMore(Boolean(schoolSearch) && incoming.length === SCHOOL_PAGE_SIZE);
      setSchoolLoading(false);
    }).catch((error: unknown) => {
      if (sequence !== schoolSequence.current || (error as Error).name === 'AbortError') return;
      schoolFailedOffset.current = schoolSearch ? offset : null;
      setSchoolError(error instanceof Error ? error.message : 'The school catalogue could not be loaded.'); setSchoolLoading(false);
    });
    return () => controller.abort();
  }, [activeBBox, filters, manifest, schoolOffset, schoolRefresh, schoolSearch]);

  const handleCollision = (id: string, point: [number, number]) => { detailController.current?.abort(); const sequence = ++detailSequence.current; const controller = new AbortController(); detailController.current = controller; setSelectedAnalysisGroup(null); setSelectedCollisionId(id); setSelectedPoint(point); setDetail(null); setDetailLoading(true); loadCollisionDetail(id, controller.signal).then((response) => { if (sequence === detailSequence.current) setDetail(response.data); }).catch(() => undefined).finally(() => { if (sequence === detailSequence.current) setDetailLoading(false); }); };
  const handleAnalysisGroup = (group: AnalysisGroup) => { detailController.current?.abort(); detailSequence.current += 1; setDetailLoading(false); setDetail(null); setSelectedCollisionId(null); setSelectedPoint(null); setSelectedAnalysisGroup(group); const span = Math.max(0.025, (radius / 111_000) * 3); setFocusBBox({ west: group.anchor.longitude - span, east: group.anchor.longitude + span, south: group.anchor.latitude - span, north: group.anchor.latitude + span }); };
  const handlePlace = async (query: string) => {
    placeController.current?.abort();
    const sequence = ++placeSequence.current;
    const controller = new AbortController();
    placeController.current = controller;
    const key = query.trim().toLocaleLowerCase('en-GB');
    if (!key) return;
    const cached = placeCache.current.get(key);
    if (cached) {
      setBBox(cached.bbox); setFocusBBox(cached.bbox); setPlaceStatus(`Map moved to ${cached.label || query}.`); return;
    }
    const waitMs = Math.max(0, 1_000 - (Date.now() - placeLastRequestAt.current));
    setPlaceStatus(waitMs ? 'Waiting briefly before searching…' : 'Searching…');
    if (waitMs) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    if (sequence !== placeSequence.current) return;
    placeLastRequestAt.current = Date.now();
    try {
      const photonUrl = new URL('https://photon.komoot.io/api/');
      photonUrl.searchParams.set('q', query);
      photonUrl.searchParams.set('limit', '8');
      photonUrl.searchParams.set('lang', 'en');
      const photonResponse = await fetch(photonUrl, { signal: controller.signal, headers: { Accept: 'application/geo+json, application/json' } });
      const photonPayload = photonResponse.ok ? await photonResponse.json() as { features?: PhotonFeature[] } : { features: [] };
      const photonMatch = (photonPayload.features ?? []).find((feature) => {
        const coordinates = feature.geometry?.coordinates;
        return feature.geometry?.type === 'Point' && Array.isArray(coordinates) && finiteCoordinate(coordinates[0]) && finiteCoordinate(coordinates[1]) && String(feature.properties?.countrycode ?? '').toLocaleLowerCase() === 'gb' && placeInEnglandOrWales(manifest, coordinates[0], coordinates[1]);
      });
      let match: PlaceResult | null = null;
      if (photonMatch) {
        const coordinates = photonMatch.geometry?.coordinates as [number, number];
        const label = placeLabel(photonMatch.properties) || query;
        const extent = extentBBox(photonMatch.properties?.extent);
        match = { label, bbox: extent && placeInEnglandOrWales(manifest, (extent.west + extent.east) / 2, (extent.south + extent.north) / 2) ? extent : { west: coordinates[0] - .08, east: coordinates[0] + .08, south: coordinates[1] - .05, north: coordinates[1] + .05 } };
      }
      if (!match && /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(query)) {
        const postcodeResponse = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(query.replace(/\s+/g, ''))}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (postcodeResponse.ok) {
          const postcodePayload = await postcodeResponse.json() as { result?: { latitude?: unknown; longitude?: unknown } };
          const latitude = postcodePayload.result?.latitude;
          const longitude = postcodePayload.result?.longitude;
          if (finiteCoordinate(latitude) && finiteCoordinate(longitude) && placeInEnglandOrWales(manifest, longitude, latitude)) match = { label: query.toUpperCase(), bbox: { west: longitude - .03, east: longitude + .03, south: latitude - .02, north: latitude + .02 } };
        }
      }
      if (sequence !== placeSequence.current) return;
      if (!match) { setPlaceStatus('No place found in England or Wales.'); return; }
      placeCache.current.set(key, match); setBBox(match.bbox); setFocusBBox(match.bbox); setPlaceStatus(`Map moved to ${match.label}.`);
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && sequence === placeSequence.current) setPlaceStatus('Place search is unavailable right now.');
    }
  };
  const resetSchoolResults = () => { schoolFailedOffset.current = null; setSchoolOffset(0); setSchoolRefresh((value) => value + 1); setSchools([]); setSchoolHasMore(false); setShowAllSchools(false); setSchoolError(null); };
  const handleFiltersChange = (next: QueryFilters) => { const moved = next.country !== filters.country || next.authorities.join(',') !== filters.authorities.join(','); setFilters(next); if (moved) resetSchoolResults(); if (moved && manifest) { const nextBBox = selectionBBox(manifest, next); setBBox(nextBBox); setFocusBBox(nextBBox); } };
  const runAnalysis = () => {
    if (!activeBBox || analysisRunning || summary.stale || blocked) return;
    setSelectedAnalysisGroup(null);
    setAnalysis({ groups: [], coverage: [], provenance: [], inputRecords: null, edgeWarning: false, error: null });
    const requested = paramsFor(filters, activeBBox, zoom, radius, harm, schoolDistance, selectedSchoolId);
    setAnalysisScope(requested.bbox ?? null);
    setAnalysisRequest(requested);
  };
  if (loadState.error) return <main className="state-page"><div className="state-card error-state"><h1>England &amp; Wales Observatory</h1><p>{loadState.error}</p><p>Check the API deployment and reload.</p></div></main>;
  if (!manifest) return <main className="state-page"><div className="state-card"><span className="loading-spinner" /><p className="section-kicker">National evidence view</p><h1>Loading the observatory</h1><p>Reading the current dataset manifest.</p></div></main>;
  const matchingCount = summary.stale ? null : view?.recordCount ?? summary.viewport?.collisions ?? null;
  const blocked = (summary.viewport?.collisions ?? 0) > 10000;
  const analysisDisabledReason = summary.stale
    ? summary.loading ? 'Wait for the current map data to finish loading.' : 'The current map data is unavailable; retry the map request before showing hotspots.'
    : blocked ? 'Narrow the map or filters below 10,000 matching records before showing hotspots.'
      : null;
  const analysisStatus = analysisRunning
    ? `Finding hotspot locations in the ${bboxLabel(analysisScope ?? activeBBox)}.`
    : analysis.error ? `Hotspot screening failed: ${analysis.error}`
      : analysisScope ? analysis.groups.length ? `${format(analysis.groups.length)} hotspot location${analysis.groups.length === 1 ? '' : 's'} shown. Saved area: ${bboxLabel(analysisScope)}.` : `No persistent collision locations found. Saved area: ${bboxLabel(analysisScope)}.`
        : summary.stale ? summary.loading ? 'Map data is loading. Hotspot screening will be available when it is ready.' : 'Map data is unavailable. Hotspot screening is paused.'
          : 'Hotspots are hidden. Show hotspots for the current map extent.';
  const analysisButtonLabel = analysisRunning ? 'Finding hotspots…' : analysisScope ? 'Refresh hotspots' : 'Show hotspots';
  return <div className="app-shell"><header className="app-header"><div className="header-inner"><div className="brand-mark" aria-hidden="true"><span>EW</span><i /></div><div><p className="eyebrow">National road safety evidence</p><h1>{copy.title}</h1><p className="subtitle">{copy.subtitle}</p></div><div className="header-status"><span className="status-dot" aria-hidden="true" />{summary.loading ? 'Updating' : 'Current dataset'}<br /><strong>{manifest.years.at(-1) ?? 'Latest available year'}</strong><nav className="header-links" aria-label="Project links"><a href="https://awjreynolds.github.io/">All projects</a><a href="https://github.com/awjreynolds/england-wales-collision-map">Source</a><a href="#method">Method</a></nav></div></div></header><main className="workspace"><section className="map-column" aria-label="England and Wales collision map"><div className="map-toolbar"><div><span className="map-toolbar-label">{bboxLabel(activeBBox)}</span><strong>{matchingCount === null ? 'Updating…' : `${format(matchingCount)} matching collisions`}</strong>{view?.mode === 'aggregates' && !summary.stale && <small className="aggregate-note">Aggregated cells · click a cell to narrow</small>}</div><div className="map-toolbar-actions"><div className="map-analysis-control"><button className="map-analysis-button" type="button" onClick={runAnalysis} disabled={analysisRunning || Boolean(analysisDisabledReason)} aria-describedby="map-analysis-status">{analysisButtonLabel}</button><p id="map-analysis-status" className={`map-analysis-status ${analysis.error ? 'error' : ''}`} aria-live="polite">{analysisStatus}</p>{analysisDisabledReason && !analysisRunning && <p className="map-analysis-disabled">{analysisDisabledReason}</p>}</div><button className="map-reset" type="button" onClick={() => { setBBox(manifest.extent); setFocusBBox(manifest.extent); setResetSignal((value) => value + 1); }}>National view</button></div></div><div className="map-frame"><MapView view={view} manifest={manifest} initialBBox={initial.bbox ?? null} initialZoom={initial.zoom ?? 5} schools={schools} analysisGroups={analysis.groups} resetSignal={resetSignal} focusBBox={focusBBox} selectedCollisionId={selectedCollisionId} selectedPoint={selectedPoint} selectedAnalysisGroup={selectedAnalysisGroup} detail={detail} onPopupClose={() => { detailController.current?.abort(); detailSequence.current += 1; setDetailLoading(false); setDetail(null); setSelectedCollisionId(null); setSelectedPoint(null); setSelectedAnalysisGroup(null); }} onBoundsChange={(next, nextZoom) => { setBBox((current) => sameBBox(current, next) ? current : next); setZoom((current) => Math.abs(current - nextZoom) < 0.01 ? current : nextZoom); }} onAggregateClick={(next) => { setBBox(next); setFocusBBox(next); }} onCollisionClick={handleCollision} onAnalysisGroupClick={handleAnalysisGroup} onSchoolClick={(school) => { setSchoolQuery(school.name); setSelectedSchoolId(school.id); }} />{summary.stale && <div className="map-stale-banner">{summary.error ? `Previous map result shown · ${summary.error}` : 'Updating map result…'}</div>}<div className="map-legend"><span>Map key</span><span><i className="legend-cluster" />Aggregate cell</span><span><i className="legend-hotspot" />Hotspot location</span><span><i className="legend-fatal" />Fatal</span><span><i className="legend-serious" />Serious</span><span><i className="legend-slight" />Slight</span><span><i className="legend-school" />School</span></div></div></section><aside className="sidebar"><div className="sidebar-scroll"><section className="quality-note"><div className="quality-icon">i</div><div><h2>Read this map as evidence</h2><p>Reported STATS19 injury collisions record reported harm, not every incident. The school screen informs Safe System investigation; it does not infer routes, attendance, exposure or future KSI probability.</p>{manifest.qualityNotices.slice(0, 2).map((notice) => <p key={notice.id}><strong>{notice.title}:</strong> {notice.text}</p>)}</div></section><Metrics metrics={summary.selected} label="Selected national scope" updating={summary.loading} stale={summary.stale} /><Metrics metrics={summary.viewport} label="Current map extent" updating={summary.loading} stale={summary.stale} />{summary.error && <p className="limit-warning">Current totals could not be refreshed: {summary.error}</p>}<PlaceSearch onSearch={handlePlace} status={placeStatus} /><Filters manifest={manifest} filters={filters} onChange={handleFiltersChange} onPreset={() => handleFiltersChange({ ...filters, country: 'England', authorities: WEST_OF_ENGLAND })} onReset={() => { handleFiltersChange(DEFAULT_FILTERS); setSelectedSchoolId(undefined); setSchoolQuery(''); setSchoolSearch(''); setHarm('all'); setSchoolDistance(undefined); setSelectedAnalysisGroup(null); }} /><section className="search-panel school-search"><p className="section-kicker">School catalogue</p><h2>School proximity screen</h2><form onSubmit={(event) => { event.preventDefault(); const nextQuery = schoolQuery.trim(); setSchoolSearch(nextQuery); setSchoolOffset(0); setSchoolRefresh((value) => value + 1); setSchoolError(null); setSchoolHasMore(false); setSchools([]); setShowAllSchools(false); setSelectedSchoolId(undefined); }}><div className="search-row"><input aria-label="School name" value={schoolQuery} onChange={(event) => setSchoolQuery(event.target.value)} placeholder="Search a school name" /><button type="submit">Search</button></div></form>{schoolLoading && <p className="inline-note" aria-live="polite">Loading school matches…</p>}{schoolError && <p className="limit-warning" role="alert">{schoolError}</p>}{selectedSchoolId && <p className="inline-note">Selected school filter active. Clear the search and select a result to remove it.</p>}{(showAllSchools ? schools : schools.slice(0, 6)).map((school) => <button className={`school-result ${selectedSchoolId === school.id ? 'selected' : ''}`} key={school.id} type="button" onClick={() => { setSelectedSchoolId(school.id); setSchoolQuery(school.name); setFocusBBox({ west: school.longitude - .03, east: school.longitude + .03, south: school.latitude - .02, north: school.latitude + .02 }); setBBox({ west: school.longitude - .03, east: school.longitude + .03, south: school.latitude - .02, north: school.latitude + .02 }); }}>{school.name}<small>{school.country} · {school.phase ?? 'phase not recorded'}</small></button>)}{schools.length > 6 && <button className="text-button school-results-toggle" type="button" onClick={() => setShowAllSchools((value) => !value)}>{showAllSchools ? 'Show fewer matches' : `Show all ${format(schools.length)} loaded matches`}</button>}{schoolSearch && schoolHasMore && <button className="text-button school-results-more" type="button" disabled={schoolLoading} onClick={() => { setSchoolOffset((value) => value + SCHOOL_PAGE_SIZE); setShowAllSchools(true); }}>{schoolLoading ? 'Loading more…' : 'Load more matches'}</button>}{schoolSearch && !schoolLoading && !schoolError && !schools.length && <p className="inline-note">No schools matched “{schoolSearch}”.</p>}</section><AnalysisPanel groups={analysis.groups} coverage={analysis.coverage} provenance={analysis.provenance} inputRecords={analysis.inputRecords ?? summary.viewport?.collisions ?? null} edgeWarning={analysis.edgeWarning} radius={radius} harm={harm} schoolDistance={schoolDistance} analysisScope={analysisScope} selectedGroup={selectedAnalysisGroup} onGroupSelect={handleAnalysisGroup} onGroupClose={() => { setSelectedAnalysisGroup(null); }} onRun={runAnalysis} onRadius={(value) => { setRadius(value); }} onHarm={(value) => { setHarm(value); }} onSchoolDistance={(value) => { setSchoolDistance(value); }} running={analysisRunning} blocked={blocked || Boolean(analysisDisabledReason)} error={analysis.error} /><DetailPanel detail={detail} loading={detailLoading} onClose={() => { detailController.current?.abort(); detailSequence.current += 1; setDetailLoading(false); setDetail(null); setSelectedCollisionId(null); setSelectedPoint(null); }} /><details id="method" className="provenance-panel"><summary>About the data and method</summary><div className="provenance-content"><p>{manifest.source.publisher} · {manifest.source.dataset}. Generated {new Date(manifest.generatedAt).toLocaleDateString('en-GB')}; {format(manifest.collisionCount)} mapped collision rows.</p><p>Persistent groups use a deterministic anchor radius and require three collisions across two calendar years. The bounded analysis is capped at 10,000 matching records. School points come from the published England GIAS and Welsh DataMapWales layers; Welsh independent schools without authoritative public coordinates are excluded and disclosed in the coverage result.</p><p>Authority codes are source-recorded. Selecting a single code can cover only part of a 2021–25 series when an authority changed; location browsing uses the full spatial extent independently of administrative change.</p><p>See <a href="https://www.gov.uk/government/publications/road-safety-stats19-road-accident-and-safety-data" target="_blank" rel="noreferrer">DfT STATS19</a>, <a href="https://get-information-schools.service.gov.uk/" target="_blank" rel="noreferrer">DfE GIAS</a> and <a href="https://datamap.gov.wales/" target="_blank" rel="noreferrer">DataMapWales</a>.</p></div></details><p className="footer-note">Dataset {manifest.datasetVersion} · {manifest.scope}. View totals are exact for the current server query; changing the map extent requests a new bounded result.</p></div></aside></main></div>;
};
