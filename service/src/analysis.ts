import { groupPersistentLocations } from '../../src/domain/analysis';
import type { CollisionRecord as RegionalCollisionRecord } from '../../src/domain/model';
import type {
  AnalysisGroup,
  AnalysisHarmFilter,
  AnalysisPayload,
  BBox,
  CasualtySeverityCounts,
  ParsedQuery,
  SchoolDistanceMatch,
  SchoolRecord,
  SchoolCoverage,
  SeverityCounts,
} from '../contract';
import { bboxForAnalysisAnchor, querySchoolById, querySchools, querySchoolsNear, type CollisionRow } from './query';

const EARTH_RADIUS_METRES = 6_371_008.8;

const distanceMetres = (left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }): number => {
  const lat1 = (left.latitude * Math.PI) / 180;
  const lat2 = (right.latitude * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((right.longitude - left.longitude) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a));
};

const parseSource = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const toGroupingRecord = (row: CollisionRow): RegionalCollisionRecord => ({
  id: row.id,
  date: row.date,
  year: row.year,
  latitude: row.latitude,
  longitude: row.longitude,
  severity: row.severity,
  localAuthority: row.authority_name ?? row.authority_code,
  roadName: row.road_name,
  roadNumber: row.road_number,
  speedLimit: row.speed_limit,
  junctionDetail: row.junction_detail,
  casualtyCount: row.casualty_count,
  fatalities: row.fatalities,
  seriousCasualties: row.serious_casualties,
  ksiCasualties: row.ksi_casualties,
  pedestrianInvolved: row.pedestrian_involved === null ? null : row.pedestrian_involved === 1,
  cycleInvolved: row.cycle_involved === null ? null : row.cycle_involved === 1,
  motorcycleInvolved: row.motorcycle_involved === null ? null : row.motorcycle_involved === 1,
  sourceProperties: parseSource(row.source_json),
});

const severityCounts = (records: CollisionRow[]): SeverityCounts => ({
  fatal: records.filter((record) => record.severity === 'fatal').length,
  serious: records.filter((record) => record.severity === 'serious').length,
  slight: records.filter((record) => record.severity === 'slight').length,
  unknown: records.filter((record) => record.severity === 'unknown').length,
});

const nullableSum = (records: CollisionRow[], field: 'casualty_count' | 'fatalities' | 'serious_casualties' | 'slight_casualties' | 'ksi_casualties') => {
  const values = records.map((record) => record[field]);
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    value: present.length ? present.reduce((sum, value) => sum + value, 0) : null,
    unknownRecords: values.length - present.length,
  };
};

const casualtyCounts = (records: CollisionRow[]): CasualtySeverityCounts => ({
  total: nullableSum(records, 'casualty_count'),
  fatalities: nullableSum(records, 'fatalities'),
  serious: nullableSum(records, 'serious_casualties'),
  slight: nullableSum(records, 'slight_casualties'),
  ksi: nullableSum(records, 'ksi_casualties'),
});

const harmFor = (records: CollisionRow[]) => {
  const ksiRecords = records.filter((record) => record.ksi_casualties !== null && record.ksi_casualties > 0);
  return {
    collisionSeverity: severityCounts(records),
    casualties: casualtyCounts(records),
    ksiCollisions: ksiRecords.length,
    ksiCollisionYears: [...new Set(ksiRecords.map((record) => record.year).filter((year): year is number => year !== null))].sort((left, right) => left - right),
  };
};

const matchesHarmFilter = (group: AnalysisGroup, filter: AnalysisHarmFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'ksi') return group.harm.ksiCollisions > 0;
  // Repeated harm means at least two KSI collisions at the grouped location.
  // Years are returned separately so callers can see whether those collisions
  // happened in one year or across several years.
  if (filter === 'repeated-ksi') return group.harm.ksiCollisions >= 2;
  return group.harm.casualties.slight.unknownRecords === 0 &&
    group.harm.casualties.ksi.unknownRecords === 0 &&
    (group.harm.casualties.slight.value ?? 0) > 0 &&
    group.harm.casualties.ksi.value === 0;
};

const normalizeLongitude = (longitude: number): number => {
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && longitude > 0 ? 180 : wrapped;
};

const expandedBBox = (bbox: BBox, metres: number): BBox => {
  const degreesPerMetre = 180 / (Math.PI * EARTH_RADIUS_METRES);
  const latitudeDelta = metres * degreesPerMetre;
  const centreLatitude = (bbox.south + bbox.north) / 2;
  const maximumLatitude = Math.min(89.9, Math.max(Math.abs(bbox.south), Math.abs(bbox.north), Math.abs(centreLatitude)));
  const longitudeDelta = metres * degreesPerMetre / Math.max(Math.cos((maximumLatitude * Math.PI) / 180), 0.01);
  const width = bbox.world === true ? 360 : bbox.east >= bbox.west ? bbox.east - bbox.west : bbox.east + 360 - bbox.west;
  const south = Math.max(-90, bbox.south - latitudeDelta);
  const north = Math.min(90, bbox.north + latitudeDelta);
  // Normalizing each endpoint independently turns a nearly-global box into a
  // narrow antimeridian strip once its school-search expansion crosses 360°.
  // Preserve the intended whole-world longitude range instead.
  if (bbox.world === true || width + (2 * longitudeDelta) >= 360) {
    return { west: -180, south, east: 180, north, world: true };
  }
  return {
    west: normalizeLongitude(bbox.west - longitudeDelta),
    south,
    east: normalizeLongitude(bbox.east + longitudeDelta),
    north,
  };
};

const nearestSchool = (anchor: { latitude: number; longitude: number }, schools: SchoolRecord[]): SchoolDistanceMatch | null => {
  let nearest: SchoolDistanceMatch | null = null;
  for (const school of schools) {
    const distance = distanceMetres(anchor, school);
    if (!nearest || distance < nearest.distanceMetres) nearest = { school, distanceMetres: Math.round(distance * 10) / 10 };
  }
  return nearest;
};

const groupsWithSchools = async (db: D1Database, groups: AnalysisGroup[], bbox: BBox, selectedSchoolId?: string): Promise<AnalysisGroup[]> => {
  if (!groups.length) return groups;
  const candidates = await querySchools(db, undefined, expandedBBox(bbox, 1_000), 50_000);
  const selectedSchool = selectedSchoolId ? await querySchoolById(db, selectedSchoolId) : undefined;
  const schools = selectedSchool && !candidates.some((school) => school.id === selectedSchool.id) ? [...candidates, selectedSchool] : candidates;
  return groups.map((group) => {
    const anchor = group.anchor;
    const nearby = schools.filter((school) => distanceMetres(anchor, school) <= 1_000);
    const nearest = nearestSchool(anchor, nearby);
    const selectedDistance = group.schoolProximity.selectedDistanceMetres ?? (selectedSchoolId ? 500 : undefined);
    const selectedMatch = selectedSchoolId ? nearby.some((school) => school.id === selectedSchoolId && selectedDistance !== undefined && distanceMetres(anchor, school) <= selectedDistance) : undefined;
    return {
      ...group,
      schoolProximity: {
        ...group.schoolProximity,
        ...(selectedDistance !== undefined ? { selectedDistanceMetres: selectedDistance } : {}),
        within500m: nearby.some((school) => distanceMetres(anchor, school) <= 500),
        within1km: nearby.length > 0,
        nearestSchool: nearest,
        selectedSchoolMatch: selectedMatch,
      },
    };
  });
};

export const buildAnalysis = async (
  db: D1Database,
  rows: CollisionRow[],
  query: ParsedQuery,
): Promise<Pick<AnalysisPayload, 'groups' | 'schoolCoverage' | 'edgeWarning'>> => {
  if (!query.bbox) throw new Error('analysis requires bbox');
  const groupingRecords = rows.map(toGroupingRecord);
  const baseGroups = groupPersistentLocations(groupingRecords, query.radiusMetres, 3, 2);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups: AnalysisGroup[] = baseGroups.map((location) => {
    const members = location.memberIds.map((id) => byId.get(id)).filter((row): row is CollisionRow => Boolean(row));
    const harm = harmFor(members);
    return {
      id: location.id,
      anchor: { collisionId: location.id.replace(/^location-/, ''), latitude: location.latitude, longitude: location.longitude },
      collisions: members.length,
      yearsRepresented: location.years,
      harm,
      memberIds: location.memberIds,
      schoolProximity: {
        within500m: false,
        within1km: false,
        nearestSchool: null,
        selectedDistanceMetres: query.schoolDistanceMetres,
      },
    };
  });
  const filteredGroups = groups.filter((group) => matchesHarmFilter(group, query.harmFilter));
  // Always calculate school coverage for the bounded result. This keeps the
  // coverage figures honest when no school filter is selected.
  const withSchools = await groupsWithSchools(db, filteredGroups, query.bbox, query.schoolId);
  const schoolFilteredGroups = query.schoolId
    ? withSchools.filter((group) => group.schoolProximity.selectedSchoolMatch === true)
    : query.schoolDistanceMetres === 500
      ? withSchools.filter((group) => group.schoolProximity.within500m)
      : query.schoolDistanceMetres === 1_000
        ? withSchools.filter((group) => group.schoolProximity.within1km)
        : withSchools;
  const schoolCoverage: SchoolCoverage[] = [500, 1_000].map((distanceMetres) => {
    const matchingLocations = withSchools.filter((group) => distanceMetres === 500 ? group.schoolProximity.within500m : group.schoolProximity.within1km).length;
    return {
      distanceMetres: distanceMetres as 500 | 1_000,
      matchingLocations,
      totalLocations: withSchools.length,
      percentage: withSchools.length ? Math.round((matchingLocations / withSchools.length) * 10_000) / 100 : null,
    };
  });
  const edgeWarning = schoolFilteredGroups.some((group) => {
    const degreesPerMetre = 180 / (Math.PI * EARTH_RADIUS_METRES);
    const margin = query.radiusMetres * degreesPerMetre;
    const latitudeNearEdge = group.anchor.latitude <= query.bbox!.south + margin || group.anchor.latitude >= query.bbox!.north - margin;
    if (latitudeNearEdge || query.bbox!.world === true) return latitudeNearEdge;
    const longitudeMargin = query.radiusMetres * degreesPerMetre / Math.max(Math.cos((group.anchor.latitude * Math.PI) / 180), 0.01);
    const longitudeNearEdge = query.bbox!.east >= query.bbox!.west
      ? group.anchor.longitude <= query.bbox!.west + longitudeMargin || group.anchor.longitude >= query.bbox!.east - longitudeMargin
      : group.anchor.longitude >= query.bbox!.west && group.anchor.longitude <= query.bbox!.west + longitudeMargin ||
        group.anchor.longitude <= query.bbox!.east && group.anchor.longitude >= query.bbox!.east - longitudeMargin;
    return longitudeNearEdge;
  });
  return { groups: schoolFilteredGroups, schoolCoverage, edgeWarning };
};

export const schoolCandidatesForAnchor = async (db: D1Database, latitude: number, longitude: number, metres: number): Promise<SchoolRecord[]> => querySchoolsNear(db, latitude, longitude, metres);

export const anchorBounds = bboxForAnalysisAnchor;
