import type {
  AggregateProperties,
  BBox,
  CasualtySeverityCounts,
  CollisionDetail,
  Country,
  GeoJsonFeature,
  NullableCount,
  ParsedQuery,
  PointProperties,
  QueryFilters,
  Severity,
  SeverityCounts,
  SummaryMetrics,
} from '../contract';

export interface CollisionRow {
  id: string;
  dataset_version: string;
  year: number | null;
  date: string | null;
  time: string | null;
  country: Country | null;
  authority_code: string | null;
  authority_name: string | null;
  latitude: number;
  longitude: number;
  severity: Severity;
  casualty_count: number | null;
  fatalities: number | null;
  serious_casualties: number | null;
  slight_casualties: number | null;
  ksi_casualties: number | null;
  pedestrian_involved: number | null;
  cycle_involved: number | null;
  motorcycle_involved: number | null;
  road_name: string | null;
  road_number: string | null;
  speed_limit: number | null;
  junction_detail: string | null;
  source_json: string;
}

export interface AggregateRow {
  latitude_cell: number;
  longitude_cell: number;
  count: number;
  fatal_count: number;
  serious_count: number;
  slight_count: number;
  unknown_count: number;
  casualty_total: number | null;
  casualty_unknown: number;
  ksi_collision_count: number;
  years_json: string;
}

export interface SchoolRow {
  id: string;
  name: string;
  country: Country;
  latitude: number;
  longitude: number;
  status: string | null;
  phase: string | null;
  source_json: string;
}

export interface QueryPredicate {
  sql: string;
  params: Array<string | number | null>;
}

export const COLLISION_COLUMNS = `id, dataset_version, year, date, time, country, authority_code, authority_name,
  latitude, longitude, severity, casualty_count, fatalities, serious_casualties,
  slight_casualties, ksi_casualties, pedestrian_involved, cycle_involved, motorcycle_involved,
  road_name, road_number, speed_limit, junction_detail, source_json`;

const pushIn = (values: Array<string | number | null>, column: string, entries: Array<string | number>): string => {
  if (!entries.length) return '';
  values.push(...entries);
  return `${column} IN (${entries.map(() => '?').join(', ')})`;
};

const involvementPredicate = (column: string, value: QueryFilters['pedestrian']): string => {
  if (value === 'yes') return `${column} = 1`;
  if (value === 'no') return `${column} = 0`;
  if (value === 'unknown') return `${column} IS NULL`;
  return '';
};

const bboxWidth = (bbox: BBox): number => bbox.world === true ? 360 : bbox.east >= bbox.west ? bbox.east - bbox.west : bbox.east + 360 - bbox.west;

export const buildPredicate = (filters: QueryFilters, bbox?: BBox, datasetVersion?: string): QueryPredicate => {
  const params: Array<string | number | null> = [];
  const clauses: string[] = [];
  if (datasetVersion !== undefined) {
    clauses.push('dataset_version = ?');
    params.push(datasetVersion);
  }
  const years = pushIn(params, 'year', filters.years);
  if (years) clauses.push(years);
  const authorities = pushIn(params, 'authority_code', filters.authorities);
  if (authorities) clauses.push(authorities);
  if (filters.country) {
    clauses.push('country = ?');
    params.push(filters.country);
  }
  const severities = pushIn(params, 'severity', filters.severities);
  if (severities) clauses.push(severities);
  const involvement = [
    involvementPredicate('pedestrian_involved', filters.pedestrian),
    involvementPredicate('cycle_involved', filters.cycle),
    involvementPredicate('motorcycle_involved', filters.motorcycle),
  ].filter(Boolean);
  clauses.push(...involvement);
  if (bbox) {
    clauses.push('latitude >= ? AND latitude <= ?');
    params.push(bbox.south, bbox.north);
    if (bboxWidth(bbox) < 360) {
      if (bbox.east >= bbox.west) {
        clauses.push('longitude >= ? AND longitude <= ?');
        params.push(bbox.west, bbox.east);
      } else {
        clauses.push('(longitude >= ? OR longitude <= ?)');
        params.push(bbox.west, bbox.east);
      }
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
};

export const isDefaultFilters = (filters: QueryFilters): boolean => filters.years.length === 0 &&
  filters.authorities.length === 0 &&
  filters.country === undefined &&
  filters.severities.length === 0 &&
  filters.pedestrian === 'all' &&
  filters.cycle === 'all' &&
  filters.motorcycle === 'all';

const parseJsonObject = (value: string, fallback: Record<string, unknown> = {}): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : fallback;
  } catch {
    return fallback;
  }
};

const nullable = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integer = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const country = (value: unknown): Country | null => value === 'England' || value === 'Wales' ? value : null;
const severity = (value: unknown): Severity => value === 'fatal' || value === 'serious' || value === 'slight' ? value : 'unknown';
const triState = (value: unknown): boolean | null => value === null || value === undefined ? null : Boolean(value);

export const rowToCollision = (row: CollisionRow): CollisionRow => ({
  ...row,
  year: nullable(row.year),
  date: text(row.date),
  time: text(row.time),
  country: country(row.country),
  authority_code: text(row.authority_code),
  authority_name: text(row.authority_name),
  latitude: Number(row.latitude),
  longitude: Number(row.longitude),
  severity: severity(row.severity),
  casualty_count: nullable(row.casualty_count),
  fatalities: nullable(row.fatalities),
  serious_casualties: nullable(row.serious_casualties),
  slight_casualties: nullable(row.slight_casualties),
  ksi_casualties: nullable(row.ksi_casualties),
  pedestrian_involved: row.pedestrian_involved === null ? null : integer(row.pedestrian_involved),
  cycle_involved: row.cycle_involved === null ? null : integer(row.cycle_involved),
  motorcycle_involved: row.motorcycle_involved === null ? null : integer(row.motorcycle_involved),
  road_name: text(row.road_name),
  road_number: text(row.road_number),
  speed_limit: nullable(row.speed_limit),
  junction_detail: text(row.junction_detail),
  source_json: typeof row.source_json === 'string' ? row.source_json : '{}',
});

const countMetric = (value: number | null, unknownRecords: number): NullableCount => ({ value, unknownRecords });

const countsFromRow = (row: Record<string, unknown>): SummaryMetrics => {
  const collisions = integer(row.collisions);
  const casualtyUnknown = integer(row.casualty_unknown);
  const fatalitiesUnknown = integer(row.fatalities_unknown);
  const seriousUnknown = integer(row.serious_unknown);
  const slightUnknown = integer(row.slight_unknown);
  const ksiUnknown = integer(row.ksi_unknown);
  const nullableAggregate = (value: unknown, unknownRecords: number): number | null => {
    const parsed = nullable(value);
    // SQL SUM() is NULL for an empty result. An empty selection has no
    // unknown records, so expose zero; a non-empty all-unknown selection stays
    // null to preserve missingness.
    return parsed === null && collisions === 0 && unknownRecords === 0 ? 0 : parsed;
  };
  return {
    collisions,
    collisionSeverity: {
      fatal: integer(row.fatal_collisions),
      serious: integer(row.serious_collisions),
      slight: integer(row.slight_collisions),
      unknown: integer(row.unknown_collisions),
    },
    casualties: {
      total: countMetric(nullableAggregate(row.casualties, casualtyUnknown), casualtyUnknown),
      fatalities: countMetric(nullableAggregate(row.fatalities, fatalitiesUnknown), fatalitiesUnknown),
      serious: countMetric(nullableAggregate(row.serious_casualties, seriousUnknown), seriousUnknown),
      slight: countMetric(nullableAggregate(row.slight_casualties, slightUnknown), slightUnknown),
      ksi: countMetric(nullableAggregate(row.ksi_casualties, ksiUnknown), ksiUnknown),
    },
    ksiCollisions: integer(row.ksi_collisions),
    yearsRepresented: Array.isArray(row.years) ? row.years.filter((year): year is number => typeof year === 'number') : [],
    complete: row.complete !== false,
    sourceRows: nullable(row.source_rows) ?? undefined,
    mappableRows: nullable(row.mappable_rows) ?? undefined,
  };
};

export const summaryFromAggregateRow = (row: Record<string, unknown>): SummaryMetrics => countsFromRow(row);

export const summaryMetricSql = (predicate: QueryPredicate): { sql: string; params: Array<string | number | null> } => ({
  sql: `SELECT
      COUNT(*) AS collisions,
      COALESCE(SUM(CASE WHEN severity = 'fatal' THEN 1 ELSE 0 END), 0) AS fatal_collisions,
      COALESCE(SUM(CASE WHEN severity = 'serious' THEN 1 ELSE 0 END), 0) AS serious_collisions,
      COALESCE(SUM(CASE WHEN severity = 'slight' THEN 1 ELSE 0 END), 0) AS slight_collisions,
      COALESCE(SUM(CASE WHEN severity = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_collisions,
      SUM(casualty_count) AS casualties,
      COALESCE(SUM(CASE WHEN casualty_count IS NULL THEN 1 ELSE 0 END), 0) AS casualty_unknown,
      SUM(fatalities) AS fatalities,
      COALESCE(SUM(CASE WHEN fatalities IS NULL THEN 1 ELSE 0 END), 0) AS fatalities_unknown,
      SUM(serious_casualties) AS serious_casualties,
      COALESCE(SUM(CASE WHEN serious_casualties IS NULL THEN 1 ELSE 0 END), 0) AS serious_unknown,
      SUM(slight_casualties) AS slight_casualties,
      COALESCE(SUM(CASE WHEN slight_casualties IS NULL THEN 1 ELSE 0 END), 0) AS slight_unknown,
      SUM(ksi_casualties) AS ksi_casualties,
      COALESCE(SUM(CASE WHEN ksi_casualties IS NULL THEN 1 ELSE 0 END), 0) AS ksi_unknown,
      COALESCE(SUM(CASE WHEN ksi_casualties > 0 THEN 1 ELSE 0 END), 0) AS ksi_collisions
    FROM collisions ${predicate.sql}`,
  params: predicate.params,
});

export const summaryYearsSql = (predicate: QueryPredicate): { sql: string; params: Array<string | number | null> } => ({
  sql: `SELECT DISTINCT year FROM collisions ${predicate.sql ? `${predicate.sql} AND` : 'WHERE'} year IS NOT NULL ORDER BY year`,
  params: predicate.params,
});

const parseYearsJson = (value: string): number[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((year): year is number => typeof year === 'number' && Number.isInteger(year)).sort((a, b) => a - b) : [];
  } catch {
    return [];
  }
};

export const aggregateFeature = (row: AggregateRow, cellDegrees: number): GeoJsonFeature<AggregateProperties> => {
  const south = Math.max(-90, row.latitude_cell * cellDegrees - 90);
  const north = Math.min(90, south + cellDegrees);
  const west = Math.max(-180, row.longitude_cell * cellDegrees - 180);
  const east = Math.min(180, west + cellDegrees);
  const collisionSeverity: SeverityCounts = {
    fatal: integer(row.fatal_count),
    serious: integer(row.serious_count),
    slight: integer(row.slight_count),
    unknown: integer(row.unknown_count),
  };
  return {
    type: 'Feature',
    id: `cell-${cellDegrees}-${row.latitude_cell}-${row.longitude_cell}`,
    geometry: { type: 'Point', coordinates: [(west + east) / 2, (south + north) / 2] },
    properties: {
      kind: 'aggregate',
      count: integer(row.count),
      bbox: { west, south, east, north },
      collisionSeverity,
      casualties: countMetric(nullable(row.casualty_total), integer(row.casualty_unknown)),
      ksiCollisions: integer(row.ksi_collision_count),
      yearsRepresented: parseYearsJson(row.years_json),
    },
  };
};

export const pointFeature = (row: CollisionRow): GeoJsonFeature<PointProperties> => ({
  type: 'Feature',
  id: row.id,
  geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
  properties: {
    kind: 'collision',
    id: row.id,
    year: row.year,
    severity: row.severity,
    country: row.country,
    authorityCode: row.authority_code,
    authorityName: row.authority_name,
  },
});

const rowEvidence = (row: CollisionRow): Record<string, unknown> => parseJsonObject(row.source_json);

export const rowToDetail = (row: CollisionRow, datasetVersion: string, detailEvidence?: CollisionDetail['evidence']): CollisionDetail => {
  const source = rowEvidence(row);
  const casualtiesValue = source.casualties;
  const vehiclesValue = source.vehicles;
  const casualties = Array.isArray(casualtiesValue) ? casualtiesValue.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  const vehicles = Array.isArray(vehiclesValue) ? vehiclesValue.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  return {
    id: row.id,
    datasetVersion,
    year: row.year,
    date: row.date,
    time: row.time,
    latitude: row.latitude,
    longitude: row.longitude,
    country: row.country,
    authorityCode: row.authority_code,
    authorityName: row.authority_name,
    roadName: row.road_name,
    roadNumber: row.road_number,
    speedLimit: row.speed_limit,
    junctionDetail: row.junction_detail,
    severity: row.severity,
    casualtyCount: row.casualty_count,
    fatalities: row.fatalities,
    seriousCasualties: row.serious_casualties,
    slightCasualties: row.slight_casualties,
    ksiCasualties: row.ksi_casualties,
    pedestrianInvolved: triState(row.pedestrian_involved),
    cycleInvolved: triState(row.cycle_involved),
    motorcycleInvolved: triState(row.motorcycle_involved),
    evidence: detailEvidence ?? {
      collision: source,
      casualties,
      vehicles,
    },
  };
};

// Zoom only controls map presentation; it cannot change an exact summary.
export const isPrecomputedSummaryCompatible = (query: ParsedQuery): boolean => query.bbox === undefined;

export const summaryLookupKey = (filters: QueryFilters): string => JSON.stringify({
  years: [...filters.years].sort((a, b) => a - b),
  authorities: [...filters.authorities].sort(),
  country: filters.country ?? null,
  severities: [...filters.severities].sort(),
  pedestrian: filters.pedestrian,
  cycle: filters.cycle,
  motorcycle: filters.motorcycle,
});

export const casualtyFromMetrics = (metrics: SummaryMetrics): CasualtySeverityCounts => metrics.casualties;
