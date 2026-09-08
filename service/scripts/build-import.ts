/**
 * Build compact D1 import SQL from the canonical national artifacts.
 *
 * Collision rows are reduced to the columns used by map/filter queries. Full
 * joined STATS19 evidence is gzip-compressed in 100-record chunks and indexed
 * by collision id for on-demand detail reads. The generated directory is
 * ignored data and can be uploaded to D1 with the files in manifest.json order.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_VIEW_FEATURES } from '../contract.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const DATASET_ALIAS_DIR = resolve(ROOT, 'data/national/2021-2025');
const OUTPUT_DIR = resolve(DATASET_ALIAS_DIR, 'service-import');
const IMPORTER_SOURCE = resolve(ROOT, 'service/scripts/build-import.ts');
const CONTRACT_SOURCE = resolve(ROOT, 'service/contract.ts');
const SQL_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SQL_STATEMENT_BYTES = 100_000;
export const SQL_STATEMENT_BATCH_BYTES = 90_000;
const DETAIL_CHUNK_ROWS = 100;
const CELL_LEVELS = [1, 2, 4] as const;
const NATIONAL_ARTIFACTS = ['summary.json', 'collisions.ndjson', 'details.ndjson', 'authority-lookup.json'] as const;

type Country = 'England' | 'Wales';
type CompactRow = {
  id?: unknown;
  year?: unknown;
  country?: unknown;
  authorityCode?: unknown;
  authorityName?: unknown;
  date?: unknown;
  time?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  severity?: unknown;
  roadName?: unknown;
  roadNumber?: unknown;
  speedLimit?: unknown;
  junctionDetail?: unknown;
  casualtyCount?: unknown;
  fatalities?: unknown;
  seriousCasualties?: unknown;
  slightCasualties?: unknown;
  ksiCasualties?: unknown;
  pedestrianInvolved?: unknown;
  cycleInvolved?: unknown;
  motorcycleInvolved?: unknown;
};

type Metric = Record<string, unknown> & {
  collisions?: number;
  fatalCollisions?: number;
  seriousCollisions?: number;
  slightCollisions?: number;
  unknownSeverity?: number;
  casualtyCount?: number;
  casualtyCountUnknown?: number;
  fatalities?: number;
  fatalitiesUnknown?: number;
  seriousCasualties?: number;
  seriousCasualtiesUnknown?: number;
  slightCasualties?: number;
  slightCasualtiesUnknown?: number;
  ksiCasualties?: number;
  ksiCasualtiesUnknown?: number;
};

type ArtifactSummary = {
  datasetVersion?: string;
  generatedAt?: string;
  includedYears?: number[];
  byYear?: Record<string, Metric>;
  byCountry?: Record<string, Metric>;
  byAuthority?: Record<string, Metric & { authorityCode?: string; authorityName?: string | null; country?: Country }>;
};

type Cell = {
  count: number;
  fatal: number;
  serious: number;
  slight: number;
  unknown: number;
  casualtyTotal: number;
  casualtyUnknown: number;
  ksiCollisions: number;
  years: Set<number>;
};

type NationalManifest = Record<string, unknown> & {
  datasetVersion?: unknown;
  artifactHashes?: unknown;
};

export type PinnedNationalGeneration = {
  directory: string;
  manifest: NationalManifest;
  summary: ArtifactSummary;
};

export type ServiceDatasetIdentity = {
  datasetVersion: string;
  nationalDatasetVersion: string;
  schoolOutputSha256: string;
  schoolProvenanceSha256: string;
  importerTransformSha256: string;
  contractSourceSha256: string;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberOrNull = (value: unknown): number | null => isFiniteNumber(value) ? value : null;
const integerOrNull = (value: unknown): number | null => numberOrNull(value) === null ? null : Math.trunc(value as number);
const textOrNull = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const countryOrNull = (value: unknown): Country | null => value === 'England' || value === 'Wales' ? value : null;
const severityOrUnknown = (value: unknown): 'fatal' | 'serious' | 'slight' | 'unknown' => value === 'fatal' || value === 'serious' || value === 'slight' ? value : 'unknown';
const bitOrNull = (value: unknown): number | null => typeof value === 'boolean' ? value ? 1 : 0 : null;

const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const base64 = (value: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < value.length; index += 1) binary += String.fromCharCode(value[index]);
  return btoa(binary);
};
const sqlValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return sqlText(String(value));
};

/** D1 bulk import rejects an individual SQL statement over 100,000 bytes. */
export const assertSqlStatementWithinLimit = (statement: string): void => {
  const bytes = Buffer.byteLength(statement, 'utf8');
  if (bytes > MAX_SQL_STATEMENT_BYTES) {
    throw new Error(`SQL statement exceeds D1 limit: ${bytes} bytes (maximum ${MAX_SQL_STATEMENT_BYTES})`);
  }
};

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

const hashFile = async (file: string): Promise<{ bytes: number; sha256: string }> => {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
};

const parseJsonFile = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;

/** Resolve one immutable national generation and verify it before parsing any artifact. */
export const pinNationalGeneration = async (aliasDir = DATASET_ALIAS_DIR): Promise<PinnedNationalGeneration> => {
  const directory = await realpath(resolve(aliasDir, 'current'));
  const manifest = await parseJsonFile<NationalManifest>(resolve(directory, 'manifest.json'));
  const nationalDatasetVersion = typeof manifest.datasetVersion === 'string' ? manifest.datasetVersion : '';
  if (!nationalDatasetVersion) throw new Error(`National manifest is missing datasetVersion: ${resolve(directory, 'manifest.json')}`);
  if (!manifest.artifactHashes || typeof manifest.artifactHashes !== 'object' || Array.isArray(manifest.artifactHashes)) {
    throw new Error(`National manifest is missing artifactHashes: ${resolve(directory, 'manifest.json')}`);
  }
  const artifactHashes = manifest.artifactHashes as Record<string, unknown>;
  for (const artifact of NATIONAL_ARTIFACTS) {
    const expected = artifactHashes[artifact];
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`National manifest has no valid hash for ${artifact}: ${resolve(directory, 'manifest.json')}`);
    }
    const actual = await hashFile(resolve(directory, artifact));
    if (actual.sha256 !== expected) {
      throw new Error(`National artifact hash mismatch for ${artifact}: expected ${expected}, got ${actual.sha256}`);
    }
  }
  const summary = await parseJsonFile<ArtifactSummary>(resolve(directory, 'summary.json'));
  if (summary.datasetVersion !== nationalDatasetVersion) {
    throw new Error(`National summary version does not match manifest: ${summary.datasetVersion ?? 'missing'} vs ${nationalDatasetVersion}`);
  }
  return { directory, manifest, summary };
};

export const deriveServiceDatasetIdentity = (input: {
  nationalDatasetVersion: string;
  schoolOutputSha256: string;
  schoolProvenanceSha256: string;
  importerTransformSha256: string;
  contractSourceSha256: string;
}): ServiceDatasetIdentity => {
  if (!input.nationalDatasetVersion || !/^[a-zA-Z0-9._-]+$/.test(input.nationalDatasetVersion)) throw new Error('Invalid national dataset version.');
  for (const [label, value] of [
    ['school output', input.schoolOutputSha256],
    ['school provenance', input.schoolProvenanceSha256],
    ['importer transform', input.importerTransformSha256],
    ['contract source', input.contractSourceSha256],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label} SHA-256.`);
  }
  return {
    datasetVersion: `service-${input.nationalDatasetVersion}-schools-${input.schoolOutputSha256.slice(0, 16)}-provenance-${input.schoolProvenanceSha256.slice(0, 16)}-importer-${input.importerTransformSha256.slice(0, 16)}-contract-${input.contractSourceSha256.slice(0, 16)}`,
    nationalDatasetVersion: input.nationalDatasetVersion,
    schoolOutputSha256: input.schoolOutputSha256,
    schoolProvenanceSha256: input.schoolProvenanceSha256,
    importerTransformSha256: input.importerTransformSha256,
    contractSourceSha256: input.contractSourceSha256,
  };
};

async function* readJsonLines<T>(file: string): AsyncGenerator<T> {
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim()) yield JSON.parse(line) as T;
  }
}

export type SqlInsertParts = { prefix: string; tuple: string };

type PendingInsert = {
  prefix: string;
  suffix: string;
  tuples: string[];
};

export class SqlWriter {
  private part = 0;
  private statements: string[] = [];
  private bytes = 0;
  private pendingInsert: PendingInsert | null = null;
  readonly files: string[] = [];

  constructor(private readonly prefix: string, private readonly outputDir = OUTPUT_DIR) {}

  async add(statement: string): Promise<void> {
    await this.flushPendingInsert();
    await this.queueStatement(statement);
  }

  async addValues(insertPrefix: string, tuple: string, suffix = ';'): Promise<void> {
    const singleStatement = `${insertPrefix}${tuple}${suffix}`;
    assertSqlStatementWithinLimit(singleStatement);
    const pending = this.pendingInsert;
    if (!pending || pending.prefix !== insertPrefix || pending.suffix !== suffix) {
      await this.flushPendingInsert();
      this.pendingInsert = { prefix: insertPrefix, suffix, tuples: [tuple] };
      return;
    }
    const candidate = `${insertPrefix}${[...pending.tuples, tuple].join(', ')}${suffix}`;
    if (Buffer.byteLength(candidate, 'utf8') > SQL_STATEMENT_BATCH_BYTES) {
      await this.flushPendingInsert();
      this.pendingInsert = { prefix: insertPrefix, suffix, tuples: [tuple] };
      return;
    }
    pending.tuples.push(tuple);
  }

  private async queueStatement(statement: string): Promise<void> {
    assertSqlStatementWithinLimit(statement);
    const nextBytes = this.bytes + Buffer.byteLength(statement) + 1;
    if (this.statements.length && nextBytes > SQL_FILE_BYTES) await this.flushStatements();
    this.statements.push(statement);
    this.bytes += Buffer.byteLength(statement) + 1;
  }

  private async flushPendingInsert(): Promise<void> {
    if (!this.pendingInsert) return;
    const { prefix, suffix, tuples } = this.pendingInsert;
    this.pendingInsert = null;
    await this.queueStatement(`${prefix}${tuples.join(', ')}${suffix}`);
  }

  private async flushStatements(): Promise<void> {
    if (!this.statements.length) return;
    const name = `${this.prefix}-${String(this.part).padStart(5, '0')}.sql`;
    const file = resolve(this.outputDir, name);
    // Wrangler's D1 bulk import endpoint manages its own transaction and
    // rejects explicit BEGIN/COMMIT statements in uploaded SQL files.
    const content = `${this.statements.join('\n')}\n`;
    await writeFile(file, content, 'utf8');
    this.files.push(name);
    this.part += 1;
    this.statements = [];
    this.bytes = 0;
  }

  async flush(): Promise<void> {
    await this.flushPendingInsert();
    await this.flushStatements();
  }

  async finish(): Promise<void> { await this.flush(); }
}

const metricNumber = (metric: Metric | undefined, key: string): number => {
  const value = metric?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
};

const sumMetric = (left: Metric, right: Metric): Metric => {
  const output: Metric = { ...left };
  for (const key of [
    'collisions', 'fatalCollisions', 'seriousCollisions', 'slightCollisions', 'unknownSeverity',
    'casualtyCount', 'casualtyCountUnknown', 'fatalities', 'fatalitiesUnknown',
    'seriousCasualties', 'seriousCasualtiesUnknown', 'slightCasualties', 'slightCasualtiesUnknown',
    'ksiCasualties', 'ksiCasualtiesUnknown',
  ]) output[key] = metricNumber(left, key) + metricNumber(right, key);
  return output;
};

const zeroMetric = (): Metric => ({
  collisions: 0, fatalCollisions: 0, seriousCollisions: 0, slightCollisions: 0, unknownSeverity: 0,
  casualtyCount: 0, casualtyCountUnknown: 0, fatalities: 0, fatalitiesUnknown: 0,
  seriousCasualties: 0, seriousCasualtiesUnknown: 0, slightCasualties: 0, slightCasualtiesUnknown: 0,
  ksiCasualties: 0, ksiCasualtiesUnknown: 0,
});

const nullableMetric = (value: number, unknownRecords: number, collisions: number): { value: number | null; unknownRecords: number } => ({
  value: unknownRecords >= collisions && collisions > 0 ? null : value,
  unknownRecords,
});

const contractMetrics = (metric: Metric, yearsRepresented: number[], ksiCollisions: number) => ({
  collisions: metricNumber(metric, 'collisions'),
  collisionSeverity: {
    fatal: metricNumber(metric, 'fatalCollisions'),
    serious: metricNumber(metric, 'seriousCollisions'),
    slight: metricNumber(metric, 'slightCollisions'),
    unknown: metricNumber(metric, 'unknownSeverity'),
  },
  casualties: {
    total: nullableMetric(metricNumber(metric, 'casualtyCount'), metricNumber(metric, 'casualtyCountUnknown'), metricNumber(metric, 'collisions')),
    fatalities: nullableMetric(metricNumber(metric, 'fatalities'), metricNumber(metric, 'fatalitiesUnknown'), metricNumber(metric, 'collisions')),
    serious: nullableMetric(metricNumber(metric, 'seriousCasualties'), metricNumber(metric, 'seriousCasualtiesUnknown'), metricNumber(metric, 'collisions')),
    slight: nullableMetric(metricNumber(metric, 'slightCasualties'), metricNumber(metric, 'slightCasualtiesUnknown'), metricNumber(metric, 'collisions')),
    ksi: nullableMetric(metricNumber(metric, 'ksiCasualties'), metricNumber(metric, 'ksiCasualtiesUnknown'), metricNumber(metric, 'collisions')),
  },
  ksiCollisions,
  yearsRepresented,
  complete: true,
  sourceRows: metricNumber(metric, 'collisions'),
  mappableRows: metricNumber(metric, 'collisions'),
});

const cellFor = (level: number, latitude: number, longitude: number): [number, number] => [
  Math.floor((latitude + 90) / level),
  Math.floor((longitude + 180) / level),
];

const addCell = (cells: Map<string, Cell>, row: CompactRow, level: number): void => {
  const latitude = numberOrNull(row.latitude);
  const longitude = numberOrNull(row.longitude);
  if (latitude === null || longitude === null) return;
  const [latitudeCell, longitudeCell] = cellFor(level, latitude, longitude);
  const key = `${latitudeCell}:${longitudeCell}`;
  const existing = cells.get(key) ?? { count: 0, fatal: 0, serious: 0, slight: 0, unknown: 0, casualtyTotal: 0, casualtyUnknown: 0, ksiCollisions: 0, years: new Set<number>() };
  existing.count += 1;
  const severity = severityOrUnknown(row.severity);
  existing[severity] += 1;
  const casualtyCount = numberOrNull(row.casualtyCount);
  if (casualtyCount === null) existing.casualtyUnknown += 1;
  else existing.casualtyTotal += casualtyCount;
  if (numberOrNull(row.ksiCasualties) !== null && (numberOrNull(row.ksiCasualties) as number) > 0) existing.ksiCollisions += 1;
  const year = integerOrNull(row.year);
  if (year !== null) existing.years.add(year);
  cells.set(key, existing);
};

const cellInsert = (level: number, key: string, datasetVersion: string, cell: Cell): SqlInsertParts => {
  const [latitudeCell, longitudeCell] = key.split(':').map(Number);
  return {
    prefix: 'INSERT OR REPLACE INTO map_cells (cell_level, latitude_cell, longitude_cell, dataset_version, count, fatal_count, serious_count, slight_count, unknown_count, casualty_total, casualty_unknown, ksi_collision_count, years_json) VALUES ',
    tuple: `(${level}, ${latitudeCell}, ${longitudeCell}, ${sqlText(datasetVersion)}, ${cell.count}, ${cell.fatal}, ${cell.serious}, ${cell.slight}, ${cell.unknown}, ${cell.casualtyUnknown === cell.count ? 'NULL' : cell.casualtyTotal}, ${cell.casualtyUnknown}, ${cell.ksiCollisions}, ${sqlText(JSON.stringify([...cell.years].sort((a, b) => a - b)))})`,
  };
};

const collisionInsert = (row: CompactRow, datasetVersion: string): SqlInsertParts | null => {
  const id = textOrNull(row.id);
  const latitude = numberOrNull(row.latitude);
  const longitude = numberOrNull(row.longitude);
  if (!id || latitude === null || longitude === null) return null;
  const [latitudeCell, longitudeCell] = cellFor(1, latitude, longitude);
  const values = [
    id, datasetVersion, integerOrNull(row.year), textOrNull(row.date), textOrNull(row.time), countryOrNull(row.country),
    textOrNull(row.authorityCode), textOrNull(row.authorityName), latitude, longitude, latitudeCell, longitudeCell,
    severityOrUnknown(row.severity), integerOrNull(row.casualtyCount), integerOrNull(row.fatalities), integerOrNull(row.seriousCasualties), integerOrNull(row.slightCasualties), integerOrNull(row.ksiCasualties),
    bitOrNull(row.pedestrianInvolved), bitOrNull(row.cycleInvolved), bitOrNull(row.motorcycleInvolved), textOrNull(row.roadName), textOrNull(row.roadNumber), integerOrNull(row.speedLimit), textOrNull(row.junctionDetail), '{}',
  ];
  return {
    prefix: 'INSERT OR REPLACE INTO collisions (id, dataset_version, year, date, time, country, authority_code, authority_name, latitude, longitude, latitude_cell, longitude_cell, severity, casualty_count, fatalities, serious_casualties, slight_casualties, ksi_casualties, pedestrian_involved, cycle_involved, motorcycle_involved, road_name, road_number, speed_limit, junction_detail, source_json) VALUES ',
    tuple: `(${values.map(sqlValue).join(', ')})`,
  };
};

const schoolInsert = (row: Record<string, unknown>): SqlInsertParts | null => {
  const id = textOrNull(row.id);
  const name = textOrNull(row.name);
  const country = countryOrNull(row.country);
  const latitude = numberOrNull(row.lat ?? row.latitude);
  const longitude = numberOrNull(row.lon ?? row.longitude);
  if (!id || !name || !country || latitude === null || longitude === null) return null;
  return {
    prefix: 'INSERT OR REPLACE INTO schools (id, name, country, latitude, longitude, status, phase, source_json) VALUES ',
    tuple: `(${[id, name, country, latitude, longitude, textOrNull(row.status), textOrNull(row.phase), JSON.stringify(row.source ?? {})].map(sqlValue).join(', ')})`,
  };
};

const keyForMetric = (filters: { years?: number[]; authorities?: string[]; country?: Country }): string => JSON.stringify({
  years: [...(filters.years ?? [])].sort((left, right) => left - right),
  authorities: [...(filters.authorities ?? [])].sort(),
  country: filters.country ?? null,
  severities: [],
  pedestrian: 'all',
  cycle: 'all',
  motorcycle: 'all',
});

const main = async (): Promise<void> => {
  const national = await pinNationalGeneration();
  const datasetDir = national.directory;
  const manifest = national.manifest;
  const summary = national.summary;
  const nationalDatasetVersion = String(manifest.datasetVersion);
  const schoolsFile = resolve(ROOT, 'data/schools/schools.json');
  const provenancePath = resolve(ROOT, 'data/schools/provenance.json');
  let schoolText: string;
  let schoolProvenanceText = '[]\n';
  let schoolRows: Array<Record<string, unknown>> = [];
  try {
    schoolText = await readFile(schoolsFile, 'utf8');
    const parsed = JSON.parse(schoolText) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`School catalogue is not an array: ${schoolsFile}`);
    schoolRows = parsed as Array<Record<string, unknown>>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    schoolText = '[]\n';
  }
  try {
    schoolProvenanceText = await readFile(provenancePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const schoolOutputSha256 = sha256(schoolText);
  const schoolProvenanceSha256 = sha256(schoolProvenanceText);
  const importerTransformSha256 = (await hashFile(IMPORTER_SOURCE)).sha256;
  const contractSourceSha256 = (await hashFile(CONTRACT_SOURCE)).sha256;
  const identity = deriveServiceDatasetIdentity({ nationalDatasetVersion, schoolOutputSha256, schoolProvenanceSha256, importerTransformSha256, contractSourceSha256 });
  const datasetVersion = identity.datasetVersion;
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const preflightFile = '00-preflight.sql';
  // The first statement atomically inserts a guard only when every data table
  // is empty. A second import therefore aborts on the NOT NULL constraint
  // instead of deleting or mixing records in an active database.
  const preflightStatement = `INSERT INTO dataset_metadata (key, value) SELECT CASE WHEN EXISTS (SELECT 1 FROM dataset_metadata) OR EXISTS (SELECT 1 FROM collisions) OR EXISTS (SELECT 1 FROM detail_chunks) OR EXISTS (SELECT 1 FROM detail_lookup) OR EXISTS (SELECT 1 FROM map_cells) OR EXISTS (SELECT 1 FROM precomputed_summaries) OR EXISTS (SELECT 1 FROM schools) THEN NULL ELSE '__import_guard__' END, ${sqlText(datasetVersion)};`;
  assertSqlStatementWithinLimit(preflightStatement);
  await writeFile(resolve(OUTPUT_DIR, preflightFile), `${preflightStatement}\n`, 'utf8');
  const collisionWriter = new SqlWriter('10-collisions');
  const cellWriters = new SqlWriter('20-map-cells');
  const cells = new Map<number, Map<string, Cell>>(CELL_LEVELS.map((level) => [level, new Map()]));
  const collisionIds = new Set<string>();
  const ksiByYear = new Map<number, number>();
  const ksiByCountry = new Map<Country, number>();
  const ksiByAuthority = new Map<string, number>();
  const authorityExtents = new Map<string, { west: number; south: number; east: number; north: number }>();
  let defaultKsi = 0;
  let collisionCount = 0;
  let minLat = 90; let maxLat = -90; let minLon = 180; let maxLon = -180;
  for await (const row of readJsonLines<CompactRow>(resolve(datasetDir, 'collisions.ndjson'))) {
    const statement = collisionInsert(row, datasetVersion);
    if (!statement) continue;
    await collisionWriter.addValues(statement.prefix, statement.tuple);
    collisionIds.add(String(row.id));
    collisionCount += 1;
    const latitude = numberOrNull(row.latitude) as number;
    const longitude = numberOrNull(row.longitude) as number;
    minLat = Math.min(minLat, latitude); maxLat = Math.max(maxLat, latitude); minLon = Math.min(minLon, longitude); maxLon = Math.max(maxLon, longitude);
    const authorityCode = textOrNull(row.authorityCode);
    if (authorityCode) {
      const extent = authorityExtents.get(authorityCode) ?? { west: longitude, south: latitude, east: longitude, north: latitude };
      extent.west = Math.min(extent.west, longitude); extent.south = Math.min(extent.south, latitude);
      extent.east = Math.max(extent.east, longitude); extent.north = Math.max(extent.north, latitude);
      authorityExtents.set(authorityCode, extent);
    }
    for (const level of CELL_LEVELS) addCell(cells.get(level) as Map<string, Cell>, row, level);
    const ksi = numberOrNull(row.ksiCasualties);
    if (ksi !== null && ksi > 0) {
      defaultKsi += 1;
      const year = integerOrNull(row.year); if (year !== null) ksiByYear.set(year, (ksiByYear.get(year) ?? 0) + 1);
      const country = countryOrNull(row.country); if (country) ksiByCountry.set(country, (ksiByCountry.get(country) ?? 0) + 1);
      const authority = textOrNull(row.authorityCode); if (authority) ksiByAuthority.set(authority, (ksiByAuthority.get(authority) ?? 0) + 1);
    }
  }
  await collisionWriter.finish();
  for (const level of CELL_LEVELS) {
    for (const [key, cell] of (cells.get(level) as Map<string, Cell>)) {
      const statement = cellInsert(level, key, datasetVersion, cell);
      await cellWriters.addValues(statement.prefix, statement.tuple);
    }
  }
  await cellWriters.finish();

  const detailsWriter = new SqlWriter('30-detail-chunks');
  const lookupWriter = new SqlWriter('31-detail-lookup');
  let detailRows = 0;
  let chunkIndex = 0;
  let detailLines: string[] = [];
  const detailIds = new Set<string>();
  const flushDetails = async (): Promise<void> => {
    if (!detailLines.length) return;
    const chunkId = `details-${String(chunkIndex).padStart(6, '0')}`;
    const payloadBase64 = base64(gzipSync(Buffer.from(`${detailLines.join('\n')}\n`, 'utf8')) as Uint8Array);
    await detailsWriter.addValues(
      'INSERT OR REPLACE INTO detail_chunks (chunk_id, dataset_version, row_count, payload_base64) VALUES ',
      `(${sqlText(chunkId)}, ${sqlText(datasetVersion)}, ${detailLines.length}, ${sqlText(payloadBase64)})`,
    );
    for (const line of detailLines) {
      const id = textOrNull((JSON.parse(line) as Record<string, unknown>).id);
      if (id && !detailIds.has(id)) {
        detailIds.add(id);
        await lookupWriter.addValues(
          'INSERT OR REPLACE INTO detail_lookup (collision_id, chunk_id) VALUES ',
          `(${sqlText(id)}, ${sqlText(chunkId)})`,
        );
      }
    }
    detailLines = [];
    chunkIndex += 1;
  };
  for await (const detail of readJsonLines<Record<string, unknown>>(resolve(datasetDir, 'details.ndjson'))) {
    detailLines.push(JSON.stringify(detail)); detailRows += 1;
    if (detailLines.length >= DETAIL_CHUNK_ROWS) await flushDetails();
  }
  await flushDetails();
  await detailsWriter.finish(); await lookupWriter.finish();
  const missingDetails = [...collisionIds].filter((id) => !detailIds.has(id));
  if (missingDetails.length) throw new Error(`Detail artifact is missing ${missingDetails.length} compact collision ids; first missing id: ${missingDetails[0]}`);

  const schoolWriter = new SqlWriter('40-schools');
  let schoolCount = 0;
  const schoolCounts: Record<Country, { coordinates: number; status: number; phase: number }> = { England: { coordinates: 0, status: 0, phase: 0 }, Wales: { coordinates: 0, status: 0, phase: 0 } };
  for (const row of schoolRows) {
    const statement = schoolInsert(row);
    const country = countryOrNull(row.country);
    if (statement && country) {
      await schoolWriter.addValues(statement.prefix, statement.tuple);
      schoolCount += 1;
      schoolCounts[country].coordinates += 1;
      if (textOrNull(row.status)) schoolCounts[country].status += 1;
      if (textOrNull(row.phase)) schoolCounts[country].phase += 1;
    }
  }
  await schoolWriter.finish();

  const years = Array.isArray(manifest.includedYears) ? manifest.includedYears.filter((year): year is number => typeof year === 'number') : [];
  const byYear = summary.byYear ?? {};
  const byCountry = summary.byCountry ?? {};
  const byAuthority = summary.byAuthority ?? {};
  const overall = Object.values(byYear).reduce((total, metric) => sumMetric(total, metric), zeroMetric());
  const precomputed: Array<{ key: string; filters: Record<string, unknown>; metrics: unknown }> = [];
  precomputed.push({ key: keyForMetric({}), filters: {}, metrics: contractMetrics(overall, years, defaultKsi) });
  for (const year of years) precomputed.push({ key: keyForMetric({ years: [year] }), filters: { years: [year] }, metrics: contractMetrics(byYear[String(year)] ?? zeroMetric(), [year], ksiByYear.get(year) ?? 0) });
  for (const country of ['England', 'Wales'] as const) precomputed.push({ key: keyForMetric({ country }), filters: { country }, metrics: contractMetrics(byCountry[country] ?? zeroMetric(), years, ksiByCountry.get(country) ?? 0) });
  for (const [code, metric] of Object.entries(byAuthority)) precomputed.push({ key: keyForMetric({ authorities: [code] }), filters: { authorities: [code] }, metrics: contractMetrics(metric, years, ksiByAuthority.get(code) ?? 0) });
  const summaryWriter = new SqlWriter('50-summaries');
  for (const item of precomputed) {
    await summaryWriter.addValues(
      'INSERT OR REPLACE INTO precomputed_summaries (key, dataset_version, filters_json, metrics_json) VALUES ',
      `(${sqlText(item.key)}, ${sqlText(datasetVersion)}, ${sqlText(JSON.stringify(item.filters))}, ${sqlText(JSON.stringify(item.metrics))})`,
    );
  }
  await summaryWriter.finish();

  let schoolCoverage: unknown[] = [];
  try {
    const provenance = JSON.parse(schoolProvenanceText) as Record<string, unknown>;
    const sources = Array.isArray(provenance.sources) ? provenance.sources as Array<Record<string, unknown>> : [];
    const counts = provenance.counts && typeof provenance.counts === 'object' ? provenance.counts as Record<string, unknown> : {};
    const englandCounts = counts.england && typeof counts.england === 'object' ? counts.england as Record<string, unknown> : {};
    const welshCounts = counts.walesMaintained && typeof counts.walesMaintained === 'object' ? counts.walesMaintained as Record<string, unknown> : {};
    const source = (name: string): Record<string, unknown> => sources.find((item) => String(item.name ?? '').includes(name)) ?? {};
    schoolCoverage = [
      { country: 'England', publisher: 'Department for Education', dataset: 'Get Information about Schools', sourceUrl: source('GIAS').url, retrievedAt: source('GIAS').retrievedAt, totalRows: metricNumber(englandCounts as Metric, 'sourceRows'), coordinateRows: schoolCounts.England.coordinates, statusKnownRows: schoolCounts.England.status, phaseKnownRows: schoolCounts.England.phase },
      { country: 'Wales', publisher: 'Welsh Government', dataset: 'DataMapWales maintained schools and pupil referral units', sourceUrl: source('DataMapWales').url, retrievedAt: source('DataMapWales').retrievedAt, totalRows: metricNumber(welshCounts as Metric, 'sourceRows') + metricNumber((counts.walesPru as Metric | undefined), 'sourceRows'), coordinateRows: schoolCounts.Wales.coordinates, statusKnownRows: schoolCounts.Wales.status, phaseKnownRows: schoolCounts.Wales.phase },
    ];
  } catch { schoolCoverage = []; }

  const sourceUrls = [manifest.sourceUrl, manifest.codebookUrl].filter((value): value is string => typeof value === 'string');
  const authorities = manifest.authorityLookup && typeof manifest.authorityLookup === 'object' ? (manifest.authorityLookup as Record<string, unknown>).authorities : undefined;
  const authorityDescriptors = authorities && typeof authorities === 'object' ? Object.entries(authorities as Record<string, unknown>).map(([code, name]) => ({ code, name: String(name), country: code.startsWith('W') ? 'Wales' : 'England', ...(authorityExtents.has(code) ? { bbox: authorityExtents.get(code) } : {}) })) : [];
  const datasetManifest = {
    datasetVersion,
    nationalDatasetVersion,
    schoolOutputSha256,
    schoolProvenanceSha256,
    importerTransformSha256,
    contractSourceSha256,
    schemaVersion: 'national.v1',
    title: 'England and Wales road collisions, 2021–2025',
    scope: 'England and Wales',
    years,
    extent: { west: minLon, south: minLat, east: maxLon, north: maxLat },
    authorities: authorityDescriptors,
    collisionCount,
    casualtyCount: metricNumber(overall, 'casualtyCount'),
    source: { publisher: 'Department for Transport', dataset: 'STATS19 road safety open data', urls: sourceUrls, licence: String(manifest.licence ?? ''), licenceUrl: String(manifest.licenceUrl ?? '') },
    generatedAt: String(manifest.generatedAt ?? summary.generatedAt ?? new Date().toISOString()),
    qualityNotices: [
      { id: 'reported-collisions', title: 'Reported personal-injury collisions', text: 'STATS19 records reported personal-injury collisions on public roads; it is not a census of every road incident.' },
      { id: 'coordinate-scope', title: 'Mappable collision scope', text: 'Collisions without valid England or Wales coordinates remain in the source detail artifact and are excluded from map queries.' },
      { id: 'detail-storage', title: 'On-demand source evidence', text: 'Joined collision, casualty and vehicle evidence is gzip-compressed in separate chunks and loaded only for a collision detail request.' },
    ],
    limits: { viewFeatureLimit: MAX_VIEW_FEATURES, viewResponseBytes: 1_000_000, analysisRecordLimit: 10_000, analysisRequiresBbox: true },
  };
  const metadataWriter = new SqlWriter('60-metadata');
  await metadataWriter.add(`INSERT OR REPLACE INTO dataset_metadata (key, value) VALUES ('manifest', ${sqlText(JSON.stringify(datasetManifest))});`);
  // The service only reads the normalized manifest and school provenance.
  // Keeping the large national summary out of D1 avoids duplicating the
  // source artifact and, more importantly, keeps each import statement under
  // D1's 100,000-byte statement limit.
  await metadataWriter.addValues(
    'INSERT OR REPLACE INTO dataset_metadata (key, value) VALUES ',
    `('school_provenance', ${sqlText(JSON.stringify(schoolCoverage))})`,
  );
  await metadataWriter.finish();

  const allFiles = [preflightFile, ...collisionWriter.files, ...cellWriters.files, ...detailsWriter.files, ...lookupWriter.files, ...schoolWriter.files, ...summaryWriter.files, ...metadataWriter.files];
  const sizes = Object.fromEntries(await Promise.all(allFiles.map(async (file) => [file, (await stat(resolve(OUTPUT_DIR, file))).size])));
  await writeFile(resolve(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), datasetVersion, nationalDatasetVersion, schoolOutputSha256, schoolProvenanceSha256, importerTransformSha256, contractSourceSha256, requiresFreshDatabase: true, collisionCount, detailRows, detailChunks: chunkIndex, schoolCount, detailCoverageValidated: missingDetails.length === 0, compressedDetailBytes: sizes ? Object.entries(sizes).filter(([file]) => file.startsWith('30-detail')).reduce((total, [, size]) => total + Number(size), 0) : 0, files: allFiles, sizes }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output: OUTPUT_DIR, datasetVersion, nationalDatasetVersion, schoolOutputSha256, schoolProvenanceSha256, importerTransformSha256, contractSourceSha256, collisionCount, detailRows, detailChunks: chunkIndex, schoolCount, files: allFiles.length }, null, 2));
};

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
