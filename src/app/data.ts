import { availableYears } from '../domain/filters';
import { parseCollisionGeoJson, parseMetadata } from '../domain/geojson';
import type { BoundaryGeoJson, CollisionRecord, ObservatoryMetadata } from '../domain/model';

const COLLISION_PATHS = ['/data/collisions.geojson', '/data/collision_points.geojson', '/data/collisions.json'];
const METADATA_PATHS = ['/data/metadata.json', '/data/manifest.json', '/data/provenance.json'];
const BOUNDARY_PATHS = ['/data/boundaries.geojson', '/data/boundary.geojson'];
const BOUNDARY_PROVENANCE_PATHS = ['/data/boundaries.provenance.json'];

export interface BoundaryProvenance {
  source?: {
    publisher?: string;
    dataset?: string;
    datasetUrl?: string;
    licence?: string;
    licenceUrl?: string;
    attribution?: string;
  };
  retrievedAt?: string;
  generatedAt?: string;
}

export interface ObservatoryData {
  records: CollisionRecord[];
  metadata: ObservatoryMetadata;
  boundaries: BoundaryGeoJson | null;
  boundaryProvenance: BoundaryProvenance | null;
  invalidCount: number;
  sourcePath: string;
}

const fetchJson = async (path: string): Promise<unknown> => {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const firstAvailable = async (paths: string[]): Promise<{ value: unknown; path: string } | null> => {
  for (const path of paths) {
    try {
      return { value: await fetchJson(path), path };
    } catch {
      // A missing optional filename is expected as the data refresh evolves.
    }
  }
  return null;
};

export const loadObservatoryData = async (): Promise<ObservatoryData> => {
  const collision = await firstAvailable(COLLISION_PATHS);
  if (!collision) {
    throw new Error('Collision data is not available. Run the documented data refresh command and try again.');
  }
  const parsed = parseCollisionGeoJson(collision.value);
  const [metadataResult, boundaryResult, boundaryProvenanceResult] = await Promise.all([
    firstAvailable(METADATA_PATHS),
    firstAvailable(BOUNDARY_PATHS),
    firstAvailable(BOUNDARY_PROVENANCE_PATHS),
  ]);
  const metadata = metadataResult ? parseMetadata(metadataResult.value) : {};
  if (!metadata.includedYears?.length) metadata.includedYears = availableYears(parsed.records);
  if (metadata.latestYear === undefined) metadata.latestYear = metadata.includedYears[0] ?? null;
  return {
    records: parsed.records,
    metadata,
    boundaries: (boundaryResult?.value as BoundaryGeoJson | null) ?? null,
    boundaryProvenance: (boundaryProvenanceResult?.value as BoundaryProvenance | null) ?? null,
    invalidCount: parsed.invalidCount,
    sourcePath: collision.path,
  };
};
