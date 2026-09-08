import type { CollisionRecord, PersistentLocation } from './model';

const EARTH_RADIUS_METRES = 6_371_008.8;

const distanceMetres = (left: CollisionRecord, right: CollisionRecord): number => {
  const lat1 = (left.latitude * Math.PI) / 180;
  const lat2 = (right.latitude * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((right.longitude - left.longitude) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a));
};

/**
 * Seed groups in stable collision-ID order, then absorb every still-unassigned
 * point within the seed's haversine radius. This is deliberately non-chain:
 * an absorbed point never becomes a new seed, so each member is within the
 * configured radius of the anchor (while a group's overall diameter may reach
 * two radii). Conservative fixed-degree cells make candidate lookup bounded
 * without dropping points at bucket edges; the exact haversine check remains
 * the authority for membership.
 */
export const groupPersistentLocations = (
  records: CollisionRecord[],
  radiusMetres = 100,
  minCollisions = 3,
  minYears = 2,
): PersistentLocation[] => {
  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) throw new Error('Grouping radius must be greater than zero');
  if (minCollisions < 1 || minYears < 1) throw new Error('Persistence thresholds must be positive');
  const ordered = [...records].sort((left, right) => left.id.localeCompare(right.id) || left.latitude - right.latitude || left.longitude - right.longitude);
  const unassigned = new Map<string, CollisionRecord>(ordered.map((record, index) => [`${record.id}:${index}`, record]));
  const buckets = new Map<string, Set<string>>();
  // 110km/degree is intentionally lower than the true meridian scale. This
  // makes the cells wider than the maximum coordinate delta for the radius.
  const latitudeCellDegrees = radiusMetres / 110_000;
  const maximumLatitude = Math.min(89.9, Math.max(...ordered.map((record) => Math.abs(record.latitude)), 0) + latitudeCellDegrees);
  const longitudeCellDegrees = radiusMetres / (110_000 * Math.max(Math.cos((maximumLatitude * Math.PI) / 180), 0.01));
  const bucketKey = (record: CollisionRecord): string => `${Math.floor(record.longitude / longitudeCellDegrees)}:${Math.floor(record.latitude / latitudeCellDegrees)}`;
  unassigned.forEach((record, key) => {
    const bucket = buckets.get(bucketKey(record)) ?? new Set<string>();
    bucket.add(key);
    buckets.set(bucketKey(record), bucket);
  });
  const locations: PersistentLocation[] = [];
  for (const [anchorKey, anchor] of unassigned) {
    if (!unassigned.has(anchorKey)) continue;
    const baseX = Math.floor(anchor.longitude / longitudeCellDegrees);
    const baseY = Math.floor(anchor.latitude / latitudeCellDegrees);
    const memberKeys: string[] = [];
    for (let x = baseX - 1; x <= baseX + 1; x += 1) {
      for (let y = baseY - 1; y <= baseY + 1; y += 1) {
        const candidateKeys = buckets.get(`${x}:${y}`);
        if (!candidateKeys) continue;
        for (const candidateKey of candidateKeys) {
          const candidate = unassigned.get(candidateKey);
          if (candidate && distanceMetres(anchor, candidate) <= radiusMetres) memberKeys.push(candidateKey);
        }
      }
    }
    const members = memberKeys.map((key) => unassigned.get(key)).filter((record): record is CollisionRecord => Boolean(record));
    memberKeys.forEach((key) => {
      const candidate = unassigned.get(key);
      unassigned.delete(key);
      const bucket = candidate ? buckets.get(bucketKey(candidate)) : undefined;
      bucket?.delete(key);
    });
    const years = [...new Set(members.map((record) => record.year).filter((year): year is number => year !== null))].sort((a, b) => a - b);
    if (members.length < minCollisions || years.length < minYears) continue;
    locations.push({
      id: `location-${anchor.id}`,
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      collisions: members.length,
      fatalCollisions: members.filter((record) => record.severity === 'fatal').length,
      seriousCollisions: members.filter((record) => record.severity === 'serious').length,
      slightCollisions: members.filter((record) => record.severity === 'slight').length,
      unknownSeverity: members.filter((record) => record.severity === 'unknown').length,
      years,
      pedestrianInvolved: members.filter((record) => record.pedestrianInvolved === true).length,
      pedestrianUnknown: members.filter((record) => record.pedestrianInvolved === null).length,
      cycleInvolved: members.filter((record) => record.cycleInvolved === true).length,
      cycleUnknown: members.filter((record) => record.cycleInvolved === null).length,
      motorcycleInvolved: members.filter((record) => record.motorcycleInvolved === true).length,
      motorcycleUnknown: members.filter((record) => record.motorcycleInvolved === null).length,
      memberIds: members.map((record) => record.id).sort(),
    });
  }
  return locations.sort((left, right) => right.collisions - left.collisions || right.years.length - left.years.length || left.id.localeCompare(right.id));
};
