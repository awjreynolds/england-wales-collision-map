import type {
  CollisionCollection,
  CollisionFeature,
  CollisionRecord,
  ObservatoryMetadata,
  ParseResult,
  Severity,
  Involvement,
} from './model';

type JsonObject = Record<string, unknown>;

type EvidenceKind = 'casualty' | 'vehicle';
type RoadUserDimension = 'pedestrian' | 'cycle' | 'motorcycle';

interface PresentValue {
  present: boolean;
  value: unknown;
}

interface LinkedEvidence {
  kind: EvidenceKind;
  items: JsonObject[];
}

interface EvidenceMatch {
  positive: boolean;
}

const severityAliases: Record<string, Severity> = {
  fatal: 'fatal',
  killed: 'fatal',
  '1': 'fatal',
  serious: 'serious',
  severe: 'serious',
  '2': 'serious',
  slight: 'slight',
  minor: 'slight',
  '3': 'slight',
};

const asObject = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

const firstPresent = (object: JsonObject, keys: string[]): PresentValue => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) return { present: true, value: object[key] };
  }
  return { present: false, value: null };
};

const firstValue = (object: JsonObject, keys: string[]): unknown => {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return null;
};

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const integer = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number === null ? null : Math.round(number);
};

const text = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
};

const boolOrNull = (value: unknown): Involvement => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'involved'].includes(normalized)) return true;
    if (['false', 'no', 'n', '0', 'none'].includes(normalized)) return false;
  }
  return null;
};

const dateAndYear = (value: unknown, yearValue: unknown): { date: string | null; year: number | null } => {
  const date = text(value);
  const parsedYear = integer(yearValue) ?? (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
  return { date, year: parsedYear && parsedYear >= 1900 && parsedYear <= 2100 ? parsedYear : null };
};

const normalizeSeverity = (value: unknown): Severity => {
  if (typeof value === 'number') return severityAliases[String(Math.round(value))] ?? 'unknown';
  const normalized = text(value)?.toLowerCase() ?? '';
  return severityAliases[normalized] ?? 'unknown';
};

const arrayValues = (object: JsonObject, keys: string[]): unknown[] => {
  const value = firstValue(object, keys);
  return Array.isArray(value) ? value : [];
};

const linkedEvidence = (object: JsonObject, keys: string[], kind: EvidenceKind): LinkedEvidence | null => {
  const source = firstPresent(object, keys);
  if (!source.present || !Array.isArray(source.value)) return source.present ? { kind, items: [] } : null;
  return { kind, items: source.value.map(asObject) };
};

const normalizeCategory = (value: unknown): string | null => {
  const candidate = text(value);
  return candidate ? candidate.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() : null;
};

const pedestrianCategories = new Set(['pedestrian', 'person on foot', 'walker', 'walk']);
const cycleCategories = new Set(['cycle', 'cyclist', 'bicycle', 'bicyclist', 'pedal cycle', 'pedal cyclist', 'bike']);
const motorcycleCategories = new Set(['motorcycle', 'motorcyclist', 'motorbike', 'moped', 'motor scooter']);

const typeKeys = (kind: EvidenceKind): string[] => kind === 'casualty'
  ? ['casualtyType', 'casualty_type', 'roadUserType', 'road_user_type', 'type']
  : ['vehicleType', 'vehicle_type', 'roadUserType', 'road_user_type', 'type'];

const positiveCodes = (kind: EvidenceKind, dimension: RoadUserDimension): number[] => {
  if (dimension === 'pedestrian') return kind === 'casualty' ? [0] : [];
  if (dimension === 'cycle') return [1];
  return kind === 'casualty' ? [2, 3, 4, 5] : [2, 3, 4, 5, 23, 97];
};

const categorySet = (dimension: RoadUserDimension): Set<string> => {
  if (dimension === 'pedestrian') return pedestrianCategories;
  if (dimension === 'cycle') return cycleCategories;
  return motorcycleCategories;
};

const classifyEvidence = (item: JsonObject, kind: EvidenceKind, dimension: RoadUserDimension): EvidenceMatch => {
  const candidate = firstPresent(item, typeKeys(kind));
  if (!candidate.present) return { positive: false };
  const number = finiteNumber(candidate.value);
  if (number !== null) return { positive: positiveCodes(kind, dimension).includes(number) };
  const category = normalizeCategory(candidate.value);
  return { positive: category ? categorySet(dimension).has(category) : false };
};

const deriveInvolvement = (
  properties: JsonObject,
  explicitKeys: string[],
  evidenceSources: Array<{ keys: string[]; kind: EvidenceKind }>,
  dimension: RoadUserDimension,
): Involvement => {
  const explicit = firstPresent(properties, explicitKeys);
  if (explicit.present) return boolOrNull(explicit.value);
  const evidence = evidenceSources
    .map(({ keys, kind }) => linkedEvidence(properties, keys, kind))
    .filter((source): source is LinkedEvidence => source !== null)
    .flatMap((source) => source.items.map((item) => ({ item, kind: source.kind })));
  if (!evidence.length) return null;
  const matches = evidence.map(({ item, kind }) => classifyEvidence(item, kind, dimension));
  if (matches.some((match) => match.positive)) return true;
  return null;
};

const isValidPoint = (coordinates: unknown): coordinates is [number, number] =>
  Array.isArray(coordinates) && coordinates.length >= 2 && finiteNumber(coordinates[0]) !== null && finiteNumber(coordinates[1]) !== null &&
  Number(coordinates[0]) >= -180 && Number(coordinates[0]) <= 180 && Number(coordinates[1]) >= -90 && Number(coordinates[1]) <= 90;

export const normalizeRecord = (rawProperties: unknown, coordinates: [number, number], fallbackId: string): CollisionRecord => {
  const properties = asObject(rawProperties);
  const { date, year } = dateAndYear(firstValue(properties, ['date', 'collisionDate', 'collision_date']), firstValue(properties, ['year', 'collisionYear', 'collision_year', 'accident_year']));
  const sourceId = text(firstValue(properties, ['id', 'collisionId', 'collision_id', 'accident_index', 'accidentIndex'])) ?? fallbackId;
  const casualties = firstPresent(properties, ['casualtyCount', 'casualty_count', 'numberOfCasualties', 'number_of_casualties']);
  const fatalities = firstValue(properties, ['fatalities', 'fatalCasualties', 'fatal_casualties']);
  const seriousCasualties = firstValue(properties, ['seriousCasualties', 'serious_casualties', 'seriouslyInjured']);
  const ksiCasualties = firstPresent(properties, ['ksiCasualties', 'ksi_casualties', 'killedOrSeriouslyInjured']);
  const casualtyList = arrayValues(properties, ['casualties', 'casualtyRecords', 'casualty_records']);
  const casualtyCount = casualties.present ? integer(casualties.value) : casualtyList.length ? casualtyList.length : null;
  const fatalityCount = integer(fatalities);
  const seriousCount = integer(seriousCasualties);
  const ksiCount = ksiCasualties.present
    ? integer(ksiCasualties.value)
    : fatalityCount !== null && seriousCount !== null
      ? fatalityCount + seriousCount
      : null;

  return {
    id: sourceId,
    date,
    year,
    latitude: coordinates[1],
    longitude: coordinates[0],
    severity: normalizeSeverity(firstValue(properties, ['severity', 'collisionSeverity', 'collision_severity', 'accident_severity'])),
    localAuthority: text(firstValue(properties, ['localAuthority', 'local_authority', 'localAuthorityName', 'authority', 'local_authority_district'])),
    roadName: text(firstValue(properties, ['roadName', 'road_name', 'road'])),
    roadNumber: text(firstValue(properties, ['roadNumber', 'road_number', 'firstRoadNumber', 'first_road_number'])),
    speedLimit: integer(firstValue(properties, ['speedLimit', 'speed_limit'])),
    junctionDetail: text(firstValue(properties, ['junctionDetail', 'junction_detail'])),
    casualtyCount,
    fatalities: fatalityCount,
    seriousCasualties: seriousCount,
    ksiCasualties: ksiCount,
    pedestrianInvolved: deriveInvolvement(
      properties,
      ['pedestrianInvolved', 'pedestrian_involved', 'pedestrian'],
      [{ keys: ['casualties', 'casualtyRecords', 'casualty_records'], kind: 'casualty' }],
      'pedestrian',
    ),
    cycleInvolved: deriveInvolvement(
      properties,
      ['cycleInvolved', 'cycle_involved', 'cyclistInvolved', 'cyclist_involved', 'cycle'],
      [
        { keys: ['casualties', 'casualtyRecords', 'casualty_records'], kind: 'casualty' },
        { keys: ['vehicles', 'vehicleRecords', 'vehicle_records'], kind: 'vehicle' },
      ],
      'cycle',
    ),
    motorcycleInvolved: deriveInvolvement(
      properties,
      ['motorcycleInvolved', 'motorcycle_involved', 'motorcycle'],
      [
        { keys: ['casualties', 'casualtyRecords', 'casualty_records'], kind: 'casualty' },
        { keys: ['vehicles', 'vehicleRecords', 'vehicle_records'], kind: 'vehicle' },
      ],
      'motorcycle',
    ),
    sourceProperties: properties,
  };
};

export const parseCollisionGeoJson = (value: unknown): ParseResult => {
  const object = asObject(value);
  const rawFeatures = Array.isArray(object.features) ? object.features : [];
  const records: CollisionRecord[] = [];
  let invalidCount = 0;
  rawFeatures.forEach((rawFeature, index) => {
    const feature = asObject(rawFeature);
    const geometry = asObject(feature.geometry);
    if (geometry.type !== 'Point' || !isValidPoint(geometry.coordinates)) {
      invalidCount += 1;
      return;
    }
    const coordinates: [number, number] = [Number(geometry.coordinates[0]), Number(geometry.coordinates[1])];
    records.push(normalizeRecord(feature.properties, coordinates, text(feature.id) ?? `collision-${index + 1}`));
  });
  return { records, invalidCount };
};

export const toCollisionFeature = (record: CollisionRecord): CollisionFeature => ({
  type: 'Feature',
  id: record.id,
  geometry: { type: 'Point', coordinates: [record.longitude, record.latitude] },
  properties: record,
});

export const toCollisionCollection = (records: CollisionRecord[]): CollisionCollection => ({
  type: 'FeatureCollection',
  features: records.map(toCollisionFeature),
});

export const parseMetadata = (value: unknown): ObservatoryMetadata => asObject(value) as ObservatoryMetadata;
