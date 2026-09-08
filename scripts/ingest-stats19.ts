import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pathToFileURL } from 'node:url';
import { parse } from 'csv-parse';
import type {
  CollisionCollection,
  CollisionRecord,
  Stats19CasualtyRecord,
  Stats19Provenance,
  Stats19SourceFile,
  Stats19VehicleRecord,
} from '../src/domain/types';

export type RawRow = Record<string, string>;
type DatasetKind = 'collision' | 'vehicle' | 'casualty';

const YEARS = [2020, 2021, 2022, 2023, 2024] as const;
const RAW_DIR = resolve('data/raw');
const OUTPUT_DIR = resolve('public/data');
const DFT_BASE = 'https://data.dft.gov.uk/road-accidents-safety-data';
const LICENCE_URL = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';
const DATASET_URL = 'https://www.gov.uk/government/statistical-data-sets/road-safety-open-data';
const CODEBOOK_URL = 'https://assets.publishing.service.gov.uk/media/6a63900b2dc18ebe4c3b2bc8/dft-road-casualty-statistics-road-safety-open-dataset-data-guide-2025.xlsx';

const AUTHORITY_BY_CODE: Record<string, string> = {
  E06000022: 'Bath and North East Somerset',
  E06000023: 'Bristol',
  E06000024: 'North Somerset',
  E06000025: 'South Gloucestershire',
};

const TARGET_AUTHORITY_CODES = new Set(Object.keys(AUTHORITY_BY_CODE));
const PEDESTRIAN_CASUALTY_TYPES = new Set([0]);
const CYCLIST_VEHICLE_TYPES = new Set([1]);
const MOTORCYCLE_VEHICLE_TYPES = new Set([2, 3, 4, 5, 23, 97]);
const KNOWN_CASUALTY_TYPES = new Set([0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23, 90, 97, 98]);
const KNOWN_VEHICLE_TYPES = new Set([1, 2, 3, 4, 5, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23, 90, 97, 98]);

interface InputSource {
  year: number;
  kind: DatasetKind;
  canonicalUrl: string;
  retrievalUrl: string;
  localFile: string;
}

export interface CollisionAccumulator {
  id: string;
  year: number;
  raw: RawRow;
  authorityCode: string;
  authority: string;
  latitude: number;
  longitude: number;
  rawCasualties: number | null;
  rawVehicles: number | null;
  casualtyRows: number;
  casualtyFatalities: number;
  casualtySerious: number;
  casualtyTypes: Set<number>;
  vehicleRows: number;
  vehicleTypes: Set<number>;
  unknownCasualtyTypes: number;
  unknownCasualtySeverities: number;
  unknownVehicleTypes: number;
  missingCasualtyReferences: number;
  missingVehicleReferences: number;
  casualtyReferences: Set<string>;
  vehicleReferences: Set<string>;
  duplicateCasualtyReferences: number;
  duplicateVehicleReferences: number;
  casualtyRecords: Stats19CasualtyRecord[];
  vehicleRecords: Stats19VehicleRecord[];
}

interface YearResult {
  records: CollisionRecord[];
  sourceRows: Record<DatasetKind, number>;
  regionalRows: Record<DatasetKind, number>;
  casualtyRowsUnmatched: number;
  vehicleRowsUnmatched: number;
  completeCasualtyJoins: number;
  completeVehicleJoins: number;
  completeCasualtySeverity: number;
  completePedestrianClassifications: number;
  completeCasualtyClassifications: number;
  completeVehicleClassifications: number;
  unknownCasualtySeverities: number;
  duplicateCollisionIds: number;
  duplicateCasualtyChildKeys: number;
  duplicateVehicleChildKeys: number;
  invalidCollisionRows: number;
  missingCoordinates: number;
}

const sourceFor = (year: number, kind: DatasetKind): InputSource => {
  const filename = `dft-road-casualty-statistics-${kind}-${year}.csv`;
  const canonicalUrl = `${DFT_BASE}/${filename}`;
  // The live DfT directory currently retains only the newest annual files. The
  // 2020 final file is pinned to an immutable replay of the DfT-hosted object.
  // This is kept as a retrieval URL so refreshes cannot silently change the
  // historical input while the canonical provenance remains the DfT URL.
  const retrievalUrl = year === 2020
    ? ({
        collision: 'https://web.archive.org/web/20250404042402id_/https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-collision-2020.csv',
        vehicle: 'https://web.archive.org/web/20250403053929id_/https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-vehicle-2020.csv',
        casualty: 'https://web.archive.org/web/20250123075344id_/https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-casualty-2020.csv',
      }[kind])
    : canonicalUrl;
  return {
    year,
    kind,
    canonicalUrl,
    retrievalUrl,
    localFile: resolve(RAW_DIR, `${kind}-${year}.csv`),
  };
};

const sources = YEARS.flatMap((year) => (['collision', 'vehicle', 'casualty'] as DatasetKind[]).map((kind) => sourceFor(year, kind)));

export const value = (row: RawRow, keys: string[]): string | null => {
  for (const key of keys) {
    const candidate = row[key];
    if (candidate !== undefined && candidate !== null && candidate.trim() !== '' && candidate.trim().toUpperCase() !== 'NULL') {
      return candidate.trim();
    }
  }
  return null;
};

export const numberValue = (row: RawRow, keys: string[]): number | null => {
  const raw = value(row, keys);
  if (raw === null || raw === '-1') return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
};

/** Parse a coded STATS19 value without treating 99/999 as universal sentinels. */
export const codeValue = (row: RawRow, keys: string[]): number | null => {
  const raw = value(row, keys);
  if (raw === null) return null;
  const number = Number(raw);
  return Number.isInteger(number) ? number : null;
};

const childReference = (row: RawRow, keys: string[]): string | null => {
  const reference = value(row, keys);
  if (reference === null) return null;
  if (!/^\d+$/.test(reference)) return null;
  const numeric = Number(reference);
  return Number.isFinite(numeric) && numeric >= 1 ? reference : null;
};

export const integerValue = (row: RawRow, keys: string[]): number | null => {
  const number = numberValue(row, keys);
  return number === null || !Number.isInteger(number) ? null : number;
};

export const rowId = (row: RawRow): string | null => value(row, ['collision_index', 'accident_index', 'collision_id', 'accident_id']);

export const rowYear = (row: RawRow, fallback: number): number => integerValue(row, ['collision_year', 'accident_year']) ?? fallback;

export const isoDate = (row: RawRow): string | null => {
  const raw = value(row, ['date', 'collision_date', 'accident_date']);
  if (raw === null) return null;
  const dayFirst = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso?.[1] ?? null;
};

export const severity = (row: RawRow): CollisionRecord['severity'] => {
  const code = codeValue(row, ['collision_severity', 'accident_severity']);
  if (code === 1) return 'fatal';
  if (code === 2) return 'serious';
  if (code === 3) return 'slight';
  return 'unknown';
};

export const roadNumber = (row: RawRow): string | null => {
  const roads = [
    { number: integerValue(row, ['first_road_number']), roadClass: integerValue(row, ['first_road_class']) },
    { number: integerValue(row, ['second_road_number']), roadClass: integerValue(row, ['second_road_class']) },
  ];
  const selected = roads.find((road) => road.number !== null && road.number > 0);
  if (!selected || selected.number === null) return null;
  const roadClass = selected.roadClass;
  const prefix = roadClass === 1 ? 'M' : roadClass === 2 ? 'A(M)' : roadClass === 3 ? 'A' : roadClass === 4 ? 'B' : '';
  return `${prefix}${selected.number}`;
};

const speedLimit = (row: RawRow): number | null => {
  const limit = integerValue(row, ['speed_limit']);
  return limit !== null && limit > 0 && limit < 100 ? limit : null;
};

export const codedText = (row: RawRow, keys: string[]): string | null => {
  const code = integerValue(row, keys);
  return code === null ? null : String(code);
};

export const coordinate = (row: RawRow): { latitude: number; longitude: number } | null => {
  const latitude = numberValue(row, ['latitude']);
  const longitude = numberValue(row, ['longitude']);
  if (latitude === null || longitude === null || latitude < 49 || latitude > 61 || longitude < -9 || longitude > 3) return null;
  return { latitude, longitude };
};

/**
 * Turn one collision accumulator and its joined rows into the public model.
 * Keeping this boundary pure makes schema changes and incomplete joins
 * testable without downloading the national source files.
 */
export const finalizeCollision = (collision: CollisionAccumulator): CollisionRecord => {
  const casualtyJoinComplete = collision.rawCasualties !== null && collision.casualtyRows === collision.rawCasualties &&
    collision.casualtyReferences.size === collision.casualtyRows && collision.missingCasualtyReferences === 0 && collision.duplicateCasualtyReferences === 0;
  const vehicleJoinComplete = collision.rawVehicles !== null && collision.vehicleRows === collision.rawVehicles &&
    collision.vehicleReferences.size === collision.vehicleRows && collision.missingVehicleReferences === 0 && collision.duplicateVehicleReferences === 0;
  const casualtyTypeComplete = casualtyJoinComplete && collision.unknownCasualtyTypes === 0;
  const casualtySeverityComplete = casualtyJoinComplete && collision.unknownCasualtySeverities === 0;
  const casualtyClassificationComplete = casualtyTypeComplete && casualtySeverityComplete;
  const vehicleClassificationComplete = vehicleJoinComplete && collision.unknownVehicleTypes === 0;

  // Counts of all casualties are available on the collision row. Severity
  // breakdowns require complete joined rows and known casualty severities;
  // an unknown road-user type does not erase a known severity count.
  const casualtyCount = collision.rawCasualties;
  const fatalities = casualtySeverityComplete ? collision.casualtyFatalities : null;
  const seriousCasualties = casualtySeverityComplete ? collision.casualtySerious : null;
  const ksiCasualties = casualtySeverityComplete ? collision.casualtyFatalities + collision.casualtySerious : null;

  // Pedestrians have no vehicle row. A negative answer is only emitted when
  // the casualty join is complete; a partial join cannot establish absence.
  const pedestrianInvolved: CollisionRecord['pedestrianInvolved'] = casualtyTypeComplete
    ? [...collision.casualtyTypes].some((type) => PEDESTRIAN_CASUALTY_TYPES.has(type))
    : [...collision.casualtyTypes].some((type) => PEDESTRIAN_CASUALTY_TYPES.has(type)) ? true : null;
  const cycleInvolved: CollisionRecord['cycleInvolved'] = vehicleClassificationComplete
    ? [...collision.vehicleTypes].some((type) => CYCLIST_VEHICLE_TYPES.has(type))
    : [...collision.vehicleTypes].some((type) => CYCLIST_VEHICLE_TYPES.has(type)) ? true : null;
  const motorcycleInvolved: CollisionRecord['motorcycleInvolved'] = vehicleClassificationComplete
    ? [...collision.vehicleTypes].some((type) => MOTORCYCLE_VEHICLE_TYPES.has(type))
    : [...collision.vehicleTypes].some((type) => MOTORCYCLE_VEHICLE_TYPES.has(type)) ? true : null;

  return {
    id: collision.id,
    date: isoDate(collision.raw),
    year: collision.year,
    latitude: collision.latitude,
    longitude: collision.longitude,
    severity: severity(collision.raw),
    localAuthority: collision.authority,
    roadName: null,
    roadNumber: roadNumber(collision.raw),
    speedLimit: speedLimit(collision.raw),
    junctionDetail: codedText(collision.raw, ['junction_detail']),
    casualtyCount,
    fatalities,
    seriousCasualties,
    ksiCasualties,
    pedestrianInvolved,
    cycleInvolved,
    motorcycleInvolved,
    sourceProperties: {
      source: 'DfT STATS19',
      sourceYear: collision.year,
      sourceId: collision.id,
      authorityCode: collision.authorityCode,
      time: value(collision.raw, ['time']),
      collisionSeverityCode: codeValue(collision.raw, ['collision_severity', 'accident_severity']),
      rawCasualtyCount: collision.rawCasualties,
      rawVehicleCount: collision.rawVehicles,
      casualtyRowsJoined: collision.casualtyRows,
      vehicleRowsJoined: collision.vehicleRows,
      casualtyJoinComplete,
      vehicleJoinComplete,
      casualtyTypeComplete,
      casualtySeverityComplete,
      casualtyClassificationComplete,
      vehicleClassificationComplete,
      unknownCasualtyTypes: collision.unknownCasualtyTypes,
      unknownCasualtySeverities: collision.unknownCasualtySeverities,
      unknownVehicleTypes: collision.unknownVehicleTypes,
      missingCasualtyReferences: collision.missingCasualtyReferences,
      missingVehicleReferences: collision.missingVehicleReferences,
      duplicateCasualtyReferences: collision.duplicateCasualtyReferences,
      duplicateVehicleReferences: collision.duplicateVehicleReferences,
      casualtyTypeCodes: [...collision.casualtyTypes].sort((left, right) => left - right),
      vehicleTypeCodes: [...collision.vehicleTypes].sort((left, right) => left - right),
      casualtyRecords: collision.casualtyRecords,
      vehicleRecords: collision.vehicleRecords,
    },
  };
};

const readRows = async function* (file: string): AsyncGenerator<RawRow> {
  const parser = createReadStream(file).pipe(parse({
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }));
  for await (const row of parser) yield row as RawRow;
};

const hashFile = async (file: string): Promise<{ bytes: number; sha256: string }> => {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
};

const ensureInput = async (source: InputSource): Promise<void> => {
  try {
    const existing = await stat(source.localFile);
    if (existing.isFile() && existing.size > 0) return;
  } catch {
    // The national source is downloaded below when the ignored raw file is absent.
  }
  console.log(`Downloading ${source.kind} ${source.year} from ${source.retrievalUrl}`);
  const response = await fetch(source.retrievalUrl);
  if (!response.ok || response.body === null) {
    throw new Error(`Unable to download ${source.retrievalUrl}: HTTP ${response.status}`);
  }
  const partialFile = `${source.localFile}.partial`;
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), createWriteStream(partialFile));
  await rename(partialFile, source.localFile);
};

const ensureInputs = async (): Promise<void> => {
  await mkdir(RAW_DIR, { recursive: true });
  for (const source of sources) await ensureInput(source);
};

const buildSourceManifest = async (sourceRows: Record<string, number>, regionalRows: Record<string, number>): Promise<Stats19SourceFile[]> => {
  const manifest: Stats19SourceFile[] = [];
  for (const source of sources) {
    const fileStats = await stat(source.localFile);
    const digest = await hashFile(source.localFile);
    manifest.push({
      year: source.year,
      kind: source.kind,
      canonicalUrl: source.canonicalUrl,
      retrievalUrl: source.retrievalUrl,
      localFile: `data/raw/${source.kind}-${source.year}.csv`,
      sha256: digest.sha256,
      bytes: fileStats.size,
      localFileModifiedAt: fileStats.mtime.toISOString(),
      sourceRows: sourceRows[`${source.kind}:${source.year}`] ?? 0,
      regionalRows: regionalRows[`${source.kind}:${source.year}`] ?? 0,
    });
  }
  return manifest;
};

const readYear = async (year: number, sourceRows: Record<string, number>, regionalRows: Record<string, number>): Promise<YearResult> => {
  const collisionSource = sourceFor(year, 'collision');
  const collisions = new Map<string, CollisionAccumulator>();
  const seenCollisionIds = new Set<string>();
  let invalidCollisionRows = 0;
  let missingCoordinates = 0;
  let duplicateCollisionIds = 0;

  for await (const row of readRows(collisionSource.localFile)) {
    sourceRows[`collision:${year}`] = (sourceRows[`collision:${year}`] ?? 0) + 1;
    const authorityCode = value(row, ['local_authority_ons_district', 'local_authority_highway_current', 'local_authority_highway']);
    if (authorityCode === null || !TARGET_AUTHORITY_CODES.has(authorityCode)) continue;
    regionalRows[`collision:${year}`] = (regionalRows[`collision:${year}`] ?? 0) + 1;
    const id = rowId(row);
    const duplicate = id !== null && seenCollisionIds.has(id);
    if (id !== null) seenCollisionIds.add(id);
    const point = coordinate(row);
    if (id === null || point === null) {
      invalidCollisionRows += 1;
      if (point === null) missingCoordinates += 1;
      if (duplicate) duplicateCollisionIds += 1;
      continue;
    }
    if (duplicate) {
      duplicateCollisionIds += 1;
      continue;
    }
    collisions.set(id, {
      id,
      year: rowYear(row, year),
      raw: row,
      authorityCode,
      authority: AUTHORITY_BY_CODE[authorityCode],
      latitude: point.latitude,
      longitude: point.longitude,
      rawCasualties: integerValue(row, ['number_of_casualties']),
      rawVehicles: integerValue(row, ['number_of_vehicles']),
      casualtyRows: 0,
      casualtyFatalities: 0,
      casualtySerious: 0,
      casualtyTypes: new Set<number>(),
      vehicleRows: 0,
      vehicleTypes: new Set<number>(),
      unknownCasualtyTypes: 0,
      unknownCasualtySeverities: 0,
      unknownVehicleTypes: 0,
      missingCasualtyReferences: 0,
      missingVehicleReferences: 0,
      casualtyReferences: new Set<string>(),
      vehicleReferences: new Set<string>(),
      duplicateCasualtyReferences: 0,
      duplicateVehicleReferences: 0,
      casualtyRecords: [],
      vehicleRecords: [],
    });
  }

  let casualtyRowsUnmatched = 0;
  const casualtySource = sourceFor(year, 'casualty');
  for await (const row of readRows(casualtySource.localFile)) {
    sourceRows[`casualty:${year}`] = (sourceRows[`casualty:${year}`] ?? 0) + 1;
    const id = rowId(row);
    const collision = id === null ? undefined : collisions.get(id);
    if (!collision) {
      casualtyRowsUnmatched += 1;
      continue;
    }
    regionalRows[`casualty:${year}`] = (regionalRows[`casualty:${year}`] ?? 0) + 1;
    collision.casualtyRows += 1;
    const casualtyReference = childReference(row, ['casualty_reference']);
    if (casualtyReference === null) collision.missingCasualtyReferences += 1;
    else if (collision.casualtyReferences.has(casualtyReference)) collision.duplicateCasualtyReferences += 1;
    else collision.casualtyReferences.add(casualtyReference);
    const type = codeValue(row, ['casualty_type']);
    if (type !== null) collision.casualtyTypes.add(type);
    if (type === null || !KNOWN_CASUALTY_TYPES.has(type)) collision.unknownCasualtyTypes += 1;
    const severityCode = codeValue(row, ['casualty_severity']);
    if (severityCode === null || ![1, 2, 3].includes(severityCode)) collision.unknownCasualtySeverities += 1;
    if (severityCode === 1) collision.casualtyFatalities += 1;
    if (severityCode === 2) collision.casualtySerious += 1;
    collision.casualtyRecords.push({ reference: casualtyReference, vehicleReference: childReference(row, ['vehicle_reference']), typeCode: type, severityCode });
  }

  let vehicleRowsUnmatched = 0;
  const vehicleSource = sourceFor(year, 'vehicle');
  for await (const row of readRows(vehicleSource.localFile)) {
    sourceRows[`vehicle:${year}`] = (sourceRows[`vehicle:${year}`] ?? 0) + 1;
    const id = rowId(row);
    const collision = id === null ? undefined : collisions.get(id);
    if (!collision) {
      vehicleRowsUnmatched += 1;
      continue;
    }
    regionalRows[`vehicle:${year}`] = (regionalRows[`vehicle:${year}`] ?? 0) + 1;
    collision.vehicleRows += 1;
    const vehicleReference = childReference(row, ['vehicle_reference']);
    if (vehicleReference === null) collision.missingVehicleReferences += 1;
    else if (collision.vehicleReferences.has(vehicleReference)) collision.duplicateVehicleReferences += 1;
    else collision.vehicleReferences.add(vehicleReference);
    const type = codeValue(row, ['vehicle_type']);
    if (type !== null) collision.vehicleTypes.add(type);
    if (type === null || !KNOWN_VEHICLE_TYPES.has(type)) collision.unknownVehicleTypes += 1;
    collision.vehicleRecords.push({ reference: vehicleReference, typeCode: type });
  }

  let completeCasualtyJoins = 0;
  let completeVehicleJoins = 0;
  let completeCasualtySeverity = 0;
  let completePedestrianClassifications = 0;
  let completeCasualtyClassifications = 0;
  let completeVehicleClassifications = 0;
  let unknownCasualtySeverities = 0;
  let duplicateCasualtyChildKeys = 0;
  let duplicateVehicleChildKeys = 0;
  const records: CollisionRecord[] = [];
  for (const collision of collisions.values()) {
    const casualtyJoinComplete = collision.rawCasualties !== null && collision.casualtyRows === collision.rawCasualties &&
      collision.casualtyReferences.size === collision.casualtyRows && collision.missingCasualtyReferences === 0 && collision.duplicateCasualtyReferences === 0;
    const vehicleJoinComplete = collision.rawVehicles !== null && collision.vehicleRows === collision.rawVehicles &&
      collision.vehicleReferences.size === collision.vehicleRows && collision.missingVehicleReferences === 0 && collision.duplicateVehicleReferences === 0;
    const casualtyTypeComplete = casualtyJoinComplete && collision.unknownCasualtyTypes === 0;
    const casualtySeverityComplete = casualtyJoinComplete && collision.unknownCasualtySeverities === 0;
    const casualtyClassificationComplete = casualtyTypeComplete && casualtySeverityComplete;
    const vehicleClassificationComplete = vehicleJoinComplete && collision.unknownVehicleTypes === 0;
    if (casualtyJoinComplete) completeCasualtyJoins += 1;
    if (vehicleJoinComplete) completeVehicleJoins += 1;
    if (casualtySeverityComplete) completeCasualtySeverity += 1;
    if (casualtyTypeComplete) completePedestrianClassifications += 1;
    if (casualtyClassificationComplete) completeCasualtyClassifications += 1;
    if (vehicleClassificationComplete) completeVehicleClassifications += 1;
    unknownCasualtySeverities += collision.unknownCasualtySeverities;
    duplicateCasualtyChildKeys += collision.duplicateCasualtyReferences;
    duplicateVehicleChildKeys += collision.duplicateVehicleReferences;
    records.push(finalizeCollision(collision));
  }

  return {
    records,
    sourceRows: {
      collision: sourceRows[`collision:${year}`] ?? 0,
      vehicle: sourceRows[`vehicle:${year}`] ?? 0,
      casualty: sourceRows[`casualty:${year}`] ?? 0,
    },
    regionalRows: {
      collision: regionalRows[`collision:${year}`] ?? 0,
      vehicle: regionalRows[`vehicle:${year}`] ?? 0,
      casualty: regionalRows[`casualty:${year}`] ?? 0,
    },
    casualtyRowsUnmatched,
    vehicleRowsUnmatched,
    completeCasualtyJoins,
    completeVehicleJoins,
    completeCasualtySeverity,
    completePedestrianClassifications,
    completeCasualtyClassifications,
    completeVehicleClassifications,
    unknownCasualtySeverities,
    duplicateCollisionIds,
    duplicateCasualtyChildKeys,
    duplicateVehicleChildKeys,
    invalidCollisionRows,
    missingCoordinates,
  };
};

const duplicateCount = (records: CollisionRecord[]): number => {
  const ids = new Set<string>();
  let duplicates = 0;
  for (const record of records) {
    if (ids.has(record.id)) duplicates += 1;
    ids.add(record.id);
  }
  return duplicates;
};

const toFeatureCollection = (records: CollisionRecord[]): CollisionCollection => ({
  type: 'FeatureCollection',
  features: records.map((record) => ({
    type: 'Feature',
    id: record.id,
    geometry: { type: 'Point', coordinates: [record.longitude, record.latitude] },
    properties: record,
  })),
});

const main = async (): Promise<void> => {
  await ensureInputs();
  await mkdir(OUTPUT_DIR, { recursive: true });
  const sourceRows: Record<string, number> = {};
  const regionalRows: Record<string, number> = {};
  const results: YearResult[] = [];
  for (const year of YEARS) results.push(await readYear(year, sourceRows, regionalRows));
  const records = results.flatMap((result) => result.records).sort((left, right) => left.id.localeCompare(right.id));
  const sourceFiles = await buildSourceManifest(sourceRows, regionalRows);
  const totalSourceRows = Object.values(sourceRows).reduce((sum, count) => sum + count, 0);
  const validation = {
    sourceRows: totalSourceRows,
    regionalCollisionRows: results.reduce((sum, result) => sum + result.regionalRows.collision, 0),
    outputCollisionFeatures: records.length,
    invalidCollisionRows: results.reduce((sum, result) => sum + result.invalidCollisionRows, 0),
    duplicateCollisionIds: duplicateCount(records),
    casualtyRowsJoined: results.reduce((sum, result) => sum + result.regionalRows.casualty, 0),
    casualtyRowsUnmatched: results.reduce((sum, result) => sum + result.casualtyRowsUnmatched, 0),
    vehicleRowsJoined: results.reduce((sum, result) => sum + result.regionalRows.vehicle, 0),
    vehicleRowsUnmatched: results.reduce((sum, result) => sum + result.vehicleRowsUnmatched, 0),
    collisionsWithCompleteCasualtyJoin: results.reduce((sum, result) => sum + result.completeCasualtyJoins, 0),
    collisionsWithCompleteVehicleJoin: results.reduce((sum, result) => sum + result.completeVehicleJoins, 0),
    collisionsWithCompleteCasualtySeverity: results.reduce((sum, result) => sum + result.completeCasualtySeverity, 0),
    collisionsWithCompletePedestrianClassification: results.reduce((sum, result) => sum + result.completePedestrianClassifications, 0),
    collisionsWithCompleteCasualtyClassification: results.reduce((sum, result) => sum + result.completeCasualtyClassifications, 0),
    collisionsWithCompleteVehicleClassification: results.reduce((sum, result) => sum + result.completeVehicleClassifications, 0),
    collisionsWithUnknownCasualtySeverity: results.reduce((sum, result) => sum + result.unknownCasualtySeverities, 0),
    duplicateCasualtyChildKeys: results.reduce((sum, result) => sum + result.duplicateCasualtyChildKeys, 0),
    duplicateVehicleChildKeys: results.reduce((sum, result) => sum + result.duplicateVehicleChildKeys, 0),
    collisionsWithUnknownSeverity: records.filter((record) => record.severity === 'unknown').length,
    collisionsWithMissingCoordinates: results.reduce((sum, result) => sum + result.missingCoordinates, 0),
    years: [...YEARS],
    authorities: Object.values(AUTHORITY_BY_CODE),
  };
  if (validation.outputCollisionFeatures === 0) throw new Error('No regional collision records were generated.');
  validation.duplicateCollisionIds += results.reduce((sum, result) => sum + result.duplicateCollisionIds, 0);
  if (validation.duplicateCollisionIds > 0) throw new Error(`Duplicate collision IDs: ${validation.duplicateCollisionIds}`);
  if (validation.duplicateCasualtyChildKeys > 0 || validation.duplicateVehicleChildKeys > 0) {
    throw new Error(`Duplicate child keys: ${validation.duplicateCasualtyChildKeys} casualty, ${validation.duplicateVehicleChildKeys} vehicle`);
  }

  const generatedAt = new Date().toISOString();
  const provenance: Stats19Provenance = {
    title: 'West of England Road Collision Observatory',
    subtitle: 'Reported road injury collisions across Bristol, Bath & North East Somerset, South Gloucestershire and North Somerset',
    source: 'Department for Transport STATS19 road safety open data',
    sourceUrl: DATASET_URL,
    codebookUrl: CODEBOOK_URL,
    upstreamDataset: 'DfT Road Safety Open Data: collisions, vehicles and casualties',
    includedYears: [...YEARS],
    latestYear: YEARS[YEARS.length - 1],
    generatedAt,
    licence: 'Open Government Licence v3.0',
    licenceUrl: LICENCE_URL,
    schemaVersion: 'weca-collision/v1',
    processingSteps: [
      'Read the DfT collision, casualty and vehicle CSVs as UTF-8 coded records.',
      'Selected records whose ONS local-authority district is one of the four target authorities.',
      'Joined casualty and vehicle rows to collisions by the source collision index within each year.',
      'Normalized coordinates, dates, severity, road number and casualty measures for the static map.',
      'Derived recorded pedestrian involvement from casualty type and cycle/motorcycle involvement from vehicle type.',
      'Retained nullable measures when the corresponding joined table was incomplete.',
    ],
    limitations: [
      'STATS19 contains reported personal-injury collisions on public roads, not every road incident.',
      'DfT fields are coded; the generated sourceProperties retain source codes needed for later decoding.',
      'The DfT 2025 data guide is the supported lookup for vehicle_type and casualty_type codes; code 90 means other, while 99 means an unknown self-reported vehicle type and remains evidence of incomplete classification.',
      'Collision concentration is a frequency grouping and is not exposure-adjusted risk or a causal finding.',
      'Pedestrian involvement is based on recorded casualty rows; uninjured road users are not represented by STATS19 casualty rows.',
      'The 2020 inputs are fixed Internet Archive replays because the live DfT directory no longer retains those annual files; the exact retrieval URLs and hashes are in sourceFiles.',
      'Regional collision rows with missing or out-of-range coordinates are omitted from the map; the validation section records how many were excluded.',
      'Avon and Somerset Police recording completeness may be affected during 2022–23; do not treat those years as perfectly comparable.',
    ],
    qualityWarningTitle: 'Interpret the 2022–23 Avon & Somerset series with care',
    qualityWarning: 'Avon and Somerset Police changed collision recording systems during 2022. DfT reports missing or incomplete local records around the transition and warns that some 2023 collisions may have been misrecorded or not recorded. Treat affected counts and comparisons as provisional; this warning is not an adjustment or forecast.',
    qualityWarningSource: 'https://www.gov.uk/government/publications/reported-road-casualty-statistics-background-quality-report/road-casualty-statistics-known-data-issues',
    casualtyCoverage: validation.collisionsWithCompleteCasualtySeverity === records.length ? 'complete' : 'partial',
    involvementCoverage: validation.collisionsWithCompleteVehicleClassification === records.length &&
      validation.collisionsWithCompletePedestrianClassification === records.length ? 'complete' : 'partial',
    validation,
    sourceFiles,
  };

  await writeFile(resolve(OUTPUT_DIR, 'collisions.geojson'), `${JSON.stringify(toFeatureCollection(records))}\n`, 'utf8');
  await writeFile(resolve(OUTPUT_DIR, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  console.log(`Generated ${records.length.toLocaleString()} regional collisions for ${YEARS.join(', ')}.`);
  console.log(`Complete casualty joins: ${validation.collisionsWithCompleteCasualtyJoin.toLocaleString()}/${records.length.toLocaleString()}.`);
  console.log(`Complete vehicle joins: ${validation.collisionsWithCompleteVehicleJoin.toLocaleString()}/${records.length.toLocaleString()}.`);
  console.log(`Complete casualty classifications: ${validation.collisionsWithCompleteCasualtyClassification.toLocaleString()}/${records.length.toLocaleString()}.`);
  console.log(`Complete vehicle classifications: ${validation.collisionsWithCompleteVehicleClassification.toLocaleString()}/${records.length.toLocaleString()}.`);
  console.log(`Wrote ${resolve(OUTPUT_DIR, 'collisions.geojson')} and ${resolve(OUTPUT_DIR, 'provenance.json')}.`);
};

export { main };

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
