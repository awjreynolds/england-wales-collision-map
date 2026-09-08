export type Severity = 'fatal' | 'serious' | 'slight' | 'unknown';

/** A tri-state value keeps an unrecorded road-user flag distinct from a recorded zero. */
export type Involvement = boolean | null;

export interface CollisionRecord {
  id: string;
  date: string | null;
  year: number | null;
  latitude: number;
  longitude: number;
  severity: Severity;
  localAuthority: string | null;
  roadName: string | null;
  roadNumber: string | null;
  speedLimit: number | null;
  junctionDetail: string | null;
  casualtyCount: number | null;
  fatalities: number | null;
  seriousCasualties: number | null;
  ksiCasualties: number | null;
  pedestrianInvolved: Involvement;
  cycleInvolved: Involvement;
  motorcycleInvolved: Involvement;
  sourceProperties: Record<string, unknown>;
}

export interface CollisionFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: CollisionRecord;
}

export interface CollisionCollection {
  type: 'FeatureCollection';
  features: CollisionFeature[];
}

export interface ParseResult {
  records: CollisionRecord[];
  invalidCount: number;
}

export interface ObservatoryMetadata {
  title?: string;
  subtitle?: string;
  source?: string;
  sourceUrl?: string;
  upstreamDataset?: string;
  includedYears?: number[];
  latestYear?: number | null;
  generatedAt?: string;
  retrievedAt?: string;
  licence?: string;
  licenceUrl?: string;
  schemaVersion?: string;
  processingSteps?: string[];
  limitations?: string[];
  qualityWarning?: string;
  qualityWarningTitle?: string;
  qualityWarningSource?: string;
  casualtyCoverage?: 'complete' | 'partial' | 'unavailable' | 'unknown';
  involvementCoverage?: 'complete' | 'partial' | 'unavailable' | 'unknown';
  validation?: Record<string, number | string | boolean>;
  [key: string]: unknown;
}

export interface RegionSummary {
  collisions: number;
  fatalCollisions: number;
  seriousCollisions: number;
  slightCollisions: number;
  unknownSeverity: number;
  casualties: number | null;
  casualtiesUnknown: number;
  fatalities: number | null;
  fatalitiesUnknown: number;
  seriousCasualties: number | null;
  seriousCasualtiesUnknown: number;
  ksiCasualties: number | null;
  ksiCasualtiesUnknown: number;
  authorities: AuthoritySummary[];
}

export interface AuthoritySummary {
  authority: string;
  collisions: number;
  fatalCollisions: number;
  seriousCollisions: number;
  slightCollisions: number;
}

export interface PersistentLocation {
  id: string;
  latitude: number;
  longitude: number;
  collisions: number;
  fatalCollisions: number;
  seriousCollisions: number;
  slightCollisions: number;
  unknownSeverity: number;
  years: number[];
  pedestrianInvolved: number;
  pedestrianUnknown: number;
  cycleInvolved: number;
  cycleUnknown: number;
  motorcycleInvolved: number;
  motorcycleUnknown: number;
  memberIds: string[];
}

export interface BoundaryGeoJson {
  type: 'FeatureCollection' | 'Feature';
  features?: Array<Record<string, unknown>>;
  geometry?: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
}
