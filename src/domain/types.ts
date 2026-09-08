/**
 * Public data contracts used by the ingestion boundary.
 *
 * The application currently keeps its runtime model in `model.ts`.  Re-export
 * that model here so scripts and future data adapters have one stable import
 * path without coupling themselves to an upstream STATS19 column name.
 */
import type {
  AuthoritySummary,
  CollisionCollection,
  CollisionFeature,
  CollisionRecord,
  Involvement,
  ObservatoryMetadata,
  PersistentLocation,
  RegionSummary,
  Severity,
} from './model';

export type {
  AuthoritySummary,
  CollisionCollection,
  CollisionFeature,
  CollisionRecord,
  Involvement,
  ObservatoryMetadata,
  PersistentLocation,
  RegionSummary,
  Severity,
};

/** Canonical name for a collision after an upstream adapter has normalized it. */
export type NormalizedCollision = CollisionRecord;

export interface Stats19SourceFile {
  year: number;
  kind: 'collision' | 'vehicle' | 'casualty';
  canonicalUrl: string;
  retrievalUrl: string;
  localFile: string;
  sha256: string;
  bytes: number;
  /** Filesystem timestamp; this is not claimed to be a fresh upstream fetch. */
  localFileModifiedAt: string;
  sourceRows: number;
  regionalRows: number;
}

export interface Stats19CasualtyRecord {
  reference: string | null;
  vehicleReference: string | null;
  typeCode: number | null;
  severityCode: number | null;
}

export interface Stats19VehicleRecord {
  reference: string | null;
  typeCode: number | null;
}

export interface IngestionValidation {
  sourceRows: number;
  regionalCollisionRows: number;
  outputCollisionFeatures: number;
  invalidCollisionRows: number;
  duplicateCollisionIds: number;
  duplicateCasualtyChildKeys: number;
  duplicateVehicleChildKeys: number;
  casualtyRowsJoined: number;
  casualtyRowsUnmatched: number;
  vehicleRowsJoined: number;
  vehicleRowsUnmatched: number;
  collisionsWithCompleteCasualtyJoin: number;
  collisionsWithCompleteVehicleJoin: number;
  collisionsWithCompleteCasualtySeverity: number;
  collisionsWithCompletePedestrianClassification: number;
  collisionsWithCompleteCasualtyClassification: number;
  collisionsWithCompleteVehicleClassification: number;
  collisionsWithUnknownCasualtySeverity: number;
  collisionsWithUnknownSeverity: number;
  collisionsWithMissingCoordinates: number;
  years: number[];
  authorities: string[];
}

export interface Stats19Provenance extends Omit<ObservatoryMetadata, 'validation'> {
  sourceFiles: Stats19SourceFile[];
  validation: IngestionValidation;
}
