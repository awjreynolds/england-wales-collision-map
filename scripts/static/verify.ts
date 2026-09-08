/**
 * Verify the checked-in static national publication without loading the whole
 * release into memory. Each gzip artifact is read, hashed and decoded alone;
 * only the collision id sets and aggregate counters live across artifacts.
 *
 * Run with: node --experimental-strip-types scripts/static/verify.ts
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT_DIR = resolve(ROOT, 'public/data/national');
const MAX_FILE_BYTES = 100 * 1_000_000;
const MAX_TOTAL_BYTES = 1_000_000_000;
const EXPECTED_YEARS = [2021, 2022, 2023, 2024, 2025] as const;
const EXPECTED_COLLISIONS = 493_218;
const EXPECTED_SCHOOLS = 25_936;
const CELL_SIZE = 0.25;

type JsonRecord = Record<string, unknown>;
type ArtifactDescriptor = { bytes: number; sha256: string; uncompressedBytes: number; uncompressedSha256: string };
type ManifestJson = {
  schemaVersion: unknown;
  datasetVersion: unknown;
  years: unknown;
  collisionCount: unknown;
  detailCount: unknown;
  schoolCount: unknown;
  artifacts: Record<string, unknown>;
  tiles: Record<string, string>;
  evidenceBuckets: Record<string, string>;
};

const fail = (message: string): never => { throw new Error(message); };
const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validYear = (value: unknown): value is (typeof EXPECTED_YEARS)[number] => typeof value === 'number' && EXPECTED_YEARS.includes(value as (typeof EXPECTED_YEARS)[number]);
const requiredString = (value: unknown, label: string): string => typeof value === 'string' ? value : fail(`${label} must be a string.`);
const requiredInteger = (value: unknown, label: string): number => typeof value === 'number' && Number.isInteger(value) ? value : fail(`${label} must be an integer.`);

const safePath = (path: unknown): string => {
  const candidate = typeof path === 'string' ? path : fail(`Invalid artifact path: ${String(path)}`);
  if (!candidate || candidate.startsWith('/') || candidate.includes('\\')) fail(`Invalid artifact path: ${String(path)}`);
  const target = resolve(OUTPUT_DIR, candidate);
  const root = `${OUTPUT_DIR}/`;
  if (!target.startsWith(root)) fail(`Artifact path escapes publication: ${path}`);
  return target;
};

const readGzipArtifact = async (relativePath: string, expected: ArtifactDescriptor): Promise<{ value: unknown; compressedBytes: number; uncompressedBytes: number }> => {
  const file = safePath(relativePath);
  const bytes = await readFile(file);
  const digest = sha256(bytes);
  if (bytes.length !== expected.bytes) fail(`${relativePath}: byte count mismatch (${bytes.length} vs ${String(expected.bytes)}).`);
  if (digest !== expected.sha256) fail(`${relativePath}: SHA-256 mismatch.`);
  if (bytes.length > MAX_FILE_BYTES) fail(`${relativePath}: compressed artifact exceeds 100 MB.`);
  const uncompressed = (() => {
    try {
      return gunzipSync(bytes);
    } catch (error) {
      return fail(`${relativePath}: invalid gzip (${String(error)}).`);
    }
  })();
  if (uncompressed.length > MAX_FILE_BYTES) fail(`${relativePath}: uncompressed artifact exceeds 100 MB.`);
  if (expected.uncompressedBytes !== uncompressed.length) fail(`${relativePath}: uncompressed byte count mismatch (${uncompressed.length} vs ${String(expected.uncompressedBytes)}).`);
  if (sha256(uncompressed) !== expected.uncompressedSha256) fail(`${relativePath}: uncompressed SHA-256 mismatch.`);
  let value: unknown;
  try {
    value = JSON.parse(uncompressed.toString('utf8')) as unknown;
  } catch (error) {
    fail(`${relativePath}: invalid JSON (${String(error)}).`);
  }
  return { value, compressedBytes: bytes.length, uncompressedBytes: uncompressed.length };
};

const expectedCellFor = (longitude: number, latitude: number): string => {
  const x = Math.max(0, Math.min(1_439, Math.floor((longitude + 180) / CELL_SIZE)));
  const y = Math.max(0, Math.min(719, Math.floor((latitude + 90) / CELL_SIZE)));
  return `x${x}y${y}`;
};

const expectedBucketFor = (id: string): string => createHash('sha256').update(id).digest()[0].toString(16).padStart(2, '0');

const artifactDescriptor = (value: unknown, path: string): ArtifactDescriptor => {
  const descriptor = isRecord(value) ? value : fail(`Invalid artifact descriptor: ${path}`);
  const bytes = requiredInteger(descriptor.bytes, `${path}.bytes`);
  const digest = requiredString(descriptor.sha256, `${path}.sha256`);
  const uncompressedBytes = requiredInteger(descriptor.uncompressedBytes, `${path}.uncompressedBytes`);
  const uncompressedDigest = requiredString(descriptor.uncompressedSha256, `${path}.uncompressedSha256`);
  if (bytes < 0 || !/^[a-f0-9]{64}$/.test(digest) || uncompressedBytes < 0 || !/^[a-f0-9]{64}$/.test(uncompressedDigest)) fail(`Invalid artifact descriptor: ${path}`);
  return { bytes, sha256: digest, uncompressedBytes, uncompressedSha256: uncompressedDigest };
};

const main = async (): Promise<void> => {
  const manifestFile = join(OUTPUT_DIR, 'manifest.json');
  const manifestBytes = await readFile(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as ManifestJson;
  if (manifest.schemaVersion !== 'weca-static-national/v1') fail(`Unsupported static schema: ${String(manifest.schemaVersion)}`);
  if (manifest.datasetVersion !== String(manifest.datasetVersion) || !String(manifest.datasetVersion).startsWith('static-')) fail('Static manifest has no static dataset identity.');
  if (JSON.stringify(manifest.years) !== JSON.stringify(EXPECTED_YEARS)) fail(`Manifest year scope mismatch: ${JSON.stringify(manifest.years)}`);
  if (manifest.collisionCount !== EXPECTED_COLLISIONS || manifest.detailCount !== EXPECTED_COLLISIONS) fail(`Manifest collision/detail count mismatch: ${String(manifest.collisionCount)}/${String(manifest.detailCount)}.`);
  if (manifest.schoolCount !== EXPECTED_SCHOOLS) fail(`Manifest school count mismatch: ${String(manifest.schoolCount)}.`);
  if (!isRecord(manifest.artifacts)) fail('Manifest artifacts are missing.');
  if (!isRecord(manifest.tiles) || !isRecord(manifest.evidenceBuckets)) fail('Manifest tile/evidence indexes are missing.');
  if (Object.keys(manifest.tiles).length !== 398) fail(`Expected 398 tile cells, got ${Object.keys(manifest.tiles).length}.`);
  if (Object.keys(manifest.evidenceBuckets).length !== 256) fail(`Expected 256 evidence buckets, got ${Object.keys(manifest.evidenceBuckets).length}.`);
  if (Object.keys(manifest.artifacts).length !== 656) fail(`Expected 656 compressed artifacts, got ${Object.keys(manifest.artifacts).length}.`);

  let totalBytes = manifestBytes.length;
  const artifactValues = new Set<string>();
  for (const [path, descriptor] of Object.entries(manifest.artifacts)) {
    if (!isRecord(descriptor) || artifactValues.has(path)) fail(`Invalid or duplicate artifact descriptor: ${path}`);
    artifactValues.add(path);
    const result = await readGzipArtifact(path, artifactDescriptor(descriptor, path));
    totalBytes += result.compressedBytes;
  }
  if (totalBytes > MAX_TOTAL_BYTES) fail(`Publication exceeds 1 GB: ${totalBytes} bytes.`);

  const overviewDescriptor = manifest.artifacts['overview.json.gz'];
  const schoolsDescriptor = manifest.artifacts['schools.json.gz'];
  if (!isRecord(overviewDescriptor) || !isRecord(schoolsDescriptor)) fail('Overview or school artifact is absent from manifest.');
  const overviewResult = await readGzipArtifact('overview.json.gz', artifactDescriptor(overviewDescriptor, 'overview.json.gz'));
  const schoolsResult = await readGzipArtifact('schools.json.gz', artifactDescriptor(schoolsDescriptor, 'schools.json.gz'));
  const overview = overviewResult.value;
  const schools = schoolsResult.value;
  const overviewObject = isRecord(overview) && !Array.isArray(overview) && overview.schemaVersion === manifest.schemaVersion && isRecord(overview.cells)
    ? overview as JsonRecord & { cells: Record<string, JsonRecord> }
    : fail('Overview must be a static schema object with cells.');
  const schoolsObject = isRecord(schools) && !Array.isArray(schools) && schools.schemaVersion === manifest.schemaVersion && Array.isArray(schools.schools)
    ? schools as JsonRecord & { schools: Array<unknown> }
    : fail('Schools must be a static schema object with an array.');
  if (schoolsObject.schools.length !== EXPECTED_SCHOOLS) fail(`School row count mismatch: ${schoolsObject.schools.length}.`);
  for (const school of schoolsObject.schools) {
    if (!isRecord(school) || typeof school.id !== 'string' || typeof school.name !== 'string' || (school.country !== 'England' && school.country !== 'Wales') || !finiteNumber(school.lat) || !finiteNumber(school.lon)) fail('School catalogue contains an invalid row.');
  }

  const years = new Set<number>(EXPECTED_YEARS);
  const tileIds = new Set<string>();
  const evidenceIds = new Set<string>();
  let tileCount = 0;
  let evidenceCount = 0;
  let facetCount = 0;
  const overviewCells = overviewObject.cells as Record<string, JsonRecord>;
  const tileKeys = Object.keys(manifest.tiles).sort();
  for (const cellKey of tileKeys) {
    const tilePath = manifest.tiles[cellKey];
    if (tilePath !== `tiles/${cellKey}.json.gz`) fail(`Unexpected tile path for ${cellKey}: ${String(tilePath)}`);
    const descriptor = manifest.artifacts[tilePath];
    if (!isRecord(descriptor)) fail(`Tile artifact is absent: ${String(tilePath)}`);
    const result = await readGzipArtifact(tilePath, artifactDescriptor(descriptor, tilePath));
    const tile = Array.isArray(result.value) ? result.value as unknown[] : fail(`${tilePath}: tile is not an array.`);
    const overviewCell = overviewCells[cellKey];
    if (!isRecord(overviewCell)) fail(`${cellKey}: overview/tile record count mismatch.`);
    const overviewRecordCount = overviewCell.recordCount;
    if (overviewRecordCount !== tile.length) fail(`${cellKey}: overview/tile record count mismatch.`);
    tileCount += tile.length;
    for (const item of tile) {
      const record = isRecord(item) ? item : fail(`${tilePath}: invalid, duplicate or misplaced collision record.`);
      const id = requiredString(record.id, `${tilePath}.id`);
      const latitude = finiteNumber(record.latitude) ? record.latitude : fail(`${tilePath}: invalid latitude.`);
      const longitude = finiteNumber(record.longitude) ? record.longitude : fail(`${tilePath}: invalid longitude.`);
      if (tileIds.has(id) || !validYear(record.year) || record.datasetVersion !== manifest.datasetVersion || expectedCellFor(longitude, latitude) !== cellKey) fail(`${tilePath}: invalid, duplicate or misplaced collision record.`);
      tileIds.add(id);
    }
  }

  for (const [cellKey, cell] of Object.entries(overviewCells)) {
    if (!isRecord(cell) || !isRecord(cell.facets)) fail(`Invalid overview cell: ${cellKey}`);
    const recordCount = requiredInteger(cell.recordCount, `${cellKey}.recordCount`);
    if (recordCount < 1) fail(`Invalid overview cell: ${cellKey}`);
    const facets = isRecord(cell.facets) ? cell.facets : fail(`Invalid overview facets: ${cellKey}`);
    let cellFacetCount = 0;
    for (const [facetKey, facet] of Object.entries(facets)) {
      const parts = facetKey.split('|');
      if (parts.length !== 7 || !years.has(Number(parts[0])) || (parts[1] !== 'England' && parts[1] !== 'Wales') || !/^E|^W/.test(parts[2]) || !['fatal', 'serious', 'slight', 'unknown'].includes(parts[3]) || !['y', 'n', 'u'].includes(parts[4]) || !['y', 'n', 'u'].includes(parts[5]) || !['y', 'n', 'u'].includes(parts[6])) fail(`Invalid overview facet: ${cellKey}/${facetKey}`);
      const metrics = isRecord(facet) && isRecord(facet.additiveSummaryMetrics) ? facet.additiveSummaryMetrics : fail(`Invalid overview metrics: ${cellKey}/${facetKey}`);
      const collisions = requiredInteger(metrics.collisions, `${cellKey}/${facetKey}.collisions`);
      if (collisions < 1) fail(`Invalid overview metrics: ${cellKey}/${facetKey}`);
      facetCount += collisions;
      cellFacetCount += collisions;
    }
    if (cellFacetCount !== recordCount) fail(`Overview facet count mismatch in ${cellKey}.`);
  }

  for (let index = 0; index < 256; index += 1) {
    const bucket = index.toString(16).padStart(2, '0');
    const evidencePath = manifest.evidenceBuckets[bucket];
    if (evidencePath !== `evidence/${bucket}.json.gz`) fail(`Unexpected evidence path for ${bucket}: ${String(evidencePath)}`);
    const descriptor = manifest.artifacts[evidencePath];
    if (!isRecord(descriptor)) fail(`Evidence artifact is absent: ${String(evidencePath)}`);
    const result = await readGzipArtifact(evidencePath, artifactDescriptor(descriptor, evidencePath));
    const evidence = Array.isArray(result.value) ? result.value as unknown[] : fail(`${evidencePath}: evidence bucket is not an array.`);
    evidenceCount += evidence.length;
    for (const item of evidence) {
      const record = isRecord(item) ? item : fail(`${evidencePath}: invalid, duplicate, unmatched or misplaced evidence record.`);
      const id = requiredString(record.id, `${evidencePath}.id`);
      if (evidenceIds.has(id) || !tileIds.has(id) || record.datasetVersion !== manifest.datasetVersion || !isRecord(record.evidence) || !isRecord(record.evidence.collision) || !Array.isArray(record.evidence.casualties) || !Array.isArray(record.evidence.vehicles) || expectedBucketFor(id) !== bucket) fail(`${evidencePath}: invalid, duplicate, unmatched or misplaced evidence record.`);
      evidenceIds.add(id);
    }
  }

  if (tileCount !== EXPECTED_COLLISIONS || facetCount !== EXPECTED_COLLISIONS || evidenceCount !== EXPECTED_COLLISIONS || tileIds.size !== EXPECTED_COLLISIONS || evidenceIds.size !== EXPECTED_COLLISIONS) fail(`Collision totals mismatch: tiles=${tileCount}, facets=${facetCount}, evidence=${evidenceCount}, tileIds=${tileIds.size}, evidenceIds=${evidenceIds.size}.`);
  for (const id of tileIds) if (!evidenceIds.has(id)) fail(`Tile collision has no evidence: ${id}`);
  console.log(JSON.stringify({ output: OUTPUT_DIR, datasetVersion: manifest.datasetVersion, artifacts: Object.keys(manifest.artifacts).length, totalBytes, overviewCells: Object.keys(overviewCells).length, tileCount, facetCount, evidenceCount, schoolCount: schoolsObject.schools.length }, null, 2));
};

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

export { main };
