import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, relative, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { parse } from 'csv-parse';
import type { Writable } from 'node:stream';
import {
  codeValue,
  coordinate,
  integerValue,
  isoDate,
  roadNumber,
  rowId,
  rowYear,
  severity,
  value,
  type RawRow,
} from '../ingest-stats19.ts';
import {
  CODEBOOK_NOTES,
  CODEBOOK_URL,
  CYCLIST_VEHICLE_TYPES,
  KNOWN_CASUALTY_SEVERITIES,
  KNOWN_CASUALTY_TYPES,
  KNOWN_VEHICLE_TYPES,
  MOTORCYCLE_VEHICLE_TYPES,
  PEDESTRIAN_CASUALTY_TYPES,
} from './codebook.ts';

const YEARS = [2021, 2022, 2023, 2024, 2025] as const;
const EXPECTED_REGRESSION = {
  totalEnglandWalesCollisionRows: 493_271,
  totalMappableFeatures: 493_218,
  totalInvalidCoordinates: 53,
  totalMappableCasualties: 624_985,
  totalFatalities: 7_264,
  totalSeriousCasualties: 119_791,
  totalSlightCasualties: 497_930,
  byYear: {
    2021: { englandWalesCollisionRows: 97_185, mappableFeatures: 97_168, invalidCoordinates: 17, mappableCasualties: 123_083, vehicleJoinedRows: 179_607, mappableVehicleRows: 179_572, completeVehicleJoins: 97_185 },
    2022: { englandWalesCollisionRows: 101_879, mappableFeatures: 101_857, invalidCoordinates: 22, mappableCasualties: 129_846, vehicleJoinedRows: 186_358, mappableVehicleRows: 186_317, completeVehicleJoins: 101_879 },
    2023: { englandWalesCollisionRows: 100_026, mappableFeatures: 100_014, invalidCoordinates: 12, mappableCasualties: 127_163, vehicleJoinedRows: 182_532, mappableVehicleRows: 182_511, completeVehicleJoins: 100_026 },
    2024: { englandWalesCollisionRows: 96_760, mappableFeatures: 96_760, invalidCoordinates: 0, mappableCasualties: 122_547, vehicleJoinedRows: 176_253, mappableVehicleRows: 176_253, completeVehicleJoins: 96_760 },
    2025: { englandWalesCollisionRows: 97_421, mappableFeatures: 97_419, invalidCoordinates: 2, mappableCasualties: 122_346, vehicleJoinedRows: 176_788, mappableVehicleRows: 176_784, completeVehicleJoins: 97_421 },
  },
} as const;
const RAW_DIR = resolve('data/raw');
const NATIONAL_DIR = resolve('data/national');
const OUTPUT_ALIAS_DIR = resolve(NATIONAL_DIR, '2021-2025');
const GENERATIONS_DIR = resolve(NATIONAL_DIR, 'generations');
const ACQUISITION_FILE = resolve(RAW_DIR, '.national-acquisition.json');
const BUILD_LOCK_DIR = resolve(NATIONAL_DIR, '.national-build.lock');
const BUCKET_COUNT = 64;
const DFT_BASE = 'https://data.dft.gov.uk/road-accidents-safety-data';
const DATASET_URL = 'https://www.gov.uk/government/statistical-data-sets/road-safety-open-data';
const LICENCE_URL = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';
const AUTHORITY_LOOKUP_SOURCES = [
  {
    url: "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_December_2024_Boundaries_UK_BGC/FeatureServer/0/query?where=LAD24CD%20LIKE%20%27E%25%27%20OR%20LAD24CD%20LIKE%20%27W%25%27&outFields=LAD24CD,LAD24NM&returnGeometry=false&f=json",
    codeField: 'LAD24CD',
    nameField: 'LAD24NM',
  },
  {
    url: 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_December_2021_UK_BGC_2022/FeatureServer/0/query?where=LAD21CD%20LIKE%20%27E%25%27%20OR%20LAD21CD%20LIKE%20%27W%25%27&outFields=LAD21CD,LAD21NM&returnGeometry=false&f=json',
    codeField: 'LAD21CD',
    nameField: 'LAD21NM',
  },
  {
    url: 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_DEC_2025_Boundaries_UK_BGC/FeatureServer/0/query?where=LAD25CD%20LIKE%20%27E%25%27%20OR%20LAD25CD%20LIKE%20%27W%25%27&outFields=LAD25CD,LAD25NM&returnGeometry=false&f=json',
    codeField: 'LAD25CD',
    nameField: 'LAD25NM',
  },
];

type DatasetKind = 'collision' | 'casualty' | 'vehicle';
type Country = 'England' | 'Wales';
type Severity = 'fatal' | 'serious' | 'slight' | 'unknown';

interface InputSource {
  year: number;
  kind: DatasetKind;
  canonicalUrl: string;
  retrievalUrl: string;
  localFile: string;
}

interface InputAcquisition {
  status: 'existing-cache' | 'downloaded' | 'unverified-cache';
  retrievedAt: string | null;
  etag: string | null;
  lastModified: string | null;
  sourceUrl: string | null;
}

interface AuthorityLookup {
  sourceUrl: string;
  sourceUrls: string[];
  retrievedAt: string;
  featureCount: number;
  sourceFeatureCounts: Record<string, number>;
  authorities: Record<string, string>;
}

interface CollisionAccumulator {
  id: string;
  year: number;
  country: Country;
  authorityCode: string;
  authorityName: string | null;
  sourceRowNumber: number;
  latitude: number | null;
  longitude: number | null;
  date: string | null;
  time: string | null;
  severity: Severity;
  severityCode: number | null;
  roadNumber: string | null;
  speedLimit: number | null;
  junctionDetail: string | null;
  rawCasualties: number | null;
  rawVehicles: number | null;
  casualtyRows: number;
  casualtyFatalities: number;
  casualtySerious: number;
  casualtySlight: number;
  casualtyTypes: Set<number>;
  casualtyReferences: Set<string>;
  vehicleRows: number;
  vehicleTypes: Set<number>;
  vehicleReferences: Set<string>;
  unknownCasualtyTypes: number;
  unknownCasualtySeverities: number;
  unknownVehicleTypes: number;
  missingCasualtyReferences: number;
  missingVehicleReferences: number;
  duplicateCasualtyReferences: number;
  duplicateVehicleReferences: number;
}

interface CollisionSpoolRow {
  key: string;
  id: string | null;
  year: number;
  country: Country;
  authorityCode: string;
  sourceRowNumber: number;
  raw: RawRow;
}

interface ChildSpoolRow {
  id: string;
  sourceRowNumber: number;
  raw: RawRow;
}

interface JoinCoverage {
  casualtyJoinComplete: boolean;
  vehicleJoinComplete: boolean;
  casualtyTypeComplete: boolean;
  casualtySeverityComplete: boolean;
  casualtyClassificationComplete: boolean;
  vehicleClassificationComplete: boolean;
}

interface MetricSummary {
  collisions: number;
  fatalCollisions: number;
  seriousCollisions: number;
  slightCollisions: number;
  unknownSeverity: number;
  casualtyCount: number;
  casualtyCountUnknown: number;
  fatalities: number;
  fatalitiesUnknown: number;
  seriousCasualties: number;
  seriousCasualtiesUnknown: number;
  slightCasualties: number;
  slightCasualtiesUnknown: number;
  ksiCasualties: number;
  ksiCasualtiesUnknown: number;
  pedestrianInvolved: number;
  pedestrianUnknown: number;
  cycleInvolved: number;
  cycleUnknown: number;
  motorcycleInvolved: number;
  motorcycleUnknown: number;
}

interface SourceCounters {
  sourceRows: Record<string, number>;
  ewRows: Record<string, number>;
  unmatchedChildRows: Record<string, number>;
}

interface YearSummary {
  sourceRows: Record<DatasetKind, number>;
  englandWalesCollisionRows: number;
  mappableFeatures: number;
  invalidCoordinates: number;
  missingCollisionIds: number;
  duplicateCollisionRows: number;
  sourceChildRows: { casualty: number; vehicle: number };
  mappableChildRows: { casualty: number; vehicle: number };
  unmatchedChildRows: { casualty: number; vehicle: number };
  collisionsWithCompleteCasualtyJoin: number;
  collisionsWithCompleteVehicleJoin: number;
  collisionsWithCompleteCasualtySeverity: number;
  collisionsWithCompleteCasualtyClassification: number;
  collisionsWithCompleteVehicleClassification: number;
  unknownCasualtyTypes: number;
  unknownCasualtySeverities: number;
  unknownVehicleTypes: number;
  duplicateCasualtyChildKeys: number;
  duplicateVehicleChildKeys: number;
  unresolvedAuthorityCodes: Record<string, number>;
}

interface DetailOutput {
  id: string | null;
  year: number;
  country: Country;
  authorityCode: string;
  authorityName: string | null;
  sourceRowNumber: number;
  mappable: boolean;
  coordinate: { latitude: number; longitude: number } | null;
  raw: {
    collision: RawRow;
    casualties: RawRow[];
    vehicles: RawRow[];
  };
  join: {
    rawCasualtyCount: number | null;
    rawVehicleCount: number | null;
    casualtyRowsJoined: number;
    vehicleRowsJoined: number;
    coverage: JoinCoverage | null;
    casualtyTypeCodes: number[];
    vehicleTypeCodes: number[];
    unknownCasualtyTypes: number;
    unknownCasualtySeverities: number;
    unknownVehicleTypes: number;
    missingCasualtyReferences: number;
    missingVehicleReferences: number;
    duplicateCasualtyReferences: number;
    duplicateVehicleReferences: number;
  };
}

const sourceFor = (year: number, kind: DatasetKind): InputSource => {
  const filename = `dft-road-casualty-statistics-${kind}-${year}.csv`;
  const canonicalUrl = `${DFT_BASE}/${filename}`;
  return {
    year,
    kind,
    canonicalUrl,
    retrievalUrl: canonicalUrl,
    localFile: resolve(RAW_DIR, `${kind}-${year}.csv`),
  };
};

const allSources = YEARS.flatMap((year) =>
  (['collision', 'casualty', 'vehicle'] as DatasetKind[]).map((kind) => sourceFor(year, kind)),
);

const REQUIRED_HEADERS: Record<DatasetKind, string[]> = {
  collision: ['collision_index', 'collision_year', 'latitude', 'longitude', 'collision_severity', 'number_of_casualties', 'number_of_vehicles', 'local_authority_ons_district', 'local_authority_highway_current', 'local_authority_highway'],
  casualty: ['collision_index', 'collision_year', 'casualty_reference', 'casualty_severity', 'casualty_type'],
  vehicle: ['collision_index', 'collision_year', 'vehicle_reference', 'vehicle_type'],
};

const readRows = async function* (file: string, source: InputSource): AsyncGenerator<RawRow> {
  const parser = createReadStream(file).pipe(parse({
    bom: true,
    columns: (headers: string[]) => {
      const missing = REQUIRED_HEADERS[source.kind].filter((header) => !headers.includes(header));
      if (missing.length > 0) {
        throw new Error(`${source.kind} ${source.year} is missing required CSV headers: ${missing.join(', ')}`);
      }
      return headers;
    },
    relax_column_count: false,
    skip_empty_lines: true,
    trim: true,
  }));
  let rowNumber = 0;
  for await (const row of parser) {
    rowNumber += 1;
    const typedRow = row as RawRow;
    const rowSourceYear = integerValue(typedRow, ['collision_year', 'accident_year']);
    if (rowSourceYear !== source.year) {
      throw new Error(`${source.kind} ${source.year} row ${rowNumber} has collision_year ${rowSourceYear ?? 'missing'}`);
    }
    yield typedRow;
  }
};

const readJsonLines = async function* <T>(file: string): AsyncGenerator<T> {
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim() !== '') yield JSON.parse(line) as T;
  }
};

const increment = (counts: Record<string, number>, key: string, amount = 1): void => {
  counts[key] = (counts[key] ?? 0) + amount;
};

const sourceKey = (year: number, kind: DatasetKind): string => `${kind}:${year}`;

const countryFor = (authorityCode: string): Country | null => {
  if (authorityCode.startsWith('E')) return 'England';
  if (authorityCode.startsWith('W')) return 'Wales';
  return null;
};

const speedLimit = (row: RawRow): number | null => {
  const limit = integerValue(row, ['speed_limit']);
  return limit !== null && limit > 0 && limit < 100 ? limit : null;
};

const childReference = (row: RawRow, keys: string[]): string | null => {
  const reference = value(row, keys);
  if (reference === null || !/^\d+$/.test(reference)) return null;
  const numeric = Number(reference);
  return Number.isFinite(numeric) && numeric >= 1 ? reference : null;
};

const bucketFor = (id: string): number => {
  const digest = createHash('sha256').update(id).digest();
  return digest.readUInt32BE(0) % BUCKET_COUNT;
};

const writeLine = async (stream: Writable, line: string): Promise<void> => {
  if (!stream.write(`${line}\n`)) await once(stream, 'drain');
};

const finishStream = async (stream: Writable): Promise<void> => {
  stream.end();
  await once(stream, 'finish');
};

class BucketSpool {
  private readonly collisionStreams = new Map<number, Writable>();
  private readonly casualtyStreams = new Map<number, Writable>();
  private readonly vehicleStreams = new Map<number, Writable>();
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (let bucket = 0; bucket < BUCKET_COUNT; bucket += 1) {
      this.collisionStreams.set(bucket, createWriteStream(resolve(this.directory, `collision-${bucket}.ndjson`)));
      this.casualtyStreams.set(bucket, createWriteStream(resolve(this.directory, `casualty-${bucket}.ndjson`)));
      this.vehicleStreams.set(bucket, createWriteStream(resolve(this.directory, `vehicle-${bucket}.ndjson`)));
    }
  }

  async writeCollision(bucket: number, record: CollisionSpoolRow): Promise<void> {
    await writeLine(this.collisionStreams.get(bucket) as Writable, JSON.stringify(record));
  }

  async writeCasualty(bucket: number, record: ChildSpoolRow): Promise<void> {
    await writeLine(this.casualtyStreams.get(bucket) as Writable, JSON.stringify(record));
  }

  async writeVehicle(bucket: number, record: ChildSpoolRow): Promise<void> {
    await writeLine(this.vehicleStreams.get(bucket) as Writable, JSON.stringify(record));
  }

  async close(): Promise<void> {
    await Promise.all([
      ...this.collisionStreams.values(),
      ...this.casualtyStreams.values(),
      ...this.vehicleStreams.values(),
    ].map((stream) => finishStream(stream)));
  }
}

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

/**
 * Serialize the complete acquisition-to-publication transaction. Raw annual
 * files and their sidecar are shared by builds, so per-run temporary names do
 * not by themselves prevent one build from replacing bytes another build is
 * parsing. The lock is a directory created atomically on the same filesystem.
 * Existing locks fail closed: a human must verify that the owning process is
 * gone before removing the lock and retrying the build.
 */
const acquireExclusiveDirectoryLock = async (lockDirectory: string): Promise<() => Promise<void>> => {
  const ownerToken = randomUUID();
  const ownerFile = resolve(lockDirectory, 'owner.json');
  await mkdir(dirname(lockDirectory), { recursive: true });
  try {
    await mkdir(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let ownerInfo = 'owner information is unavailable';
    try {
      const owner = (await readFile(ownerFile, 'utf8')).trim();
      if (owner) ownerInfo = `owner information: ${owner}`;
    } catch (ownerError) {
      const code = (ownerError as NodeJS.ErrnoException).code;
      ownerInfo = `owner information is unavailable${code ? ` (${code})` : ''}`;
    }
    throw new Error(`National build lock already exists at ${lockDirectory}; ${ownerInfo}. Verify that no build is running, then remove the lock manually and retry.`);
  }
  try {
    await writeFile(ownerFile, `${JSON.stringify({ pid: process.pid, token: ownerToken, acquiredAt: new Date().toISOString() })}\n`, 'utf8');
  } catch (error) {
    await rm(lockDirectory, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    try {
      const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as { token?: string };
      if (owner.token === ownerToken) await rm(lockDirectory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
};

const writeJsonAtomically = async (file: string, valueToWrite: unknown, token = randomUUID()): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const partialFile = `${file}.${process.pid}.${token}.partial`;
  await writeFile(partialFile, `${JSON.stringify(valueToWrite, null, 2)}\n`, 'utf8');
  await rename(partialFile, file);
};

const ensureInput = async (source: InputSource, previous?: InputAcquisition & { bytes?: number; localFileModifiedAt?: string; sha256?: string }): Promise<InputAcquisition> => {
  const refresh = process.env.WECA_NATIONAL_REFRESH === '1';
  try {
    const existing = await stat(source.localFile);
    if (!refresh && existing.isFile() && existing.size > 0) {
      const digest = await hashFile(source.localFile);
      const metadataMatches = previous?.bytes === existing.size &&
        previous.localFileModifiedAt === existing.mtime.toISOString() && previous.sha256 === digest.sha256;
      return {
        status: metadataMatches ? 'existing-cache' : 'unverified-cache',
        retrievedAt: metadataMatches ? previous?.retrievedAt ?? null : null,
        etag: metadataMatches ? previous?.etag ?? null : null,
        lastModified: metadataMatches ? previous?.lastModified ?? null : null,
        sourceUrl: metadataMatches ? previous?.sourceUrl ?? null : null,
      };
    }
  } catch {
    // Download the missing annual source below.
  }
  const response = await fetch(source.retrievalUrl);
  if (!response.ok || response.body === null) {
    throw new Error(`Unable to download ${source.retrievalUrl}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(RAW_DIR, { recursive: true });
  const partialFile = `${source.localFile}.${process.pid}.${randomUUID()}.partial`;
  await writeFile(partialFile, bytes);
  await rename(partialFile, source.localFile);
  return {
    status: 'downloaded',
    retrievedAt: new Date().toISOString(),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    sourceUrl: response.url,
  };
};

const ensureInputs = async (): Promise<Record<string, InputAcquisition>> => {
  const acquisition: Record<string, InputAcquisition> = {};
  let previous: Record<string, InputAcquisition & { bytes?: number; localFileModifiedAt?: string; sha256?: string }> = {};
  try {
    previous = JSON.parse(await readFile(ACQUISITION_FILE, 'utf8')) as Record<string, InputAcquisition & { bytes?: number; localFileModifiedAt?: string; sha256?: string }>;
  } catch {
    // Existing source files without a sidecar are reported as unverified caches.
  }
  for (const source of allSources) {
    const key = sourceKey(source.year, source.kind);
    acquisition[key] = await ensureInput(source, previous[key]);
  }
  return acquisition;
};

const loadAuthorityLookup = async (): Promise<AuthorityLookup> => {
  const retrievedAt = new Date().toISOString();
  const authorities: Record<string, string> = {};
  const sourceFeatureCounts: Record<string, number> = {};
  for (const source of AUTHORITY_LOOKUP_SOURCES) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Unable to fetch authority lookup: HTTP ${response.status}`);
    const payload = await response.json() as {
      error?: { code?: number; message?: string };
      transferLimitExceeded?: boolean;
      exceededTransferLimit?: boolean;
      features?: Array<{ attributes?: Record<string, string> }>;
    };
    if (payload.error) throw new Error(`Authority lookup ${source.url} returned ${payload.error.code ?? 'an error'}: ${payload.error.message ?? 'unknown error'}`);
    if (payload.transferLimitExceeded === true || payload.exceededTransferLimit === true) throw new Error(`Authority lookup ${source.url} was truncated by the ArcGIS transfer limit.`);
    if (!Array.isArray(payload.features) || payload.features.length === 0) throw new Error(`Authority lookup ${source.url} returned no features.`);
    sourceFeatureCounts[source.url] = payload.features.length;
    for (const feature of payload.features) {
      const code = feature.attributes?.[source.codeField];
      const name = feature.attributes?.[source.nameField];
      if (!code || !name) throw new Error(`Authority lookup ${source.url} contains a feature without ${source.codeField}/${source.nameField}.`);
      authorities[code] = name;
    }
  }
  // EHEATHROW is a DfT special code rather than an ONS LAD code.
  authorities.EHEATHROW = 'Heathrow';
  if (Object.keys(authorities).length === 0) throw new Error('Authority lookup returned no England/Wales authorities.');
  return {
    sourceUrl: AUTHORITY_LOOKUP_SOURCES[0].url,
    sourceUrls: AUTHORITY_LOOKUP_SOURCES.map((source) => source.url),
    retrievedAt,
    featureCount: Object.keys(authorities).length,
    sourceFeatureCounts,
    authorities,
  };
};

const createAccumulator = (
  row: RawRow,
  year: number,
  country: Country,
  authorityCode: string,
  sourceRowNumber: number,
  authorityName: string | null,
  id: string,
): CollisionAccumulator => {
  const point = coordinate(row);
  const severityCode = codeValue(row, ['collision_severity', 'accident_severity']);
  return {
    id,
    year: rowYear(row, year),
    country,
    authorityCode,
    authorityName,
    sourceRowNumber,
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    date: isoDate(row),
    time: value(row, ['time']),
    severity: severity(row),
    severityCode,
    roadNumber: roadNumber(row),
    speedLimit: speedLimit(row),
    junctionDetail: (() => {
      const detail = integerValue(row, ['junction_detail']);
      return detail === null ? null : String(detail);
    })(),
    rawCasualties: integerValue(row, ['number_of_casualties']),
    rawVehicles: integerValue(row, ['number_of_vehicles']),
    casualtyRows: 0,
    casualtyFatalities: 0,
    casualtySerious: 0,
    casualtySlight: 0,
    casualtyTypes: new Set<number>(),
    casualtyReferences: new Set<string>(),
    vehicleRows: 0,
    vehicleTypes: new Set<number>(),
    vehicleReferences: new Set<string>(),
    unknownCasualtyTypes: 0,
    unknownCasualtySeverities: 0,
    unknownVehicleTypes: 0,
    missingCasualtyReferences: 0,
    missingVehicleReferences: 0,
    duplicateCasualtyReferences: 0,
    duplicateVehicleReferences: 0,
  };
};

const joinCoverage = (acc: CollisionAccumulator): JoinCoverage => {
  const casualtyJoinComplete = acc.rawCasualties !== null && acc.casualtyRows === acc.rawCasualties &&
    acc.casualtyReferences.size === acc.casualtyRows && acc.missingCasualtyReferences === 0 && acc.duplicateCasualtyReferences === 0;
  const vehicleJoinComplete = acc.rawVehicles !== null && acc.vehicleRows === acc.rawVehicles &&
    acc.vehicleReferences.size === acc.vehicleRows && acc.missingVehicleReferences === 0 && acc.duplicateVehicleReferences === 0;
  const casualtyTypeComplete = casualtyJoinComplete && acc.unknownCasualtyTypes === 0;
  const casualtySeverityComplete = casualtyJoinComplete && acc.unknownCasualtySeverities === 0;
  return {
    casualtyJoinComplete,
    vehicleJoinComplete,
    casualtyTypeComplete,
    casualtySeverityComplete,
    casualtyClassificationComplete: casualtyTypeComplete && casualtySeverityComplete,
    vehicleClassificationComplete: vehicleJoinComplete && acc.unknownVehicleTypes === 0,
  };
};

const involvement = (types: Set<number>, known: ReadonlySet<number>, complete: boolean): boolean | null => {
  const present = [...types].some((type) => known.has(type));
  return complete ? present : present ? true : null;
};

const metricSummary = (): MetricSummary => ({
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
  pedestrianInvolved: 0,
  pedestrianUnknown: 0,
  cycleInvolved: 0,
  cycleUnknown: 0,
  motorcycleInvolved: 0,
  motorcycleUnknown: 0,
});

const addMetrics = (target: MetricSummary, acc: CollisionAccumulator, coverage: JoinCoverage): void => {
  target.collisions += 1;
  if (acc.severity === 'fatal') target.fatalCollisions += 1;
  else if (acc.severity === 'serious') target.seriousCollisions += 1;
  else if (acc.severity === 'slight') target.slightCollisions += 1;
  else target.unknownSeverity += 1;

  const fatalities = coverage.casualtySeverityComplete ? acc.casualtyFatalities : null;
  const seriousCasualties = coverage.casualtySeverityComplete ? acc.casualtySerious : null;
  const slightCasualties = coverage.casualtySeverityComplete ? acc.casualtySlight : null;
  const ksiCasualties = fatalities === null || seriousCasualties === null ? null : fatalities + seriousCasualties;
  if (acc.rawCasualties === null) target.casualtyCountUnknown += 1;
  else target.casualtyCount += acc.rawCasualties;
  if (fatalities === null) target.fatalitiesUnknown += 1;
  else target.fatalities += fatalities;
  if (seriousCasualties === null) target.seriousCasualtiesUnknown += 1;
  else target.seriousCasualties += seriousCasualties;
  if (slightCasualties === null) target.slightCasualtiesUnknown += 1;
  else target.slightCasualties += slightCasualties;
  if (ksiCasualties === null) target.ksiCasualtiesUnknown += 1;
  else target.ksiCasualties += ksiCasualties;

  const pedestrian = involvement(acc.casualtyTypes, PEDESTRIAN_CASUALTY_TYPES, coverage.casualtyTypeComplete);
  const cycle = involvement(acc.vehicleTypes, CYCLIST_VEHICLE_TYPES, coverage.vehicleClassificationComplete);
  const motorcycle = involvement(acc.vehicleTypes, MOTORCYCLE_VEHICLE_TYPES, coverage.vehicleClassificationComplete);
  if (pedestrian === null) target.pedestrianUnknown += 1;
  else if (pedestrian) target.pedestrianInvolved += 1;
  if (cycle === null) target.cycleUnknown += 1;
  else if (cycle) target.cycleInvolved += 1;
  if (motorcycle === null) target.motorcycleUnknown += 1;
  else if (motorcycle) target.motorcycleInvolved += 1;
};

const detailFor = (
  spool: CollisionSpoolRow,
  acc: CollisionAccumulator | undefined,
  casualties: RawRow[],
  vehicles: RawRow[],
  authorityName: string | null,
): DetailOutput => {
  const coverage = acc ? joinCoverage(acc) : null;
  return {
    id: spool.id,
    year: spool.year,
    country: spool.country,
    authorityCode: spool.authorityCode,
    authorityName,
    sourceRowNumber: spool.sourceRowNumber,
    mappable: Boolean(acc && acc.latitude !== null && acc.longitude !== null),
    coordinate: acc && acc.latitude !== null && acc.longitude !== null
      ? { latitude: acc.latitude, longitude: acc.longitude }
      : null,
    raw: { collision: spool.raw, casualties, vehicles },
    join: {
      rawCasualtyCount: acc?.rawCasualties ?? null,
      rawVehicleCount: acc?.rawVehicles ?? null,
      casualtyRowsJoined: acc?.casualtyRows ?? 0,
      vehicleRowsJoined: acc?.vehicleRows ?? 0,
      coverage,
      casualtyTypeCodes: acc ? [...acc.casualtyTypes].sort((a, b) => a - b) : [],
      vehicleTypeCodes: acc ? [...acc.vehicleTypes].sort((a, b) => a - b) : [],
      unknownCasualtyTypes: acc?.unknownCasualtyTypes ?? 0,
      unknownCasualtySeverities: acc?.unknownCasualtySeverities ?? 0,
      unknownVehicleTypes: acc?.unknownVehicleTypes ?? 0,
      missingCasualtyReferences: acc?.missingCasualtyReferences ?? 0,
      missingVehicleReferences: acc?.missingVehicleReferences ?? 0,
      duplicateCasualtyReferences: acc?.duplicateCasualtyReferences ?? 0,
      duplicateVehicleReferences: acc?.duplicateVehicleReferences ?? 0,
    },
  };
};

const compactFor = (acc: CollisionAccumulator, authorityName: string | null): Record<string, unknown> => {
  const coverage = joinCoverage(acc);
  const fatalities = coverage.casualtySeverityComplete ? acc.casualtyFatalities : null;
  const seriousCasualties = coverage.casualtySeverityComplete ? acc.casualtySerious : null;
  const slightCasualties = coverage.casualtySeverityComplete ? acc.casualtySlight : null;
  const pedestrianInvolved = involvement(acc.casualtyTypes, PEDESTRIAN_CASUALTY_TYPES, coverage.casualtyTypeComplete);
  const cycleInvolved = involvement(acc.vehicleTypes, CYCLIST_VEHICLE_TYPES, coverage.vehicleClassificationComplete);
  const motorcycleInvolved = involvement(acc.vehicleTypes, MOTORCYCLE_VEHICLE_TYPES, coverage.vehicleClassificationComplete);
  return {
    id: acc.id,
    year: acc.year,
    country: acc.country,
    authorityCode: acc.authorityCode,
    authorityName,
    date: acc.date,
    time: acc.time,
    latitude: acc.latitude,
    longitude: acc.longitude,
    severity: acc.severity,
    roadName: null,
    roadNumber: acc.roadNumber,
    speedLimit: acc.speedLimit,
    junctionDetail: acc.junctionDetail,
    casualtyCount: acc.rawCasualties,
    fatalities,
    seriousCasualties,
    slightCasualties,
    ksiCasualties: fatalities === null || seriousCasualties === null ? null : fatalities + seriousCasualties,
    pedestrianInvolved,
    cycleInvolved,
    motorcycleInvolved,
    source: 'DfT STATS19',
    sourceYear: acc.year,
    sourceId: acc.id,
    sourceCoverage: {
      casualtyRowsJoined: acc.casualtyRows,
      vehicleRowsJoined: acc.vehicleRows,
      rawCasualtyCount: acc.rawCasualties,
      rawVehicleCount: acc.rawVehicles,
      ...coverage,
      unknownCasualtyTypes: acc.unknownCasualtyTypes,
      unknownCasualtySeverities: acc.unknownCasualtySeverities,
      unknownVehicleTypes: acc.unknownVehicleTypes,
      missingCasualtyReferences: acc.missingCasualtyReferences,
      missingVehicleReferences: acc.missingVehicleReferences,
      duplicateCasualtyReferences: acc.duplicateCasualtyReferences,
      duplicateVehicleReferences: acc.duplicateVehicleReferences,
      casualtyTypeCodes: [...acc.casualtyTypes].sort((a, b) => a - b),
      vehicleTypeCodes: [...acc.vehicleTypes].sort((a, b) => a - b),
    },
  };
};

const emptyYearSummary = (): YearSummary => ({
  sourceRows: { collision: 0, casualty: 0, vehicle: 0 },
  englandWalesCollisionRows: 0,
  mappableFeatures: 0,
  invalidCoordinates: 0,
  missingCollisionIds: 0,
  duplicateCollisionRows: 0,
  sourceChildRows: { casualty: 0, vehicle: 0 },
  mappableChildRows: { casualty: 0, vehicle: 0 },
  unmatchedChildRows: { casualty: 0, vehicle: 0 },
  collisionsWithCompleteCasualtyJoin: 0,
  collisionsWithCompleteVehicleJoin: 0,
  collisionsWithCompleteCasualtySeverity: 0,
  collisionsWithCompleteCasualtyClassification: 0,
  collisionsWithCompleteVehicleClassification: 0,
  unknownCasualtyTypes: 0,
  unknownCasualtySeverities: 0,
  unknownVehicleTypes: 0,
  duplicateCasualtyChildKeys: 0,
  duplicateVehicleChildKeys: 0,
  unresolvedAuthorityCodes: {},
});

const processYear = async (
  year: number,
  lookup: AuthorityLookup,
  counters: SourceCounters,
  spool: BucketSpool,
): Promise<{ accumulators: Map<string, CollisionAccumulator>; summary: YearSummary }> => {
  const summary = emptyYearSummary();
  const accumulators = new Map<string, CollisionAccumulator>();
  const seenIds = new Set<string>();
  const collisionSource = sourceFor(year, 'collision');
  let sourceRowNumber = 0;
  for await (const row of readRows(collisionSource.localFile, collisionSource)) {
    sourceRowNumber += 1;
    increment(counters.sourceRows, sourceKey(year, 'collision'));
    summary.sourceRows.collision += 1;
    const authorityCode = value(row, ['local_authority_ons_district', 'local_authority_highway_current', 'local_authority_highway']);
    const country = authorityCode === null ? null : countryFor(authorityCode);
    if (country === null || authorityCode === null) continue;
    summary.englandWalesCollisionRows += 1;
    increment(counters.ewRows, sourceKey(year, 'collision'));
    const id = rowId(row);
    const key = id ?? `missing-id:${year}:${sourceRowNumber}`;
    await spool.writeCollision(bucketFor(id ?? key), {
      key,
      id,
      year: rowYear(row, year),
      country,
      authorityCode,
      sourceRowNumber,
      raw: row,
    });
    if (id === null) {
      summary.missingCollisionIds += 1;
      continue;
    }
    if (seenIds.has(id)) {
      summary.duplicateCollisionRows += 1;
      continue;
    }
    seenIds.add(id);
    const authorityName = lookup.authorities[authorityCode] ?? null;
    if (authorityName === null) increment(summary.unresolvedAuthorityCodes, authorityCode);
    const accumulator = createAccumulator(row, year, country, authorityCode, sourceRowNumber, authorityName, id);
    accumulators.set(id, accumulator);
    if (accumulator.latitude === null || accumulator.longitude === null) summary.invalidCoordinates += 1;
  }
  if (summary.sourceRows.collision === 0) throw new Error(`collision ${year} contains headers but no data rows.`);
  if (summary.englandWalesCollisionRows === 0) throw new Error(`collision ${year} contains no England/Wales source rows.`);

  for (const kind of ['casualty', 'vehicle'] as const) {
    const source = sourceFor(year, kind);
    sourceRowNumber = 0;
    for await (const row of readRows(source.localFile, source)) {
      sourceRowNumber += 1;
      increment(counters.sourceRows, sourceKey(year, kind));
      summary.sourceRows[kind] += 1;
      const id = rowId(row);
      const accumulator = id === null ? undefined : accumulators.get(id);
      if (!accumulator) {
        summary.unmatchedChildRows[kind] += 1;
        increment(counters.unmatchedChildRows, sourceKey(year, kind));
        continue;
      }
      increment(counters.ewRows, sourceKey(year, kind));
      summary.sourceChildRows[kind] += 1;
      const bucket = bucketFor(id as string);
      if (kind === 'casualty') {
        await spool.writeCasualty(bucket, { id: id as string, sourceRowNumber, raw: row });
        accumulator.casualtyRows += 1;
        const reference = childReference(row, ['casualty_reference']);
        if (reference === null) accumulator.missingCasualtyReferences += 1;
        else if (accumulator.casualtyReferences.has(reference)) accumulator.duplicateCasualtyReferences += 1;
        else accumulator.casualtyReferences.add(reference);
        const type = codeValue(row, ['casualty_type']);
        if (type !== null) accumulator.casualtyTypes.add(type);
        if (type === null || !KNOWN_CASUALTY_TYPES.has(type)) accumulator.unknownCasualtyTypes += 1;
        const casualtySeverity = codeValue(row, ['casualty_severity']);
        if (casualtySeverity === 1) accumulator.casualtyFatalities += 1;
        if (casualtySeverity === 2) accumulator.casualtySerious += 1;
        if (casualtySeverity === 3) accumulator.casualtySlight += 1;
        if (casualtySeverity === null || !KNOWN_CASUALTY_SEVERITIES.has(casualtySeverity)) accumulator.unknownCasualtySeverities += 1;
      } else {
        await spool.writeVehicle(bucket, { id: id as string, sourceRowNumber, raw: row });
        accumulator.vehicleRows += 1;
        const reference = childReference(row, ['vehicle_reference']);
        if (reference === null) accumulator.missingVehicleReferences += 1;
        else if (accumulator.vehicleReferences.has(reference)) accumulator.duplicateVehicleReferences += 1;
        else accumulator.vehicleReferences.add(reference);
        const type = codeValue(row, ['vehicle_type']);
        if (type !== null) accumulator.vehicleTypes.add(type);
        if (type === null || !KNOWN_VEHICLE_TYPES.has(type)) accumulator.unknownVehicleTypes += 1;
      }
    }
    if (summary.sourceRows[kind] === 0) throw new Error(`${kind} ${year} contains headers but no data rows.`);
  }

  for (const accumulator of accumulators.values()) {
    const coverage = joinCoverage(accumulator);
    if (coverage.casualtyJoinComplete) summary.collisionsWithCompleteCasualtyJoin += 1;
    if (coverage.vehicleJoinComplete) summary.collisionsWithCompleteVehicleJoin += 1;
    if (coverage.casualtySeverityComplete) summary.collisionsWithCompleteCasualtySeverity += 1;
    if (coverage.casualtyClassificationComplete) summary.collisionsWithCompleteCasualtyClassification += 1;
    if (coverage.vehicleClassificationComplete) summary.collisionsWithCompleteVehicleClassification += 1;
    summary.unknownCasualtyTypes += accumulator.unknownCasualtyTypes;
    summary.unknownCasualtySeverities += accumulator.unknownCasualtySeverities;
    summary.unknownVehicleTypes += accumulator.unknownVehicleTypes;
    summary.duplicateCasualtyChildKeys += accumulator.duplicateCasualtyReferences;
    summary.duplicateVehicleChildKeys += accumulator.duplicateVehicleReferences;
  }
  return { accumulators, summary };
};

const addYearSummary = (target: Record<string, unknown>, year: number, valueToAdd: YearSummary): void => {
  target[String(year)] = valueToAdd;
};

const outputBucket = async (
  bucket: number,
  spoolDirectory: string,
  accumulators: Map<string, CollisionAccumulator>,
  lookup: AuthorityLookup,
  emitted: Set<string>,
  detailsStream: Writable,
  compactStream: Writable,
  yearSummaries: Record<string, YearSummary>,
  byYear: Record<string, MetricSummary>,
  byCountry: Record<string, MetricSummary>,
  byAuthority: Record<string, MetricSummary & { authorityCode: string; authorityName: string | null; country: Country }>,
): Promise<number> => {
  const collisionRows = new Map<string, CollisionSpoolRow[]>();
  const casualtyRows = new Map<string, RawRow[]>();
  const vehicleRows = new Map<string, RawRow[]>();
  const collisionFile = resolve(spoolDirectory, `collision-${bucket}.ndjson`);
  const casualtyFile = resolve(spoolDirectory, `casualty-${bucket}.ndjson`);
  const vehicleFile = resolve(spoolDirectory, `vehicle-${bucket}.ndjson`);
  for await (const record of readJsonLines<CollisionSpoolRow>(collisionFile)) {
    const key = record.id ?? record.key;
    const rows = collisionRows.get(key) ?? [];
    rows.push(record);
    collisionRows.set(key, rows);
  }
  for await (const record of readJsonLines<ChildSpoolRow>(casualtyFile)) {
    const rows = casualtyRows.get(record.id) ?? [];
    rows.push(record.raw);
    casualtyRows.set(record.id, rows);
  }
  for await (const record of readJsonLines<ChildSpoolRow>(vehicleFile)) {
    const rows = vehicleRows.get(record.id) ?? [];
    rows.push(record.raw);
    vehicleRows.set(record.id, rows);
  }

  let compactCount = 0;
  for (const rows of collisionRows.values()) {
    for (const spoolRow of rows) {
      const acc = spoolRow.id === null ? undefined : accumulators.get(spoolRow.id);
      const authorityName = lookup.authorities[spoolRow.authorityCode] ?? null;
      const details = detailFor(spoolRow, acc, spoolRow.id ? casualtyRows.get(spoolRow.id) ?? [] : [], spoolRow.id ? vehicleRows.get(spoolRow.id) ?? [] : [], authorityName);
      await writeLine(detailsStream, JSON.stringify(details));
      if (!acc || emitted.has(acc.id) || acc.latitude === null || acc.longitude === null) continue;
      emitted.add(acc.id);
      await writeLine(compactStream, JSON.stringify(compactFor(acc, authorityName)));
      compactCount += 1;
      const reconciliation = yearSummaries[String(acc.year)];
      if (reconciliation) {
        reconciliation.mappableFeatures += 1;
        reconciliation.mappableChildRows.casualty += acc.casualtyRows;
        reconciliation.mappableChildRows.vehicle += acc.vehicleRows;
      }
      const coverage = joinCoverage(acc);
      const yearMetrics = byYear[String(acc.year)] ?? metricSummary();
      const countryMetrics = byCountry[acc.country] ?? metricSummary();
      const authorityKey = acc.authorityCode;
      const authorityMetrics = byAuthority[authorityKey] ?? {
        ...metricSummary(),
        authorityCode: authorityKey,
        authorityName,
        country: acc.country,
      };
      addMetrics(yearMetrics, acc, coverage);
      addMetrics(countryMetrics, acc, coverage);
      addMetrics(authorityMetrics, acc, coverage);
      byYear[String(acc.year)] = yearMetrics;
      byCountry[acc.country] = countryMetrics;
      byAuthority[authorityKey] = authorityMetrics;
    }
  }
  return compactCount;
};

type VehicleJoinSummary = {
  sourceChildRows: { vehicle: number };
  mappableChildRows: { vehicle: number };
  collisionsWithCompleteVehicleJoin: number;
};

const assertVehicleJoinRegression = (yearSummaries: Record<string, VehicleJoinSummary>): void => {
  for (const year of YEARS) {
    const expected = EXPECTED_REGRESSION.byYear[year];
    const actual = yearSummaries[String(year)];
    if (!actual || actual.sourceChildRows.vehicle !== expected.vehicleJoinedRows || actual.mappableChildRows.vehicle !== expected.mappableVehicleRows || actual.collisionsWithCompleteVehicleJoin !== expected.completeVehicleJoins) {
      throw new Error(`National vehicle join regression mismatch for ${year}: ${JSON.stringify({ joined: actual?.sourceChildRows.vehicle, mappable: actual?.mappableChildRows.vehicle, complete: actual?.collisionsWithCompleteVehicleJoin })}`);
    }
  }
};

const assertRegression = (
  compactCount: number,
  yearSummaries: Record<string, YearSummary>,
  byYear: Record<string, MetricSummary>,
  byCountry: Record<string, MetricSummary>,
): void => {
  assertVehicleJoinRegression(yearSummaries);
  const totalInvalidCoordinates = YEARS.reduce((sum, year) => sum + (yearSummaries[String(year)]?.invalidCoordinates ?? 0), 0);
  const totalMappableCasualties = Object.values(byYear).reduce((sum, metrics) => sum + metrics.casualtyCount, 0);
  const totalFatalities = Object.values(byCountry).reduce((sum, metrics) => sum + metrics.fatalities, 0);
  const totalSeriousCasualties = Object.values(byCountry).reduce((sum, metrics) => sum + metrics.seriousCasualties, 0);
  const totalSlightCasualties = Object.values(byCountry).reduce((sum, metrics) => sum + metrics.slightCasualties, 0);
  const actual = {
    totalEnglandWalesCollisionRows: YEARS.reduce((sum, year) => sum + (yearSummaries[String(year)]?.englandWalesCollisionRows ?? 0), 0),
    totalMappableFeatures: compactCount,
    totalInvalidCoordinates,
    totalMappableCasualties,
    totalFatalities,
    totalSeriousCasualties,
    totalSlightCasualties,
  };
  const totalKeys = ['totalEnglandWalesCollisionRows', 'totalMappableFeatures', 'totalInvalidCoordinates', 'totalMappableCasualties', 'totalFatalities', 'totalSeriousCasualties', 'totalSlightCasualties'] as const;
  for (const key of totalKeys) {
    const expected = EXPECTED_REGRESSION[key];
    if (actual[key] !== expected) throw new Error(`National regression mismatch for ${key}: expected ${expected}, got ${actual[key]}`);
  }
  for (const year of YEARS) {
    const expected = EXPECTED_REGRESSION.byYear[year];
    const actualYear = yearSummaries[String(year)];
    const actualMetrics = byYear[String(year)];
    if (!actualYear || !actualMetrics || actualYear.englandWalesCollisionRows !== expected.englandWalesCollisionRows || actualYear.mappableFeatures !== expected.mappableFeatures || actualYear.invalidCoordinates !== expected.invalidCoordinates || actualMetrics.casualtyCount !== expected.mappableCasualties || actualYear.mappableChildRows.vehicle !== expected.mappableVehicleRows || actualYear.sourceChildRows.vehicle !== expected.vehicleJoinedRows || actualYear.collisionsWithCompleteVehicleJoin !== expected.completeVehicleJoins) {
      throw new Error(`National annual regression mismatch for ${year}: ${JSON.stringify({ source: actualYear?.englandWalesCollisionRows, mapped: actualYear?.mappableFeatures, invalid: actualYear?.invalidCoordinates, casualties: actualMetrics?.casualtyCount, vehicleJoined: actualYear?.sourceChildRows.vehicle, vehicleMappable: actualYear?.mappableChildRows.vehicle, completeVehicleJoins: actualYear?.collisionsWithCompleteVehicleJoin })}`);
    }
  }
};

const sourceManifest = async (
  counters: SourceCounters,
  acquisition: Record<string, InputAcquisition>,
): Promise<Array<Record<string, unknown>>> => {
  const files: Array<Record<string, unknown>> = [];
  for (const source of allSources) {
    const fileStats = await stat(source.localFile);
    const digest = await hashFile(source.localFile);
    const key = sourceKey(source.year, source.kind);
    if ((counters.sourceRows[key] ?? 0) === 0) throw new Error(`No rows were read from ${source.kind} ${source.year}; refusing to publish.`);
    files.push({
      year: source.year,
      kind: source.kind,
      canonicalUrl: source.canonicalUrl,
      retrievalUrl: acquisition[key]?.sourceUrl ?? null,
      localFile: `data/raw/${source.kind}-${source.year}.csv`,
      sha256: digest.sha256,
      bytes: fileStats.size,
      localFileModifiedAt: fileStats.mtime.toISOString(),
      sourceRows: counters.sourceRows[key] ?? 0,
      englandWalesRows: counters.ewRows[key] ?? 0,
      unmatchedChildRows: counters.unmatchedChildRows[key] ?? 0,
      cacheStatus: acquisition[key]?.status ?? 'unknown',
      retrievedAt: acquisition[key]?.retrievedAt ?? null,
      httpEtag: acquisition[key]?.etag ?? null,
      httpLastModified: acquisition[key]?.lastModified ?? null,
    });
  }
  return files;
};

type AliasEntry = { exists: boolean; symlink: boolean; target?: string };

const inspectAliasEntry = async (file: string): Promise<AliasEntry> => {
  try {
    const metadata = await lstat(file);
    return {
      exists: true,
      symlink: metadata.isSymbolicLink(),
      target: metadata.isSymbolicLink() ? await readlink(file) : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, symlink: false };
    throw error;
  }
};

const publishStableAliasAt = async (outputAliasDir: string, generationsDir: string, datasetVersion: string, buildId: string): Promise<void> => {
  const artifacts = ['manifest.json', 'summary.json', 'collisions.ndjson', 'details.ndjson', 'authority-lookup.json'];
  const migrationMessage = (detail: string): Error => new Error(
    `Cannot publish national alias layout at ${outputAliasDir}: ${detail}. ` +
    `Refusing automatic alias migration; manually migrate to a current symlink plus ${artifacts.map((artifact) => `current/${artifact}`).join(', ')} aliases, then retry.`,
  );
  const generationDir = resolve(generationsDir, datasetVersion);
  let generationStats;
  try {
    generationStats = await stat(generationDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Cannot publish national generation ${datasetVersion}: directory is missing at ${generationDir}`);
    throw error;
  }
  if (!generationStats.isDirectory()) throw new Error(`Cannot publish national generation ${datasetVersion}: ${generationDir} is not a directory`);
  for (const artifact of artifacts) {
    const artifactPath = resolve(generationDir, artifact);
    let artifactStats;
    try {
      artifactStats = await stat(artifactPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Cannot publish national generation ${datasetVersion}: required artifact is missing at ${artifactPath}`);
      throw error;
    }
    if (!artifactStats.isFile() || artifactStats.size === 0) throw new Error(`Cannot publish national generation ${datasetVersion}: required artifact is not a non-empty file at ${artifactPath}`);
  }

  await mkdir(outputAliasDir, { recursive: true });
  const current = resolve(outputAliasDir, 'current');
  const currentEntry = await inspectAliasEntry(current);
  const artifactEntries = await Promise.all(artifacts.map(async (artifact) => ({ artifact, entry: await inspectAliasEntry(resolve(outputAliasDir, artifact)) })));
  const anyArtifact = artifactEntries.some(({ entry }) => entry.exists);
  const initialLayout = !currentEntry.exists && !anyArtifact;
  if (!initialLayout) {
    if (!currentEntry.exists) throw migrationMessage('current is missing while one or more artifact aliases already exist');
    if (!currentEntry.symlink) throw migrationMessage('current is a regular entry rather than a symlink');
    try {
      const currentTarget = await stat(current);
      if (!currentTarget.isDirectory()) throw migrationMessage('current does not resolve to a directory');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot publish national alias layout')) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw migrationMessage('current is a dangling symlink');
      throw error;
    }
    for (const { artifact, entry } of artifactEntries) {
      if (!entry.exists) throw migrationMessage(`alias ${artifact} is missing`);
      if (!entry.symlink || entry.target !== `current/${artifact}`) throw migrationMessage(`alias ${artifact} is not the canonical current/${artifact} symlink`);
    }
  }

  // In a new directory, establish the canonical artifact aliases before
  // advancing current. Existing legacy or incomplete layouts are rejected
  // above instead of being partially migrated.
  if (initialLayout) {
    for (const artifact of artifacts) {
      const target = resolve(outputAliasDir, artifact);
      const next = `${target}.next-${buildId}`;
      await symlink(`current/${artifact}`, next);
      await rename(next, target);
    }
  }

  const currentNext = resolve(outputAliasDir, `current.next-${buildId}`);
  await symlink(relative(outputAliasDir, generationDir), currentNext, 'dir');
  // `current` is the sole publication pointer. rename replaces the old
  // symlink atomically; it never unlinks the reader-visible target first.
  await rename(currentNext, current);
};

const publishStableAlias = async (datasetVersion: string, buildId: string): Promise<void> => publishStableAliasAt(OUTPUT_ALIAS_DIR, GENERATIONS_DIR, datasetVersion, buildId);

const buildUnlocked = async (): Promise<void> => {
  const buildId = randomUUID();
  const acquisition = await ensureInputs();
  const lookup = await loadAuthorityLookup();
  await mkdir(NATIONAL_DIR, { recursive: true });
  const workDir = resolve(NATIONAL_DIR, `.tmp-build-${buildId}`);
  const spoolDir = resolve(workDir, 'spool');
  const spool = new BucketSpool(spoolDir);
  await spool.open();
  const counters: SourceCounters = { sourceRows: {}, ewRows: {}, unmatchedChildRows: {} };
  const accumulators = new Map<string, CollisionAccumulator>();
  const yearSummaries: Record<string, YearSummary> = {};
  for (const year of YEARS) {
    const result = await processYear(year, lookup, counters, spool);
    for (const [id, accumulator] of result.accumulators) accumulators.set(id, accumulator);
    addYearSummary(yearSummaries, year, result.summary);
  }
  await spool.close();

  const sourceFiles = await sourceManifest(counters, acquisition);
  const acquisitionSidecar: Record<string, unknown> = {};
  for (const file of sourceFiles) {
    acquisitionSidecar[`${file.kind}:${file.year}`] = {
      bytes: file.bytes,
      localFileModifiedAt: file.localFileModifiedAt,
      sha256: file.sha256,
      retrievedAt: file.retrievedAt,
      etag: file.httpEtag,
      lastModified: file.httpLastModified,
      sourceUrl: file.retrievalUrl,
    };
  }
  await writeJsonAtomically(ACQUISITION_FILE, acquisitionSidecar, buildId);
  const sourceFingerprint = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 'weca-national-manifest/v1', years: YEARS, sourceFiles: sourceFiles.map((file) => ({ year: file.year, kind: file.kind, sha256: file.sha256 })) }))
    .digest('hex');
  const builderFingerprint = (await hashFile(resolve('scripts/national/build.ts'))).sha256;
  const codebookFingerprint = (await hashFile(resolve('scripts/national/codebook.ts'))).sha256;
  const ingestionHelpersFingerprint = (await hashFile(resolve('scripts/ingest-stats19.ts'))).sha256;
  const authorityLookupFingerprint = createHash('sha256')
    .update(JSON.stringify({ sourceUrls: lookup.sourceUrls, authorities: lookup.authorities }))
    .digest('hex');
  const fingerprints = {
    sourceFiles: sourceFingerprint,
    builder: builderFingerprint,
    codebook: codebookFingerprint,
    ingestionHelpers: ingestionHelpersFingerprint,
    authorityLookup: authorityLookupFingerprint,
  };
  const datasetVersion = `england-wales-stats19-2021-2025-${sourceFingerprint.slice(0, 12)}-${builderFingerprint.slice(0, 8)}-${codebookFingerprint.slice(0, 8)}-${ingestionHelpersFingerprint.slice(0, 8)}-${authorityLookupFingerprint.slice(0, 8)}`;
  const stagingDir = resolve(GENERATIONS_DIR, `.${datasetVersion}.staging-${buildId}`);
  const generationDir = resolve(GENERATIONS_DIR, datasetVersion);
  await mkdir(GENERATIONS_DIR, { recursive: true });
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const detailsPartial = resolve(stagingDir, 'details.ndjson.partial');
  const compactPartial = resolve(stagingDir, 'collisions.ndjson.partial');
  const detailsStream = createWriteStream(detailsPartial);
  const compactStream = createWriteStream(compactPartial);
  const byYear: Record<string, MetricSummary> = {};
  const byCountry: Record<string, MetricSummary> = { England: metricSummary(), Wales: metricSummary() };
  const byAuthority: Record<string, MetricSummary & { authorityCode: string; authorityName: string | null; country: Country }> = {};
  const emitted = new Set<string>();
  let compactCount = 0;
  for (let bucket = 0; bucket < BUCKET_COUNT; bucket += 1) {
    compactCount += await outputBucket(bucket, spoolDir, accumulators, lookup, emitted, detailsStream, compactStream, yearSummaries, byYear, byCountry, byAuthority);
  }
  await finishStream(detailsStream);
  await finishStream(compactStream);
  await rename(detailsPartial, resolve(stagingDir, 'details.ndjson'));
  await rename(compactPartial, resolve(stagingDir, 'collisions.ndjson'));

  const totalSourceCollisionRows = YEARS.reduce((sum, year) => sum + (counters.sourceRows[sourceKey(year, 'collision')] ?? 0), 0);
  const totalEwCollisionRows = YEARS.reduce((sum, year) => sum + (counters.ewRows[sourceKey(year, 'collision')] ?? 0), 0);
  const totalInvalidCoordinates = YEARS.reduce((sum, year) => sum + (yearSummaries[String(year)]?.invalidCoordinates ?? 0), 0);
  const totalMissingIds = YEARS.reduce((sum, year) => sum + (yearSummaries[String(year)]?.missingCollisionIds ?? 0), 0);
  const totalDuplicateRows = YEARS.reduce((sum, year) => sum + (yearSummaries[String(year)]?.duplicateCollisionRows ?? 0), 0);
  assertRegression(compactCount, yearSummaries, byYear, byCountry);
  const unresolvedAuthorityCodes: Record<string, number> = {};
  for (const year of YEARS) {
    for (const [code, count] of Object.entries(yearSummaries[String(year)]?.unresolvedAuthorityCodes ?? {})) increment(unresolvedAuthorityCodes, code, count);
  }
  const summary = {
    schemaVersion: 'weca-national-summary/v1',
    datasetVersion,
    fingerprints,
    generatedAt: new Date().toISOString(),
    includedYears: [...YEARS],
    scope: {
      countries: ['England', 'Wales'],
      authorityCodeRule: 'STATS19 local_authority_ons_district (fallback local_authority_highway_current/local_authority_highway) beginning E or W',
      sourceCollisionRows: totalSourceCollisionRows,
      englandWalesCollisionRows: totalEwCollisionRows,
      mappableFeatures: compactCount,
      invalidCoordinates: totalInvalidCoordinates,
      missingCollisionIds: totalMissingIds,
      duplicateCollisionRows: totalDuplicateRows,
      unresolvedAuthorityCodes,
      noPolygonFallback: true,
    },
    sourceRows: {
      total: Object.values(counters.sourceRows).reduce((sum, count) => sum + count, 0),
      byYear: Object.fromEntries(YEARS.map((year) => [String(year), yearSummaries[String(year)]?.sourceRows])),
      byKind: Object.fromEntries((['collision', 'casualty', 'vehicle'] as DatasetKind[]).map((kind) => [kind, YEARS.reduce((sum, year) => sum + (counters.sourceRows[sourceKey(year, kind)] ?? 0), 0)])),
    },
    childReconciliation: {
      joinedEnglandWalesRows: {
        casualty: YEARS.reduce((sum, year) => sum + (counters.ewRows[sourceKey(year, 'casualty')] ?? 0), 0),
        vehicle: YEARS.reduce((sum, year) => sum + (counters.ewRows[sourceKey(year, 'vehicle')] ?? 0), 0),
      },
      unmatchedRows: {
        casualty: YEARS.reduce((sum, year) => sum + (counters.unmatchedChildRows[sourceKey(year, 'casualty')] ?? 0), 0),
        vehicle: YEARS.reduce((sum, year) => sum + (counters.unmatchedChildRows[sourceKey(year, 'vehicle')] ?? 0), 0),
      },
    },
    byYear: byYear,
    byCountry: byCountry,
    byAuthority,
    reconciliationByYear: yearSummaries,
    definitions: {
      fatalitiesAndSeriousCasualties: 'Derived from joined casualty rows only when the casualty join and all casualty severity values are complete.',
      involvement: 'Pedestrian from casualty_type 0; cyclist from vehicle_type 1; motorcycle from vehicle_type 2, 3, 4, 5, 23 or 97. Unknown remains null.',
      mappableFeatures: 'Unique England/Wales collision IDs with coordinates passing the existing STATS19 geographic bounds check.',
    },
  };
  await writeFile(resolve(stagingDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(resolve(stagingDir, 'authority-lookup.json'), `${JSON.stringify(lookup, null, 2)}\n`, 'utf8');
  const artifactHashes: Record<string, string> = {};
  for (const artifact of ['collisions.ndjson', 'details.ndjson', 'summary.json', 'authority-lookup.json']) {
    artifactHashes[artifact] = (await hashFile(resolve(stagingDir, artifact))).sha256;
  }

  const manifest = {
    schemaVersion: 'weca-national-manifest/v1',
    datasetVersion,
    generatedAt: summary.generatedAt,
    fingerprints,
    source: 'Department for Transport STATS19 road safety open data',
    sourceUrl: DATASET_URL,
    codebookUrl: CODEBOOK_URL,
    licence: 'Open Government Licence v3.0',
    licenceUrl: LICENCE_URL,
    includedYears: [...YEARS],
    countries: ['England', 'Wales'],
    authorityLookup: lookup,
    sourceFiles,
    artifactHashes,
    artifacts: {
      compact: 'collisions.ndjson',
      details: 'details.ndjson',
      summary: 'summary.json',
      authorityLookup: 'authority-lookup.json',
    },
    counts: {
      sourceCollisionRows: totalSourceCollisionRows,
      englandWalesCollisionRows: totalEwCollisionRows,
      mappableFeatures: compactCount,
      detailRows: totalEwCollisionRows,
      invalidCoordinates: totalInvalidCoordinates,
      missingCollisionIds: totalMissingIds,
      duplicateCollisionRows: totalDuplicateRows,
    },
    processingSteps: [
      'Read cached annual collision, casualty and vehicle CSVs as streaming UTF-8 records.',
      'Validated required headers and collision_year values for every annual source before publication.',
      'Selected England and Wales by the STATS19 ONS authority-code prefix E or W.',
      'Joined casualty and vehicle records by collision_index within each calendar year.',
      'Wrote compact mappable records separately from full joined source evidence.',
      'Kept coordinate exclusions and nullable classification coverage in the reconciliation summary.',
      'Published the complete artifact set under a content-addressed generation and atomically advanced the current alias pointer.',
    ],
    limitations: [
      'STATS19 covers reported personal-injury collisions on public roads, not every road incident.',
      'Country assignment uses the source authority-code prefix; no polygon fallback is applied.',
      'Collision rows without valid coordinates are retained in details but excluded from collisions.ndjson.',
      'Unknown and incomplete source classifications remain nullable; they are not imputed.',
      'The compact and details NDJSON artifacts are generated outputs and are intentionally excluded from version control.',
    ],
    codebookNotes: [...CODEBOOK_NOTES],
  };
  await writeFile(resolve(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const artifact of ['manifest.json', 'summary.json', 'collisions.ndjson', 'details.ndjson', 'authority-lookup.json']) {
    const artifactStats = await stat(resolve(stagingDir, artifact));
    if (!artifactStats.isFile() || artifactStats.size === 0) throw new Error(`Generated artifact ${artifact} is empty; refusing to publish.`);
  }
  let reuseExistingGeneration = false;
  try {
    const existingManifest = JSON.parse(await readFile(resolve(generationDir, 'manifest.json'), 'utf8')) as { datasetVersion?: string; artifactHashes?: Record<string, string> };
    if (existingManifest.datasetVersion !== datasetVersion) throw new Error(`Generation path collision at ${generationDir}`);
    for (const artifact of ['manifest.json', 'summary.json', 'collisions.ndjson', 'details.ndjson', 'authority-lookup.json']) {
      const existingStats = await stat(resolve(generationDir, artifact));
      if (!existingStats.isFile() || existingStats.size === 0) throw new Error(`Existing generation is incomplete: ${resolve(generationDir, artifact)}`);
      const expectedHash = existingManifest.artifactHashes?.[artifact];
      if (expectedHash && (await hashFile(resolve(generationDir, artifact))).sha256 !== expectedHash) throw new Error(`Existing generation hash mismatch: ${resolve(generationDir, artifact)}`);
    }
    reuseExistingGeneration = true;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (reuseExistingGeneration) await rm(stagingDir, { recursive: true, force: true });
  else await rename(stagingDir, generationDir);
  await publishStableAlias(datasetVersion, buildId);
  await rm(workDir, { recursive: true, force: true });

  const detailStats = await stat(resolve(generationDir, 'details.ndjson'));
  const compactStats = await stat(resolve(generationDir, 'collisions.ndjson'));
  console.log(`Generated ${compactCount.toLocaleString()} compact England/Wales collisions.`);
  console.log(`Wrote ${totalEwCollisionRows.toLocaleString()} detail rows (${(detailStats.size / 1_000_000).toFixed(1)} MB).`);
  console.log(`Wrote compact collisions (${(compactStats.size / 1_000_000).toFixed(1)} MB).`);
};

const main = async (): Promise<void> => {
  await mkdir(NATIONAL_DIR, { recursive: true });
  const releaseLock = await acquireExclusiveDirectoryLock(BUILD_LOCK_DIR);
  try {
    await buildUnlocked();
  } finally {
    await releaseLock();
  }
};

export { acquireExclusiveDirectoryLock, assertVehicleJoinRegression, main, publishStableAliasAt };

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
