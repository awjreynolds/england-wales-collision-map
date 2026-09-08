import type {
  BBox,
  CollisionDetail,
  DatasetManifest,
  ParsedQuery,
  QueryFilters,
  SchoolRecord,
  SummaryMetrics,
  SchoolCoverageProvenance,
} from '../contract';
import {
  aggregateFeature,
  buildPredicate,
  COLLISION_COLUMNS,
  isPrecomputedSummaryCompatible,
  pointFeature,
  rowToCollision,
  rowToDetail,
  summaryLookupKey,
  summaryMetricSql,
  summaryFromAggregateRow,
  summaryYearsSql,
  type AggregateRow,
  type CollisionRow,
  type SchoolRow,
} from './db';

export type { CollisionRow } from './db';
export { isDefaultFilters } from './db';

export class DataUnavailableError extends Error {
  readonly code = 'data_unavailable';
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = 'DataUnavailableError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const numberOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const stringOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;
const integerOrZero = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;

const parseManifest = (value: unknown): DatasetManifest | null => {
  if (!isObject(value) || typeof value.datasetVersion !== 'string' || typeof value.schemaVersion !== 'string' || typeof value.title !== 'string') return null;
  if (value.scope !== 'England and Wales' || !Array.isArray(value.years) || !isObject(value.extent) || !isObject(value.source)) return null;
  const extent = value.extent;
  if (![extent.west, extent.south, extent.east, extent.north].every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
  const source = value.source;
  if (typeof source.publisher !== 'string' || typeof source.dataset !== 'string' || !Array.isArray(source.urls)) return null;
  return value as unknown as DatasetManifest;
};

export const readManifest = async (db: D1Database): Promise<DatasetManifest> => {
  const row = await db.prepare('SELECT value FROM dataset_metadata WHERE key = ?1').bind('manifest').first<{ value: string }>();
  if (!row) throw new DataUnavailableError('The national dataset manifest is not loaded.');
  try {
    const parsed: unknown = JSON.parse(row.value);
    const manifest = parseManifest(parsed);
    if (!manifest) throw new Error('invalid manifest');
    return manifest;
  } catch {
    throw new DataUnavailableError('The national dataset manifest is invalid.');
  }
};

export const readSchoolCoverageProvenance = async (db: D1Database): Promise<SchoolCoverageProvenance[]> => {
  const row = await db.prepare('SELECT value FROM dataset_metadata WHERE key = ?1').bind('school_provenance').first<{ value: string }>();
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed as SchoolCoverageProvenance[] : [];
  } catch {
    return [];
  }
};

const parsePrecomputedMetrics = (value: string): SummaryMetrics | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isObject(parsed) || !isObject(parsed.collisionSeverity) || !isObject(parsed.casualties)) return null;
    const collisionSeverity = parsed.collisionSeverity;
    const casualties = parsed.casualties;
    const nullableMetric = (candidate: unknown): { value: number | null; unknownRecords: number } | null => {
      if (!isObject(candidate)) return null;
      const metricValue = candidate.value === null ? null : numberOrNull(candidate.value);
      if (candidate.value !== null && metricValue === null) return null;
      return { value: metricValue, unknownRecords: integerOrZero(candidate.unknownRecords) };
    };
    const collision = {
      fatal: integerOrZero(collisionSeverity.fatal),
      serious: integerOrZero(collisionSeverity.serious),
      slight: integerOrZero(collisionSeverity.slight),
      unknown: integerOrZero(collisionSeverity.unknown),
    };
    const casualty = {
      total: nullableMetric(casualties.total),
      fatalities: nullableMetric(casualties.fatalities),
      serious: nullableMetric(casualties.serious),
      slight: nullableMetric(casualties.slight),
      ksi: nullableMetric(casualties.ksi),
    };
    if (Object.values(casualty).some((metric) => metric === null)) return null;
    const years = Array.isArray(parsed.yearsRepresented) ? parsed.yearsRepresented.filter((year): year is number => typeof year === 'number' && Number.isInteger(year)).sort((a, b) => a - b) : [];
    return {
      collisions: integerOrZero(parsed.collisions),
      collisionSeverity: collision,
      casualties: casualty as SummaryMetrics['casualties'],
      ksiCollisions: integerOrZero(parsed.ksiCollisions),
      yearsRepresented: years,
      complete: parsed.complete !== false,
      sourceRows: numberOrNull(parsed.sourceRows) ?? undefined,
      mappableRows: numberOrNull(parsed.mappableRows) ?? undefined,
    };
  } catch {
    return null;
  }
};

export const querySummary = async (db: D1Database, query: ParsedQuery, datasetVersion?: string): Promise<{ metrics: SummaryMetrics; precomputed: boolean }> => {
  if (isPrecomputedSummaryCompatible(query)) {
    const key = summaryLookupKey(query.filters);
    const precomputed = datasetVersion === undefined
      ? await db.prepare('SELECT metrics_json FROM precomputed_summaries WHERE key = ?1').bind(key).first<{ metrics_json: string }>()
      : await db.prepare('SELECT metrics_json FROM precomputed_summaries WHERE key = ?1 AND dataset_version = ?2').bind(key, datasetVersion).first<{ metrics_json: string }>();
    if (precomputed) {
      const metrics = parsePrecomputedMetrics(precomputed.metrics_json);
      if (metrics) return { metrics, precomputed: true };
    }
  }
  const predicate = buildPredicate(query.filters, query.bbox, datasetVersion);
  const metricSql = summaryMetricSql(predicate);
  const yearsSql = summaryYearsSql(predicate);
  const [metricResult, yearsResult] = await Promise.all([
    db.prepare(metricSql.sql).bind(...metricSql.params).first<Record<string, unknown>>(),
    db.prepare(yearsSql.sql).bind(...yearsSql.params).all<{ year: number | null }>(),
  ]);
  const metrics = summaryFromAggregateRow({ ...(metricResult ?? {}), years: yearsResult.results.map((row) => row.year).filter((year): year is number => typeof year === 'number') });
  return { metrics, precomputed: false };
};

export const countFilteredRecords = async (db: D1Database, filters: QueryFilters, bbox?: BBox, datasetVersion?: string): Promise<number> => {
  const predicate = buildPredicate(filters, bbox, datasetVersion);
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM collisions ${predicate.sql}`).bind(...predicate.params).first<{ count: number }>();
  return integerOrZero(row?.count);
};

export const queryCollisionRows = async (db: D1Database, filters: QueryFilters, bbox: BBox | undefined, limit: number, datasetVersion?: string): Promise<CollisionRow[]> => {
  const predicate = buildPredicate(filters, bbox, datasetVersion);
  const rows = await db.prepare(`SELECT ${COLLISION_COLUMNS} FROM collisions ${predicate.sql} ORDER BY id LIMIT ?`).bind(...predicate.params, limit).all<CollisionRow>();
  return rows.results.map(rowToCollision);
};

export const queryCollisionDetail = async (db: D1Database, id: string, datasetVersion: string, evidence?: CollisionDetail['evidence']): Promise<CollisionDetail | null> => {
  const row = await db.prepare(`SELECT ${COLLISION_COLUMNS} FROM collisions WHERE id = ?1 AND dataset_version = ?2 LIMIT 1`).bind(id, datasetVersion).first<CollisionRow>();
  return row ? rowToDetail(rowToCollision(row), datasetVersion, evidence) : null;
};

const bboxForPointRadius = (latitude: number, longitude: number, metres: number): BBox => {
  const latitudeDelta = metres / 111_320;
  const longitudeDelta = metres / (111_320 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  return {
    west: longitude - longitudeDelta,
    south: Math.max(-90, latitude - latitudeDelta),
    east: longitude + longitudeDelta,
    north: Math.min(90, latitude + latitudeDelta),
  };
};

const schoolPredicate = (bbox?: BBox, query?: string, country?: SchoolRecord['country']): { sql: string; params: Array<string | number> } => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (country) {
    clauses.push('country = ?');
    params.push(country);
  }
  if (bbox) {
    clauses.push('latitude >= ? AND latitude <= ?');
    params.push(bbox.south, bbox.north);
    const width = bbox.world === true ? 360 : bbox.east >= bbox.west ? bbox.east - bbox.west : bbox.east + 360 - bbox.west;
    if (width < 360) {
      if (bbox.east >= bbox.west) {
        clauses.push('longitude >= ? AND longitude <= ?');
        params.push(bbox.west, bbox.east);
      } else {
        clauses.push('(longitude >= ? OR longitude <= ?)');
        params.push(bbox.west, bbox.east);
      }
    }
  }
  if (query) {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    clauses.push("(name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
};

const schoolFromRow = (row: SchoolRow): SchoolRecord => ({
  id: row.id,
  name: row.name,
  country: row.country,
  latitude: Number(row.latitude),
  longitude: Number(row.longitude),
  status: stringOrNull(row.status),
  phase: stringOrNull(row.phase),
});

/**
 * Query the school catalogue within an optional map box and country scope.
 * Schools do not carry a source authority code, so authority filters are not
 * applied here; callers can use the collision authority filters separately.
 */
export const querySchools = async (db: D1Database, query: string | undefined, bbox: BBox | undefined, limit = 200, offset = 0, country?: SchoolRecord['country']): Promise<SchoolRecord[]> => {
  const predicate = schoolPredicate(bbox, query, country);
  const rows = await db.prepare(`SELECT id, name, country, latitude, longitude, status, phase, source_json FROM schools ${predicate.sql} ORDER BY name, id LIMIT ? OFFSET ?`).bind(...predicate.params, limit, offset).all<SchoolRow>();
  return rows.results.map(schoolFromRow);
};

export const querySchoolById = async (db: D1Database, id: string): Promise<SchoolRecord | null> => {
  const row = await db.prepare('SELECT id, name, country, latitude, longitude, status, phase, source_json FROM schools WHERE id = ?1 LIMIT 1').bind(id).first<SchoolRow>();
  return row ? schoolFromRow(row) : null;
};

export const querySchoolsNear = async (db: D1Database, latitude: number, longitude: number, metres: number): Promise<SchoolRecord[]> => {
  const rows = await querySchools(db, undefined, bboxForPointRadius(latitude, longitude, metres), 500);
  return rows;
};

const aggregateSql = (predicate: { sql: string; params: Array<string | number | null> }, cellDegrees: number): { sql: string; params: Array<string | number | null> } => ({
  sql: `SELECT
      CAST((latitude + 90.0) / ?1 AS INTEGER) AS latitude_cell,
      CAST((longitude + 180.0) / ?2 AS INTEGER) AS longitude_cell,
      COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN severity = 'fatal' THEN 1 ELSE 0 END), 0) AS fatal_count,
      COALESCE(SUM(CASE WHEN severity = 'serious' THEN 1 ELSE 0 END), 0) AS serious_count,
      COALESCE(SUM(CASE WHEN severity = 'slight' THEN 1 ELSE 0 END), 0) AS slight_count,
      COALESCE(SUM(CASE WHEN severity = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_count,
      SUM(casualty_count) AS casualty_total,
      COALESCE(SUM(CASE WHEN casualty_count IS NULL THEN 1 ELSE 0 END), 0) AS casualty_unknown,
      COALESCE(SUM(CASE WHEN ksi_casualties > 0 THEN 1 ELSE 0 END), 0) AS ksi_collision_count,
      json_group_array(DISTINCT year) AS years_json
    FROM collisions ${predicate.sql}
    GROUP BY 1, 2
    ORDER BY latitude_cell, longitude_cell`,
  params: [cellDegrees, cellDegrees, ...predicate.params],
});

export const queryDynamicAggregates = async (db: D1Database, filters: QueryFilters, bbox: BBox | undefined, cellDegrees: number, datasetVersion?: string): Promise<AggregateRow[]> => {
  const predicate = buildPredicate(filters, bbox, datasetVersion);
  const sql = aggregateSql(predicate, cellDegrees);
  const rows = await db.prepare(sql.sql).bind(...sql.params).all<AggregateRow>();
  return rows.results;
};

const cellRange = (value: number, offset: number, cellDegrees: number): number => Math.floor((value + offset) / cellDegrees);

export const queryPrecomputedAggregates = async (db: D1Database, datasetVersion: string, bbox: BBox, cellDegrees: number): Promise<AggregateRow[]> => {
  const southCell = cellRange(bbox.south, 90, cellDegrees);
  const northCell = cellRange(bbox.north, 90, cellDegrees);
  const params: Array<string | number> = [cellDegrees, datasetVersion, southCell, northCell];
  const width = bbox.world === true ? 360 : bbox.east >= bbox.west ? bbox.east - bbox.west : bbox.east + 360 - bbox.west;
  let longitudeClause = '';
  if (width < 360) {
    const westCell = cellRange(bbox.west, 180, cellDegrees);
    const eastCell = cellRange(bbox.east, 180, cellDegrees);
    if (bbox.east >= bbox.west) {
      longitudeClause = ' AND longitude_cell BETWEEN ? AND ?';
      params.push(westCell, eastCell);
    } else {
      longitudeClause = ' AND (longitude_cell >= ? OR longitude_cell <= ?)';
      params.push(westCell, eastCell);
    }
  }
  const result = await db.prepare(`SELECT latitude_cell, longitude_cell, count, fatal_count, serious_count, slight_count, unknown_count, casualty_total, casualty_unknown, ksi_collision_count, years_json FROM map_cells WHERE cell_level = ? AND dataset_version = ? AND latitude_cell BETWEEN ? AND ?${longitudeClause}`).bind(...params).all<AggregateRow>();
  return result.results;
};

export const aggregateFeatures = (rows: AggregateRow[], cellDegrees: number) => rows.map((row) => aggregateFeature(row, cellDegrees));
export const pointFeatures = (rows: CollisionRow[]) => rows.map(pointFeature);
export const bboxForAnalysisAnchor = bboxForPointRadius;
