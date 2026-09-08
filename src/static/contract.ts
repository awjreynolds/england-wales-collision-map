/**
 * Static national dataset contract.
 *
 * The publisher writes these dependency-free JSON shapes for GitHub Pages.
 * Overview facets contain additive metrics for records wholly contained by a
 * fixed 0.25° cell. The application applies filters to facets and loads tile
 * records for boundary cells, point rendering and analysis. Evidence is kept
 * in deterministic 256-way hash buckets and fetched only for a selected id.
 */

export const STATIC_SCHEMA_VERSION = 'weca-static-national/v1' as const;
export const STATIC_CELL_SIZE_DEGREES = 0.25 as const;
export const STATIC_EVIDENCE_BUCKET_COUNT = 256 as const;

export type StaticCountry = 'England' | 'Wales';
export type StaticSeverity = 'fatal' | 'serious' | 'slight' | 'unknown';

export interface StaticBBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** The values represented in one overview facet. Every field is a filter key. */
export interface StaticFacetDimensions {
  year: number;
  country: StaticCountry;
  authorityCode: string;
  severity: StaticSeverity;
  pedestrian: boolean | null;
  cycle: boolean | null;
  motorcycle: boolean | null;
}

/** All fields are additive across facets and cells. */
export interface StaticAdditiveSummaryMetrics {
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
  ksiCollisions: number;
}

export interface StaticCellFacet {
  additiveSummaryMetrics: StaticAdditiveSummaryMetrics;
}

export type StaticFacetKey = string;
export type StaticFacetMap = Record<StaticFacetKey, StaticCellFacet>;

export interface StaticCellOverview {
  cellKey: string;
  bounds: StaticBBox;
  recordCount: number;
  facets: StaticFacetMap;
}

export interface StaticOverview {
  schemaVersion: typeof STATIC_SCHEMA_VERSION;
  cellSizeDegrees: typeof STATIC_CELL_SIZE_DEGREES;
  cells: Record<string, StaticCellOverview>;
}

/** Slim record carried by a cell tile; evidence is fetched separately. */
export interface StaticCollisionRecord {
  id: string;
  datasetVersion: string;
  year: number | null;
  date: string | null;
  time: string | null;
  latitude: number;
  longitude: number;
  country: StaticCountry | null;
  authorityCode: string | null;
  authorityName: string | null;
  roadName: string | null;
  roadNumber: string | null;
  speedLimit: number | null;
  junctionDetail: string | null;
  severity: StaticSeverity;
  casualtyCount: number | null;
  fatalities: number | null;
  seriousCasualties: number | null;
  slightCasualties: number | null;
  ksiCasualties: number | null;
  pedestrianInvolved: boolean | null;
  cycleInvolved: boolean | null;
  motorcycleInvolved: boolean | null;
}

export type StaticRecordTile = StaticCollisionRecord[];

export interface StaticCollisionEvidence {
  collision: Record<string, unknown>;
  casualties: Array<Record<string, unknown>>;
  vehicles: Array<Record<string, unknown>>;
  join?: Record<string, unknown>;
}

export interface StaticEvidenceRecord extends StaticCollisionRecord {
  evidence: StaticCollisionEvidence;
}

export type StaticEvidenceBucket = StaticEvidenceRecord[];

export interface StaticSchoolRecord {
  id: string;
  name: string;
  country: StaticCountry;
  lat: number;
  lon: number;
  status: string;
  phase: string;
  source: string;
}

export interface StaticSchoolCatalogue {
  schemaVersion: typeof STATIC_SCHEMA_VERSION;
  schools: StaticSchoolRecord[];
  provenance: Record<string, unknown>;
}

export interface StaticArtifact {
  path: string;
  bytes: number;
  sha256: string;
  uncompressedBytes?: number;
  uncompressedSha256?: string;
}

export interface StaticManifestPaths {
  overview: string;
  tiles: string;
  evidence: string;
  schools: string;
}

export interface StaticManifest {
  schemaVersion: typeof STATIC_SCHEMA_VERSION;
  datasetVersion: string;
  nationalDatasetVersion: string;
  generatedAt: string;
  years: number[];
  scope: 'England and Wales';
  extent: StaticBBox;
  collisionCount: number;
  detailCount: number;
  schoolCount: number;
  cellSizeDegrees: typeof STATIC_CELL_SIZE_DEGREES;
  evidenceBucketCount: typeof STATIC_EVIDENCE_BUCKET_COUNT;
  source: {
    publisher: string;
    dataset: string;
    urls: string[];
    licence?: string;
    licenceUrl?: string;
  };
  authorities: Array<{ code: string; name: string; country: StaticCountry }>;
  paths: StaticManifestPaths;
  tiles: Record<string, string>;
  evidenceBuckets: Record<string, string>;
  artifacts: Record<string, StaticArtifact>;
  provenance: {
    nationalManifest: Record<string, unknown>;
    serviceImportManifest: Record<string, unknown>;
    staticPublisherSha256: string;
    staticContractSha256: string;
    schoolProvenanceSha256: string;
    schoolOutputSha256: string;
  };
}

const encodeFacetBoolean = (value: boolean | null): string => value === null ? 'u' : value ? 'y' : 'n';

/** Stable key encoding used by overview facets. `u` represents unknown/null. */
export const staticFacetKey = (dimensions: StaticFacetDimensions): StaticFacetKey => [
  dimensions.year,
  dimensions.country,
  dimensions.authorityCode,
  dimensions.severity,
  encodeFacetBoolean(dimensions.pedestrian),
  encodeFacetBoolean(dimensions.cycle),
  encodeFacetBoolean(dimensions.motorcycle),
].join('|');

export const staticCellKey = (longitude: number, latitude: number): string => {
  const x = Math.max(0, Math.min(1_439, Math.floor((longitude + 180) / STATIC_CELL_SIZE_DEGREES)));
  const y = Math.max(0, Math.min(719, Math.floor((latitude + 90) / STATIC_CELL_SIZE_DEGREES)));
  return `x${x}y${y}`;
};

export const staticCellBounds = (cellKey: string): StaticBBox => {
  const match = /^x(\d+)y(\d+)$/.exec(cellKey);
  if (!match) throw new Error(`Invalid static national cell key: ${cellKey}`);
  const west = Number(match[1]) * STATIC_CELL_SIZE_DEGREES - 180;
  const south = Number(match[2]) * STATIC_CELL_SIZE_DEGREES - 90;
  return { west, south, east: west + STATIC_CELL_SIZE_DEGREES, north: south + STATIC_CELL_SIZE_DEGREES };
};

export const staticEvidenceBucket = (firstShaByte: number): string => {
  if (!Number.isInteger(firstShaByte) || firstShaByte < 0 || firstShaByte > 255) throw new Error(`Invalid evidence bucket byte: ${firstShaByte}`);
  return firstShaByte.toString(16).padStart(2, '0');
};
