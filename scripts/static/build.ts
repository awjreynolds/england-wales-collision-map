/**
 * Publish the national dataset as static GitHub Pages assets.
 *
 * The source generation contains 2+ GB of detail NDJSON. This builder never
 * loads that artifact into memory: compact records are written to cell
 * scratch files, evidence is written to deterministic SHA-256 buckets, and
 * each scratch file is then streamed into a gzip-compressed JSON array.
 *
 * Run with: npm exec tsx scripts/static/build.ts
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  STATIC_CELL_SIZE_DEGREES,
  STATIC_EVIDENCE_BUCKET_COUNT,
  STATIC_SCHEMA_VERSION,
  staticCellBounds,
  staticCellKey,
  staticEvidenceBucket,
  staticFacetKey,
  type StaticAdditiveSummaryMetrics,
  type StaticArtifact,
  type StaticCellFacet,
  type StaticCellOverview,
  type StaticCollisionEvidence,
  type StaticCollisionRecord,
  type StaticManifest,
  type StaticOverview,
  type StaticSchoolCatalogue,
} from '../../src/static/contract.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const NATIONAL_ALIAS_DIR = resolve(ROOT, 'data/national/2021-2025');
const SERVICE_IMPORT_MANIFEST = resolve(NATIONAL_ALIAS_DIR, 'service-import/manifest.json');
const SCHOOL_OUTPUT = resolve(ROOT, 'data/schools/schools.json');
const SCHOOL_PROVENANCE = resolve(ROOT, 'data/schools/provenance.json');
const OUTPUT_DIR = resolve(ROOT, 'public/data/national');
const MAX_PUBLISHED_FILE_BYTES = 100 * 1_000_000;
const MAX_PUBLISHED_TOTAL_BYTES = 1_000_000_000;
const TILE_WRITER_LIMIT = 64;
const EVIDENCE_WRITER_LIMIT = 64;
const NATIONAL_ARTIFACTS = ['summary.json', 'collisions.ndjson', 'details.ndjson', 'authority-lookup.json'] as const;
const REQUIRED_YEARS = [2021, 2022, 2023, 2024, 2025] as const;
const REQUIRED_COLLISION_COUNT = 493_218;

type JsonRecord = Record<string, unknown>;
type Country = 'England' | 'Wales';
type Severity = 'fatal' | 'serious' | 'slight' | 'unknown';

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

type DetailRow = {
  id?: unknown;
  mappable?: unknown;
  year?: unknown;
  country?: unknown;
  authorityCode?: unknown;
  authorityName?: unknown;
  coordinate?: { latitude?: unknown; longitude?: unknown } | null;
  raw?: {
    collision?: JsonRecord;
    casualties?: JsonRecord[];
    vehicles?: JsonRecord[];
  };
  join?: JsonRecord;
};

type NationalManifest = JsonRecord & {
  datasetVersion?: unknown;
  generatedAt?: unknown;
  includedYears?: unknown;
  source?: unknown;
  sourceUrl?: unknown;
  codebookUrl?: unknown;
  licence?: unknown;
  licenceUrl?: unknown;
  authorityLookup?: unknown;
  artifactHashes?: unknown;
  sourceFiles?: unknown;
  counts?: unknown;
  limitations?: unknown;
};

type ServiceImportManifest = JsonRecord & {
  datasetVersion?: unknown;
  nationalDatasetVersion?: unknown;
  collisionCount?: unknown;
  detailRows?: unknown;
  schoolCount?: unknown;
};

type CellAccumulator = {
  recordCount: number;
  facets: Map<string, StaticCellFacet>;
};

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const numberOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integerOrNull = (value: unknown): number | null => {
  const number = numberOrNull(value);
  return number === null ? null : Math.trunc(number);
};
const stringOrNull = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const countryOrNull = (value: unknown): Country | null => value === 'England' || value === 'Wales' ? value : null;
const severityOrUnknown = (value: unknown): Severity => value === 'fatal' || value === 'serious' || value === 'slight' ? value : 'unknown';
const boolOrNull = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;

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

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;

const readJsonLines = async function* <T>(file: string): AsyncGenerator<T> {
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of input) if (line.trim()) yield JSON.parse(line) as T;
};

const writeChunk = async (stream: Writable, chunk: string): Promise<void> => {
  if (!stream.write(chunk)) await once(stream, 'drain');
};

const finishWritable = async (stream: Writable): Promise<void> => {
  const finished = once(stream, 'finish');
  stream.end();
  await finished;
};

/** Reopens at most 64 append streams at once, keeping descriptor use bounded. */
class LruNdjsonWriters {
  private readonly entries = new Map<string, { stream: Writable; lastUsed: number }>();
  private clock = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async append(file: string, value: unknown): Promise<void> {
    let entry = this.entries.get(file);
    if (!entry) {
      if (this.entries.size >= this.limit) await this.closeLeastRecentlyUsed();
      await mkdir(dirname(file), { recursive: true });
      entry = { stream: createWriteStream(file, { flags: 'a' }), lastUsed: 0 };
      this.entries.set(file, entry);
    }
    entry.lastUsed = ++this.clock;
    await writeChunk(entry.stream, `${JSON.stringify(value)}\n`);
  }

  private async closeLeastRecentlyUsed(): Promise<void> {
    const oldest = [...this.entries.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
    if (!oldest) return;
    this.entries.delete(oldest[0]);
    await finishWritable(oldest[1].stream);
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(({ stream }) => finishWritable(stream)));
  }
}

const emptyMetrics = (): StaticAdditiveSummaryMetrics => ({
  collisions: 0,
  fatalCollisions: 0,
  seriousCollisions: 0,
  slightCollisions: 0,
  unknownSeverity: 0,
  casualtyCount: 0,
  casualtyCountUnknown: 0,
  fatalities: 0,
  fatalitiesUnknown: 0,
  seriousCasualties: 0,
  seriousCasualtiesUnknown: 0,
  slightCasualties: 0,
  slightCasualtiesUnknown: 0,
  ksiCasualties: 0,
  ksiCasualtiesUnknown: 0,
  ksiCollisions: 0,
});

const addNullableMetric = (metrics: StaticAdditiveSummaryMetrics, value: unknown, totalKey: keyof StaticAdditiveSummaryMetrics, unknownKey: keyof StaticAdditiveSummaryMetrics): void => {
  const numeric = numberOrNull(value);
  if (numeric === null) metrics[unknownKey] += 1;
  else metrics[totalKey] += numeric;
};

const addRecordMetrics = (metrics: StaticAdditiveSummaryMetrics, row: CompactRow): void => {
  metrics.collisions += 1;
  const severity = severityOrUnknown(row.severity);
  if (severity === 'fatal') metrics.fatalCollisions += 1;
  else if (severity === 'serious') metrics.seriousCollisions += 1;
  else if (severity === 'slight') metrics.slightCollisions += 1;
  else metrics.unknownSeverity += 1;
  addNullableMetric(metrics, row.casualtyCount, 'casualtyCount', 'casualtyCountUnknown');
  addNullableMetric(metrics, row.fatalities, 'fatalities', 'fatalitiesUnknown');
  addNullableMetric(metrics, row.seriousCasualties, 'seriousCasualties', 'seriousCasualtiesUnknown');
  addNullableMetric(metrics, row.slightCasualties, 'slightCasualties', 'slightCasualtiesUnknown');
  addNullableMetric(metrics, row.ksiCasualties, 'ksiCasualties', 'ksiCasualtiesUnknown');
  const ksi = numberOrNull(row.ksiCasualties);
  if (ksi !== null && ksi > 0) metrics.ksiCollisions += 1;
}

const toStaticRecord = (row: CompactRow, datasetVersion: string): StaticCollisionRecord => {
  const id = stringOrNull(row.id);
  const latitude = numberOrNull(row.latitude);
  const longitude = numberOrNull(row.longitude);
  if (!id || latitude === null || longitude === null) throw new Error('Compact collision row is missing id or coordinates.');
  return {
    id,
    datasetVersion,
    year: integerOrNull(row.year),
    date: stringOrNull(row.date),
    time: stringOrNull(row.time),
    latitude,
    longitude,
    country: countryOrNull(row.country),
    authorityCode: stringOrNull(row.authorityCode),
    authorityName: stringOrNull(row.authorityName),
    roadName: stringOrNull(row.roadName),
    roadNumber: stringOrNull(row.roadNumber),
    speedLimit: integerOrNull(row.speedLimit),
    junctionDetail: stringOrNull(row.junctionDetail),
    severity: severityOrUnknown(row.severity),
    casualtyCount: integerOrNull(row.casualtyCount),
    fatalities: integerOrNull(row.fatalities),
    seriousCasualties: integerOrNull(row.seriousCasualties),
    slightCasualties: integerOrNull(row.slightCasualties),
    ksiCasualties: integerOrNull(row.ksiCasualties),
    pedestrianInvolved: boolOrNull(row.pedestrianInvolved),
    cycleInvolved: boolOrNull(row.cycleInvolved),
    motorcycleInvolved: boolOrNull(row.motorcycleInvolved),
  };
};

const hashBucketForId = (id: string): string => staticEvidenceBucket(createHash('sha256').update(id).digest()[0]);

const compressJsonLines = async (inputFile: string | null, outputFile: string): Promise<{ bytes: number; sha256: string; uncompressedBytes: number; uncompressedSha256: string }> => {
  await mkdir(dirname(outputFile), { recursive: true });
  const output = createWriteStream(outputFile);
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);
  let uncompressedBytes = 0;
  const uncompressedHash = createHash('sha256');
  let first = true;
  const writeValue = async (line: string): Promise<void> => {
    const separator = first ? '[' : ',';
    first = false;
    const value = `${separator}${line}`;
    uncompressedBytes += Buffer.byteLength(value, 'utf8');
    uncompressedHash.update(value);
    await writeChunk(gzip, value);
  };
  if (inputFile) {
    const input = createInterface({ input: createReadStream(inputFile), crlfDelay: Infinity });
    for await (const line of input) if (line.trim()) await writeValue(line);
  }
  if (first) {
    uncompressedBytes = 2;
    uncompressedHash.update('[]');
    await writeChunk(gzip, '[]');
  } else {
    uncompressedBytes += 1;
    uncompressedHash.update(']');
    await writeChunk(gzip, ']');
  }
  const outputFinished = once(output, 'finish');
  gzip.end();
  await outputFinished;
  const result = await hashFile(outputFile);
  if (result.bytes > MAX_PUBLISHED_FILE_BYTES || uncompressedBytes > MAX_PUBLISHED_FILE_BYTES) {
    throw new Error(`Static artifact exceeds 100 MB: ${outputFile} (${result.bytes} compressed, ${uncompressedBytes} uncompressed).`);
  }
  return { ...result, uncompressedBytes, uncompressedSha256: uncompressedHash.digest('hex') };
};

const compressJsonValue = async (value: unknown, outputFile: string): Promise<{ bytes: number; sha256: string; uncompressedBytes: number; uncompressedSha256: string }> => {
  const text = JSON.stringify(value);
  const uncompressedBytes = Buffer.byteLength(text, 'utf8');
  const uncompressedSha256 = sha256(text);
  await mkdir(dirname(outputFile), { recursive: true });
  const output = createWriteStream(outputFile);
  const gzip = createGzip({ level: 9 });
  gzip.pipe(output);
  await writeChunk(gzip, text);
  const outputFinished = once(output, 'finish');
  gzip.end();
  await outputFinished;
  const result = await hashFile(outputFile);
  if (result.bytes > MAX_PUBLISHED_FILE_BYTES || uncompressedBytes > MAX_PUBLISHED_FILE_BYTES) {
    throw new Error(`Static artifact exceeds 100 MB: ${outputFile} (${result.bytes} compressed, ${uncompressedBytes} uncompressed).`);
  }
  return { ...result, uncompressedBytes, uncompressedSha256 };
};

const artifact = (path: string, stats: { bytes: number; sha256: string; uncompressedBytes?: number; uncompressedSha256?: string }): StaticArtifact => ({ path, bytes: stats.bytes, sha256: stats.sha256, ...(stats.uncompressedBytes === undefined ? {} : { uncompressedBytes: stats.uncompressedBytes }), ...(stats.uncompressedSha256 === undefined ? {} : { uncompressedSha256: stats.uncompressedSha256 }) });

const assertHash = async (file: string, expected: unknown, label: string): Promise<void> => {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${label} has no valid SHA-256.`);
  const actual = (await hashFile(file)).sha256;
  if (actual !== expected) throw new Error(`${label} hash mismatch: expected ${expected}, got ${actual}.`);
};

const validateSource = async (): Promise<{ directory: string; nationalManifest: NationalManifest; serviceImportManifest: ServiceImportManifest; summary: JsonRecord; authorityLookup: JsonRecord; schoolCatalogue: StaticSchoolCatalogue; schoolOutputSha256: string; schoolProvenanceSha256: string }> => {
  const serviceImportManifest = await readJson<ServiceImportManifest>(SERVICE_IMPORT_MANIFEST);
  const expectedNationalVersion = stringOrNull(serviceImportManifest.nationalDatasetVersion);
  const expectedServiceVersion = stringOrNull(serviceImportManifest.datasetVersion);
  if (!expectedNationalVersion || !expectedServiceVersion) throw new Error(`Service import manifest is missing dataset identity: ${SERVICE_IMPORT_MANIFEST}`);
  const directory = await realpath(resolve(NATIONAL_ALIAS_DIR, 'current'));
  if (!directory.endsWith(expectedNationalVersion)) throw new Error(`Canonical national pointer does not match service import manifest: ${directory} vs ${expectedNationalVersion}`);
  const nationalManifest = await readJson<NationalManifest>(resolve(directory, 'manifest.json'));
  if (nationalManifest.datasetVersion !== expectedNationalVersion) throw new Error(`National generation version mismatch: ${String(nationalManifest.datasetVersion)} vs ${expectedNationalVersion}`);
  const includedYears = Array.isArray(nationalManifest.includedYears) ? nationalManifest.includedYears : [];
  if (includedYears.length !== REQUIRED_YEARS.length || includedYears.some((year, index) => year !== REQUIRED_YEARS[index])) {
    throw new Error(`National generation scope mismatch: expected years ${REQUIRED_YEARS.join(',')}, got ${includedYears.join(',') || 'none'}.`);
  }
  if (Number(serviceImportManifest.collisionCount) !== REQUIRED_COLLISION_COUNT) {
    throw new Error(`Static national release requires ${REQUIRED_COLLISION_COUNT} mapped collisions, got ${String(serviceImportManifest.collisionCount)}.`);
  }
  const hashes = isRecord(nationalManifest.artifactHashes) ? nationalManifest.artifactHashes : {};
  for (const name of NATIONAL_ARTIFACTS) await assertHash(resolve(directory, name), hashes[name], `National artifact ${name}`);
  const summary = await readJson<JsonRecord>(resolve(directory, 'summary.json'));
  const authorityLookup = await readJson<JsonRecord>(resolve(directory, 'authority-lookup.json'));
  const schoolBytes = await readFile(SCHOOL_OUTPUT);
  const schoolProvenanceBytes = await readFile(SCHOOL_PROVENANCE);
  const schoolOutputSha256 = sha256(schoolBytes);
  const schoolProvenanceSha256 = sha256(schoolProvenanceBytes);
  if (schoolOutputSha256 !== serviceImportManifest.schoolOutputSha256) throw new Error(`School output hash does not match service import manifest.`);
  if (schoolProvenanceSha256 !== serviceImportManifest.schoolProvenanceSha256) throw new Error(`School provenance hash does not match service import manifest.`);
  const schoolRows = JSON.parse(schoolBytes.toString('utf8')) as unknown;
  const provenance = JSON.parse(schoolProvenanceBytes.toString('utf8')) as Record<string, unknown>;
  if (!Array.isArray(schoolRows)) throw new Error(`School catalogue is not an array: ${SCHOOL_OUTPUT}`);
  if (schoolRows.length !== Number(serviceImportManifest.schoolCount)) throw new Error(`School count mismatch: ${schoolRows.length} vs ${String(serviceImportManifest.schoolCount)}`);
  return {
    directory,
    nationalManifest,
    serviceImportManifest,
    summary,
    authorityLookup,
    schoolCatalogue: { schemaVersion: STATIC_SCHEMA_VERSION, schools: schoolRows as StaticSchoolCatalogue['schools'], provenance },
    schoolOutputSha256,
    schoolProvenanceSha256,
  };
};

const authorityDescriptors = (authorityLookup: JsonRecord): Array<{ code: string; name: string; country: Country }> => {
  const authorities = isRecord(authorityLookup.authorities) ? authorityLookup.authorities : {};
  return Object.entries(authorities)
    .filter(([code, name]) => (code.startsWith('E') || code.startsWith('W')) && typeof name === 'string')
    .map(([code, name]) => ({ code, name: String(name), country: (code.startsWith('W') ? 'Wales' : 'England') as Country }))
    .sort((left, right) => left.code.localeCompare(right.code));
};

const main = async (): Promise<void> => {
  const source = await validateSource();
  const buildId = `${process.pid}-${Date.now()}`;
  const staticPublisherSha256 = (await hashFile(resolve(ROOT, 'scripts/static/build.ts'))).sha256;
  const staticContractSha256 = (await hashFile(resolve(ROOT, 'src/static/contract.ts'))).sha256;
  const stagingDir = resolve(ROOT, 'public/data', `.national-static-${buildId}`);
  const tileScratchDir = resolve(stagingDir, '.tile-scratch');
  const slimScratchDir = resolve(stagingDir, '.slim-scratch');
  const evidenceScratchDir = resolve(stagingDir, '.evidence-scratch');
  const tilesDir = resolve(stagingDir, 'tiles');
  const evidenceDir = resolve(stagingDir, 'evidence');
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(tileScratchDir, { recursive: true });
  await mkdir(slimScratchDir, { recursive: true });
  await mkdir(evidenceScratchDir, { recursive: true });
  await mkdir(tilesDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  const datasetVersion = `static-${String(source.serviceImportManifest.datasetVersion)}-${staticPublisherSha256.slice(0, 12)}-${staticContractSha256.slice(0, 12)}`;
  const nationalDatasetVersion = String(source.serviceImportManifest.nationalDatasetVersion);
  const cells = new Map<string, CellAccumulator>();
  const tileWriters = new LruNdjsonWriters(TILE_WRITER_LIMIT);
  const slimWriters = new LruNdjsonWriters(TILE_WRITER_LIMIT);
  const compactIds = new Set<string>();
  const collisionYears = new Set<number>();
  let collisionCount = 0;
  let minLatitude = 90; let maxLatitude = -90; let minLongitude = 180; let maxLongitude = -180;
  for await (const row of readJsonLines<CompactRow>(resolve(source.directory, 'collisions.ndjson'))) {
    const id = stringOrNull(row.id);
    const latitude = numberOrNull(row.latitude);
    const longitude = numberOrNull(row.longitude);
    const year = integerOrNull(row.year);
    const country = countryOrNull(row.country);
    const authorityCode = stringOrNull(row.authorityCode);
    if (!id || latitude === null || longitude === null || year === null || !REQUIRED_YEARS.includes(year as (typeof REQUIRED_YEARS)[number]) || !country || !authorityCode) throw new Error('Compact source contains an invalid or out-of-scope mappable collision row.');
    if (compactIds.has(id)) throw new Error(`Duplicate compact collision id: ${id}`);
    compactIds.add(id);
    collisionYears.add(year);
    collisionCount += 1;
    minLatitude = Math.min(minLatitude, latitude); maxLatitude = Math.max(maxLatitude, latitude);
    minLongitude = Math.min(minLongitude, longitude); maxLongitude = Math.max(maxLongitude, longitude);
    const record = toStaticRecord(row, datasetVersion);
    const cellKey = staticCellKey(longitude, latitude);
    const tileScratch = resolve(tileScratchDir, `${cellKey}.ndjson`);
    await tileWriters.append(tileScratch, record);
    await slimWriters.append(resolve(slimScratchDir, `${hashBucketForId(id)}.ndjson`), { id, record });
    const dimensions = {
      year: integerOrNull(row.year) ?? 0,
      country,
      authorityCode,
      severity: severityOrUnknown(row.severity),
      pedestrian: boolOrNull(row.pedestrianInvolved),
      cycle: boolOrNull(row.cycleInvolved),
      motorcycle: boolOrNull(row.motorcycleInvolved),
    };
    const key = staticFacetKey(dimensions);
    const cell = cells.get(cellKey) ?? { recordCount: 0, facets: new Map<string, StaticCellFacet>() };
    const facet = cell.facets.get(key) ?? { additiveSummaryMetrics: emptyMetrics() };
    addRecordMetrics(facet.additiveSummaryMetrics, row);
    cell.facets.set(key, facet);
    cell.recordCount += 1;
    cells.set(cellKey, cell);
  }
  await tileWriters.close();
  await slimWriters.close();
  if (collisionCount !== Number(source.serviceImportManifest.collisionCount)) throw new Error(`Compact collision count mismatch: ${collisionCount} vs ${String(source.serviceImportManifest.collisionCount)}`);
  if (collisionCount !== REQUIRED_COLLISION_COUNT || collisionYears.size !== REQUIRED_YEARS.length) throw new Error(`Compact source does not cover the required ${REQUIRED_YEARS.join('-')} release scope.`);

  const evidenceWriters = new LruNdjsonWriters(EVIDENCE_WRITER_LIMIT);
  const evidenceScratch = new Map<string, string>();
  const detailIds = new Set<string>();
  let detailRows = 0;
  let mappedDetailRows = 0;
  for await (const detail of readJsonLines<DetailRow>(resolve(source.directory, 'details.ndjson'))) {
    detailRows += 1;
    const id = stringOrNull(detail.id);
    if (detail.mappable !== true || !id) continue;
    const detailYear = integerOrNull(detail.year);
    if (detailYear === null || !REQUIRED_YEARS.includes(detailYear as (typeof REQUIRED_YEARS)[number])) throw new Error(`Mapped detail row is outside the required year scope: ${id}`);
    if (!compactIds.has(id)) throw new Error(`Mapped detail id is absent from compact records: ${id}`);
    if (detailIds.has(id)) throw new Error(`Duplicate mapped detail id: ${id}`);
    const collision = detail.raw?.collision;
    const casualties = detail.raw?.casualties;
    const vehicles = detail.raw?.vehicles;
    if (!isRecord(collision) || !Array.isArray(casualties) || !Array.isArray(vehicles)) throw new Error(`Mapped detail is missing raw evidence: ${id}`);
    const bucket = hashBucketForId(id);
    const scratch = resolve(evidenceScratchDir, `${bucket}.ndjson`);
    evidenceScratch.set(bucket, scratch);
    const evidence: StaticCollisionEvidence = { collision, casualties, vehicles, ...(isRecord(detail.join) ? { join: detail.join } : {}) };
    await evidenceWriters.append(scratch, { id, evidence });
    detailIds.add(id);
    mappedDetailRows += 1;
  }
  await evidenceWriters.close();
  if (detailRows !== Number(source.serviceImportManifest.detailRows)) throw new Error(`Detail row count mismatch: ${detailRows} vs ${String(source.serviceImportManifest.detailRows)}`);
  if (mappedDetailRows !== collisionCount || detailIds.size !== compactIds.size) throw new Error(`Mapped detail coverage mismatch: ${mappedDetailRows} details for ${collisionCount} compact collisions.`);

  const artifacts: Record<string, StaticArtifact> = {};
  const tilePaths: Record<string, string> = {};
  for (const cellKey of [...cells.keys()].sort()) {
    const relativePath = `tiles/${cellKey}.json.gz`;
    const stats = await compressJsonLines(resolve(tileScratchDir, `${cellKey}.ndjson`), resolve(stagingDir, relativePath));
    artifacts[relativePath] = artifact(relativePath, stats);
    tilePaths[cellKey] = relativePath;
  }
  const evidencePaths: Record<string, string> = {};
  for (let bucket = 0; bucket < STATIC_EVIDENCE_BUCKET_COUNT; bucket += 1) {
    const bucketKey = staticEvidenceBucket(bucket);
    const relativePath = `evidence/${bucketKey}.json.gz`;
    const slimMap = new Map<string, StaticCollisionRecord>();
    const slimPath = resolve(slimScratchDir, `${bucketKey}.ndjson`);
    try {
      for await (const item of readJsonLines<{ id?: unknown; record?: StaticCollisionRecord }>(slimPath)) {
        const id = stringOrNull(item.id);
        if (!id || !item.record) throw new Error(`Invalid slim record in evidence bucket ${bucketKey}.`);
        slimMap.set(id, item.record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const mergedPath = resolve(evidenceScratchDir, `${bucketKey}.merged.ndjson`);
    const merged = createWriteStream(mergedPath);
    if (evidenceScratch.has(bucketKey)) {
      for await (const item of readJsonLines<{ id?: unknown; evidence?: StaticCollisionEvidence }>(evidenceScratch.get(bucketKey) as string)) {
        const id = stringOrNull(item.id);
        const record = id ? slimMap.get(id) : undefined;
        if (!id || !record || !item.evidence) throw new Error(`Evidence bucket ${bucketKey} has no matching slim record.`);
        await writeChunk(merged, `${JSON.stringify({ ...record, evidence: item.evidence })}\n`);
        slimMap.delete(id);
      }
    }
    await finishWritable(merged);
    if (slimMap.size) throw new Error(`Evidence bucket ${bucketKey} is missing ${slimMap.size} evidence records.`);
    const stats = await compressJsonLines(mergedPath, resolve(stagingDir, relativePath));
    await rm(mergedPath, { force: true });
    artifacts[relativePath] = artifact(relativePath, stats);
    evidencePaths[bucketKey] = relativePath;
  }
  const overview: StaticOverview = {
    schemaVersion: STATIC_SCHEMA_VERSION,
    cellSizeDegrees: STATIC_CELL_SIZE_DEGREES,
    cells: Object.fromEntries([...cells.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([cellKey, value]) => [cellKey, {
      cellKey,
      bounds: staticCellBounds(cellKey),
      recordCount: value.recordCount,
      facets: Object.fromEntries([...value.facets.entries()].sort(([left], [right]) => left.localeCompare(right))),
    }] as [string, StaticCellOverview])),
  };
  const overviewStats = await compressJsonValue(overview, resolve(stagingDir, 'overview.json.gz'));
  artifacts['overview.json.gz'] = artifact('overview.json.gz', overviewStats);
  const schoolStats = await compressJsonValue(source.schoolCatalogue, resolve(stagingDir, 'schools.json.gz'));
  artifacts['schools.json.gz'] = artifact('schools.json.gz', schoolStats);

  const nationalManifest = source.nationalManifest;
  const sourceInfo = isRecord(nationalManifest.source) ? nationalManifest.source : {};
  const sourceUrls = [nationalManifest.sourceUrl, nationalManifest.codebookUrl, ...(isRecord(nationalManifest.authorityLookup) && Array.isArray(nationalManifest.authorityLookup.sourceUrls) ? nationalManifest.authorityLookup.sourceUrls : [])].filter((value): value is string => typeof value === 'string');
  const staticManifest: StaticManifest = {
    schemaVersion: STATIC_SCHEMA_VERSION,
    datasetVersion,
    nationalDatasetVersion,
    generatedAt: String(nationalManifest.generatedAt ?? new Date().toISOString()),
    years: Array.isArray(nationalManifest.includedYears) ? nationalManifest.includedYears.filter((year): year is number => typeof year === 'number') : [],
    scope: 'England and Wales',
    extent: { west: minLongitude, south: minLatitude, east: maxLongitude, north: maxLatitude },
    collisionCount,
    detailCount: mappedDetailRows,
    schoolCount: source.schoolCatalogue.schools.length,
    cellSizeDegrees: STATIC_CELL_SIZE_DEGREES,
    evidenceBucketCount: STATIC_EVIDENCE_BUCKET_COUNT,
    source: {
      publisher: typeof sourceInfo.publisher === 'string' ? sourceInfo.publisher : 'Department for Transport',
      dataset: typeof sourceInfo.dataset === 'string' ? sourceInfo.dataset : 'STATS19 road safety open data',
      urls: sourceUrls,
      licence: typeof nationalManifest.licence === 'string' ? nationalManifest.licence : undefined,
      licenceUrl: typeof nationalManifest.licenceUrl === 'string' ? nationalManifest.licenceUrl : undefined,
    },
    authorities: authorityDescriptors(source.authorityLookup),
    paths: { overview: 'overview.json.gz', tiles: 'tiles/', evidence: 'evidence/', schools: 'schools.json.gz' },
    tiles: tilePaths,
    evidenceBuckets: evidencePaths,
    artifacts,
    provenance: {
      nationalManifest,
      serviceImportManifest: source.serviceImportManifest,
      staticPublisherSha256,
      staticContractSha256,
      schoolProvenanceSha256: source.schoolProvenanceSha256,
      schoolOutputSha256: source.schoolOutputSha256,
    },
  };
  await writeFile(resolve(stagingDir, 'manifest.json'), `${JSON.stringify(staticManifest, null, 2)}\n`, 'utf8');
  const manifestStats = await hashFile(resolve(stagingDir, 'manifest.json'));
  const allBytes = Object.values(artifacts).reduce((total, item) => total + item.bytes, manifestStats.bytes);
  if (allBytes > MAX_PUBLISHED_TOTAL_BYTES) {
    throw new Error(`Static national publication exceeds 1 GB: ${allBytes} bytes.`);
  }
  await rm(tileScratchDir, { recursive: true, force: true });
  await rm(slimScratchDir, { recursive: true, force: true });
  await rm(evidenceScratchDir, { recursive: true, force: true });
  await mkdir(dirname(OUTPUT_DIR), { recursive: true });
  const previousDir = resolve(ROOT, 'public/data', `.national-static-previous-${buildId}`);
  let previousMoved = false;
  try {
    try {
      await rename(OUTPUT_DIR, previousDir);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(stagingDir, OUTPUT_DIR);
    } catch (error) {
      if (previousMoved) {
        try {
          await rename(previousDir, OUTPUT_DIR);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(`Static publication replacement failed and previous output could not be restored: ${String(restoreError)}`, { cause: error });
        }
      }
      throw error;
    }
  } finally {
    if (previousMoved) await rm(previousDir, { recursive: true, force: true });
  }
  const publishedStats = await hashFile(resolve(OUTPUT_DIR, 'manifest.json'));
  if (publishedStats.sha256 !== manifestStats.sha256) throw new Error('Published static manifest changed during finalization.');
  console.log(JSON.stringify({
    output: OUTPUT_DIR,
    datasetVersion,
    nationalDatasetVersion,
    collisionCount,
    mappedDetailRows,
    schoolCount: source.schoolCatalogue.schools.length,
    cellCount: cells.size,
    evidenceBuckets: STATIC_EVIDENCE_BUCKET_COUNT,
    artifactCount: Object.keys(artifacts).length + 1,
    publishedBytes: allBytes,
    manifestBytes: manifestStats.bytes,
  }, null, 2));
};

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main, validateSource };
