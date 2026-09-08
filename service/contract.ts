/**
 * Public contract for the England and Wales national query service.
 *
 * Keep this file dependency free so the static application can import the
 * request/response shapes without importing the Worker, D1 adapter, or a
 * server-only package. Runtime query parsing lives here as well so every
 * endpoint uses the same filter semantics and request keys.
 */

export const API_VERSION = 'national.v1';
export const MAX_VIEW_FEATURES = 2_000;
export const MAX_VIEW_RESPONSE_BYTES = 1_000_000;
export const MAX_ANALYSIS_RECORDS = 10_000;
export const DEFAULT_RADIUS_METRES = 100;
export const ALLOWED_ANALYSIS_RADII = [50, 100, 200, 500] as const;
export const ALLOWED_SCHOOL_DISTANCES = [500, 1_000] as const;

export type Country = 'England' | 'Wales';
export type Severity = 'fatal' | 'serious' | 'slight' | 'unknown';
export type InvolvementFilter = 'all' | 'yes' | 'no' | 'unknown';
export type AnalysisHarmFilter = 'all' | 'ksi' | 'repeated-ksi' | 'slight-only';
export type SchoolDistanceMetres = (typeof ALLOWED_SCHOOL_DISTANCES)[number];
export type AnalysisRadiusMetres = (typeof ALLOWED_ANALYSIS_RADII)[number];

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
  /** True when the request explicitly spans the whole longitude world. */
  world?: boolean;
}

export interface QueryFilters {
  years: number[];
  /** Stable source authority codes, not display names. */
  authorities: string[];
  country?: Country;
  severities: Severity[];
  pedestrian: InvolvementFilter;
  cycle: InvolvementFilter;
  motorcycle: InvolvementFilter;
}

export interface ParsedQuery {
  filters: QueryFilters;
  bbox?: BBox;
  zoom?: number;
  radiusMetres: AnalysisRadiusMetres;
  schoolDistanceMetres?: SchoolDistanceMetres;
  schoolId?: string;
  harmFilter: AnalysisHarmFilter;
  /** Pagination is used by the school catalogue endpoint. */
  limit?: number;
  offset?: number;
}

export interface ApiResponse<T> {
  version: typeof API_VERSION;
  datasetVersion: string;
  requestKey: string;
  data: T;
}

export interface ApiErrorBody {
  version: typeof API_VERSION;
  requestKey: string;
  error: {
    code: string;
    message: string;
    details?: Record<string, string | number | boolean>;
  };
}

export interface DatasetManifest {
  datasetVersion: string;
  schemaVersion: string;
  title: string;
  scope: 'England and Wales';
  years: number[];
  extent: BBox;
  authorities?: AuthorityDescriptor[];
  collisionCount: number;
  casualtyCount?: number | null;
  source: {
    publisher: string;
    dataset: string;
    urls: string[];
    licence?: string;
    licenceUrl?: string;
  };
  generatedAt: string;
  retrievedAt?: string;
  qualityNotices: QualityNotice[];
  limits: {
    viewFeatureLimit: number;
    viewResponseBytes: number;
    analysisRecordLimit: number;
    analysisRequiresBbox: boolean;
  };
  stale?: boolean;
}

export interface AuthorityDescriptor {
  code: string;
  name: string;
  country: Country;
  bbox?: BBox;
}

export interface QualityNotice {
  id: string;
  title: string;
  text: string;
  sourceUrl?: string;
  years?: number[];
  countries?: Country[];
}

export interface SeverityCounts {
  fatal: number;
  serious: number;
  slight: number;
  unknown: number;
}

export interface NullableCount {
  value: number | null;
  unknownRecords: number;
}

export interface CasualtySeverityCounts {
  total: NullableCount;
  fatalities: NullableCount;
  serious: NullableCount;
  slight: NullableCount;
  ksi: NullableCount;
}

export interface SummaryMetrics {
  collisions: number;
  collisionSeverity: SeverityCounts;
  casualties: CasualtySeverityCounts;
  ksiCollisions: number;
  yearsRepresented: number[];
  complete: boolean;
  sourceRows?: number;
  mappableRows?: number;
}

export interface SummaryScope {
  bbox?: BBox;
  filters: QueryFilters;
  label?: string;
}

export interface SummaryPayload {
  scope: SummaryScope;
  metrics: SummaryMetrics;
  exact: true;
  precomputed: boolean;
}

export interface GeoJsonFeature<P> {
  type: 'Feature';
  id?: string;
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: P;
}

export interface GeoJsonFeatureCollection<P> {
  type: 'FeatureCollection';
  features: Array<GeoJsonFeature<P>>;
}

export interface PointProperties {
  kind: 'collision';
  id: string;
  year: number | null;
  severity: Severity;
  country: Country | null;
  authorityCode: string | null;
  authorityName: string | null;
}

export interface AggregateProperties {
  kind: 'aggregate';
  count: number;
  bbox: BBox;
  collisionSeverity: SeverityCounts;
  casualties: NullableCount;
  ksiCollisions: number;
  yearsRepresented: number[];
}

export interface ViewPayload {
  mode: 'points' | 'aggregates';
  features: GeoJsonFeatureCollection<PointProperties | AggregateProperties>;
  recordCount: number;
  featureCount: number;
  complete: true;
  aggregateCellDegrees?: number;
  bounds: BBox;
  filters: QueryFilters;
  zoom: number;
}

export interface CollisionEvidence {
  collision: Record<string, unknown>;
  casualties: Array<Record<string, unknown>>;
  vehicles: Array<Record<string, unknown>>;
  join?: Record<string, unknown>;
}

export interface CollisionDetail {
  id: string;
  datasetVersion: string;
  year: number | null;
  date: string | null;
  time: string | null;
  latitude: number;
  longitude: number;
  country: Country | null;
  authorityCode: string | null;
  authorityName: string | null;
  roadName: string | null;
  roadNumber: string | null;
  speedLimit: number | null;
  junctionDetail: string | null;
  severity: Severity;
  casualtyCount: number | null;
  fatalities: number | null;
  seriousCasualties: number | null;
  slightCasualties: number | null;
  ksiCasualties: number | null;
  pedestrianInvolved: boolean | null;
  cycleInvolved: boolean | null;
  motorcycleInvolved: boolean | null;
  evidence: CollisionEvidence;
}

export interface SchoolRecord {
  id: string;
  name: string;
  country: Country;
  latitude: number;
  longitude: number;
  status: string | null;
  phase: string | null;
}

export interface SchoolCoverageProvenance {
  country: Country;
  publisher: string;
  dataset: string;
  sourceUrl?: string;
  retrievedAt?: string;
  totalRows: number;
  coordinateRows: number;
  statusKnownRows?: number;
  phaseKnownRows?: number;
  note?: string;
}

export interface SchoolDistanceMatch {
  school: SchoolRecord;
  distanceMetres: number;
}

export interface SchoolsPayload {
  schools: Array<SchoolRecord & { distanceMetres?: number }>;
  bounds?: BBox;
  query?: string;
  exact: true;
  coverage?: SchoolCoverageProvenance[];
}

export interface AnalysisHarm {
  collisionSeverity: SeverityCounts;
  casualties: CasualtySeverityCounts;
  ksiCollisions: number;
  ksiCollisionYears: number[];
}

export interface AnalysisGroup {
  id: string;
  anchor: { collisionId: string; latitude: number; longitude: number };
  collisions: number;
  yearsRepresented: number[];
  harm: AnalysisHarm;
  memberIds: string[];
  schoolProximity: {
    within500m: boolean;
    within1km: boolean;
    nearestSchool: SchoolDistanceMatch | null;
    selectedDistanceMetres?: SchoolDistanceMetres;
    selectedSchoolMatch?: boolean;
  };
}

export interface SchoolCoverage {
  distanceMetres: SchoolDistanceMetres;
  matchingLocations: number;
  totalLocations: number;
  percentage: number | null;
}

export interface AnalysisPayload {
  scope: {
    bbox: BBox;
    filters: QueryFilters;
    radiusMetres: AnalysisRadiusMetres;
    harmFilter: AnalysisHarmFilter;
    selectedSchoolId?: string;
  };
  groups: AnalysisGroup[];
  schoolCoverage: SchoolCoverage[];
  schoolCoverageProvenance?: SchoolCoverageProvenance[];
  inputRecords: number;
  complete: true;
  edgeWarning: boolean;
  limits: {
    recordLimit: number;
    returnedRecords: number;
  };
}

export interface QueryParseErrorShape {
  code: string;
  message: string;
  parameter?: string;
}

export interface RequestKeyExtras {
  query?: string;
  id?: string;
  limit?: number;
  offset?: number;
}

export class QueryParseError extends Error {
  readonly code: string;
  readonly parameter?: string;

  constructor(shape: QueryParseErrorShape) {
    super(shape.message);
    this.name = 'QueryParseError';
    this.code = shape.code;
    this.parameter = shape.parameter;
  }
}

const COUNTRY_VALUES: readonly Country[] = ['England', 'Wales'];
const SEVERITY_VALUES: readonly Severity[] = ['fatal', 'serious', 'slight', 'unknown'];
const INVOLVEMENT_VALUES: readonly InvolvementFilter[] = ['all', 'yes', 'no', 'unknown'];
const HARM_VALUES: readonly AnalysisHarmFilter[] = ['all', 'ksi', 'repeated-ksi', 'slight-only'];

const isCountry = (value: string): value is Country => COUNTRY_VALUES.includes(value as Country);
const isSeverity = (value: string): value is Severity => SEVERITY_VALUES.includes(value as Severity);
const isInvolvement = (value: string): value is InvolvementFilter => INVOLVEMENT_VALUES.includes(value as InvolvementFilter);
const isHarmFilter = (value: string): value is AnalysisHarmFilter => HARM_VALUES.includes(value as AnalysisHarmFilter);

const parseCsv = (url: URL, key: string): string[] => {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') return [];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length > 100) throw new QueryParseError({ code: 'too_many_values', message: `${key} accepts at most 100 values.`, parameter: key });
  return [...new Set(values)];
};

const parseYears = (url: URL): number[] => {
  const values = parseCsv(url, 'years');
  const years = values.map((value) => {
    if (!/^\d{4}$/.test(value)) throw new QueryParseError({ code: 'invalid_year', message: `Invalid calendar year: ${value}.`, parameter: 'years' });
    const year = Number(value);
    if (year < 1900 || year > 2100) throw new QueryParseError({ code: 'invalid_year', message: `Invalid calendar year: ${value}.`, parameter: 'years' });
    return year;
  });
  return years.sort((left, right) => left - right);
};

const parseSeverities = (url: URL): Severity[] => parseCsv(url, 'severity').map((value) => {
  if (!isSeverity(value)) throw new QueryParseError({ code: 'invalid_severity', message: `Unknown severity: ${value}.`, parameter: 'severity' });
  return value;
});

const parseInvolvement = (url: URL, key: 'pedestrian' | 'cycle' | 'motorcycle'): InvolvementFilter => {
  const value = url.searchParams.get(key) ?? 'all';
  if (!isInvolvement(value)) throw new QueryParseError({ code: 'invalid_involvement', message: `Unknown ${key} filter: ${value}.`, parameter: key });
  return value;
};

const parseBoundedInteger = (url: URL, key: string, minimum: number, maximum: number): number | undefined => {
  const value = url.searchParams.get(key);
  if (value === null || value === '') return undefined;
  if (!/^-?\d+$/.test(value)) throw new QueryParseError({ code: 'invalid_number', message: `${key} must be an integer.`, parameter: key });
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new QueryParseError({ code: 'out_of_range', message: `${key} must be between ${minimum} and ${maximum}.`, parameter: key });
  return parsed;
};

const normalizeLongitude = (longitude: number): number => {
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && longitude > 0 ? 180 : wrapped;
};

const parseBBox = (url: URL): BBox | undefined => {
  const value = url.searchParams.get('bbox');
  if (value === null || value.trim() === '') return undefined;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || value.split(',').some((part) => part.trim() === '') || parts.some((part) => !Number.isFinite(part))) throw new QueryParseError({ code: 'invalid_bbox', message: 'bbox must be west,south,east,north.', parameter: 'bbox' });
  const [west, south, east, north] = parts;
  if (south < -90 || south > 90 || north < -90 || north > 90 || south > north) throw new QueryParseError({ code: 'invalid_bbox', message: 'bbox latitude bounds must be between -90 and 90 and south must not exceed north.', parameter: 'bbox' });
  if (Math.abs(east - west) > 360) throw new QueryParseError({ code: 'invalid_bbox', message: 'bbox longitude width cannot exceed 360 degrees.', parameter: 'bbox' });
  const rawWidth = east >= west ? east - west : east + 360 - west;
  const world = Math.abs(east - west) >= 360 || rawWidth >= 360;
  return { west: normalizeLongitude(west), south, east: normalizeLongitude(east), north, ...(world ? { world: true } : {}) };
};

const parseCountry = (url: URL): Country | undefined => {
  const value = url.searchParams.get('country');
  if (value === null || value === '') return undefined;
  if (!isCountry(value)) throw new QueryParseError({ code: 'invalid_country', message: `Unknown country: ${value}.`, parameter: 'country' });
  return value;
};

const parseRadius = (url: URL): AnalysisRadiusMetres => {
  const value = url.searchParams.get('radius');
  if (value === null || value === '') return DEFAULT_RADIUS_METRES;
  const parsed = Number(value);
  if (!ALLOWED_ANALYSIS_RADII.includes(parsed as AnalysisRadiusMetres)) throw new QueryParseError({ code: 'invalid_radius', message: `radius must be one of ${ALLOWED_ANALYSIS_RADII.join(', ')} metres.`, parameter: 'radius' });
  return parsed as AnalysisRadiusMetres;
};

const parseSchoolDistance = (url: URL): SchoolDistanceMetres | undefined => {
  const value = url.searchParams.get('schoolDistance');
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!ALLOWED_SCHOOL_DISTANCES.includes(parsed as SchoolDistanceMetres)) throw new QueryParseError({ code: 'invalid_school_distance', message: 'schoolDistance must be 500 or 1000 metres.', parameter: 'schoolDistance' });
  return parsed as SchoolDistanceMetres;
};

const parseHarmFilter = (url: URL): AnalysisHarmFilter => {
  const value = url.searchParams.get('harm') ?? 'all';
  if (!isHarmFilter(value)) throw new QueryParseError({ code: 'invalid_harm_filter', message: `Unknown harm filter: ${value}.`, parameter: 'harm' });
  return value;
};

export const parseQuery = (url: URL): ParsedQuery => {
  const authorities = parseCsv(url, 'authorities');
  const zoom = parseBoundedInteger(url, 'zoom', 0, 22);
  const schoolId = url.searchParams.get('schoolId')?.trim() || undefined;
  if (schoolId && schoolId.length > 120) throw new QueryParseError({ code: 'invalid_school_id', message: 'schoolId is too long.', parameter: 'schoolId' });
  const limit = parseBoundedInteger(url, 'limit', 1, 500);
  const offset = parseBoundedInteger(url, 'offset', 0, 100_000);
  return {
    filters: {
      years: parseYears(url),
      authorities,
      country: parseCountry(url),
      severities: parseSeverities(url),
      pedestrian: parseInvolvement(url, 'pedestrian'),
      cycle: parseInvolvement(url, 'cycle'),
      motorcycle: parseInvolvement(url, 'motorcycle'),
    },
    bbox: parseBBox(url),
    zoom,
    radiusMetres: parseRadius(url),
    schoolDistanceMetres: parseSchoolDistance(url),
    schoolId,
    harmFilter: parseHarmFilter(url),
    limit,
    offset,
  };
};

const stableFilters = (filters: QueryFilters): QueryFilters => ({
  years: [...filters.years].sort((left, right) => left - right),
  authorities: [...filters.authorities].sort(),
  ...(filters.country ? { country: filters.country } : {}),
  severities: [...filters.severities].sort(),
  pedestrian: filters.pedestrian,
  cycle: filters.cycle,
  motorcycle: filters.motorcycle,
});

export const makeRequestKey = (path: string, query: ParsedQuery, extras: RequestKeyExtras = {}): string => JSON.stringify({
  path,
  bbox: query.bbox ?? null,
  zoom: query.zoom ?? null,
  filters: stableFilters(query.filters),
  radiusMetres: query.radiusMetres,
  schoolDistanceMetres: query.schoolDistanceMetres ?? null,
  schoolId: query.schoolId ?? null,
  harmFilter: query.harmFilter,
  limit: query.limit ?? null,
  offset: query.offset ?? null,
  extras,
});

export const makeResponse = <T>(datasetVersion: string, requestKey: string, data: T): ApiResponse<T> => ({
  version: API_VERSION,
  datasetVersion,
  requestKey,
  data,
});
