import { describe, expect, it } from 'vitest';
import { buildAnalysis } from '../src/analysis';
import { queryCollisionRows } from '../src/query';
import { createSqliteD1, insertCollision, insertSchool } from './helpers';
import type { ParsedQuery, QueryFilters } from '../contract';

const filters: QueryFilters = { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' };
const baseQuery: ParsedQuery = {
  filters,
  bbox: { west: -3, south: 50, east: -2, north: 52 },
  radiusMetres: 100,
  harmFilter: 'all',
};

describe('bounded national analysis', () => {
  it('reuses anchored grouping and separates collision severity from KSI harm', async () => {
    const { database, d1 } = createSqliteD1();
    insertCollision(database, { id: 'a', latitude: 51.5, longitude: -2.6, year: 2021, severity: 'serious', casualty_count: 1, ksi_casualties: 1 });
    insertCollision(database, { id: 'b', latitude: 51.5002, longitude: -2.6001, year: 2022, severity: 'slight', casualty_count: 2, ksi_casualties: 1 });
    insertCollision(database, { id: 'c', latitude: 51.4999, longitude: -2.5999, year: 2023, severity: 'slight', casualty_count: 1, ksi_casualties: 0 });
    insertSchool(database, { id: 'school-1', name: 'Near School', latitude: 51.5, longitude: -2.6 });
    const rows = await queryCollisionRows(d1, filters, baseQuery.bbox, 10_000);
    const result = await buildAnalysis(d1, rows, baseQuery);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].collisions).toBe(3);
    expect(result.groups[0].harm.collisionSeverity).toEqual({ fatal: 0, serious: 1, slight: 2, unknown: 0 });
    expect(result.groups[0].harm.ksiCollisions).toBe(2);
    expect(result.groups[0].harm.ksiCollisionYears).toEqual([2021, 2022]);
    expect(result.groups[0].schoolProximity.within500m).toBe(true);
    expect(result.schoolCoverage).toEqual([
      { distanceMetres: 500, matchingLocations: 1, totalLocations: 1, percentage: 100 },
      { distanceMetres: 1000, matchingLocations: 1, totalLocations: 1, percentage: 100 },
    ]);
  });

  it('filters repeated KSI by repeated collisions and school distance by selected scope', async () => {
    const { database, d1 } = createSqliteD1();
    insertCollision(database, { id: 'a', latitude: 51.5, longitude: -2.6, year: 2021, ksi_casualties: 1 });
    insertCollision(database, { id: 'b', latitude: 51.5002, longitude: -2.6001, year: 2022, ksi_casualties: 1 });
    insertCollision(database, { id: 'c', latitude: 51.4999, longitude: -2.5999, year: 2023, ksi_casualties: 0 });
    insertSchool(database, { id: 'school-1', name: 'Near School', latitude: 51.5, longitude: -2.6 });
    const rows = await queryCollisionRows(d1, filters, baseQuery.bbox, 10_000);
    const result = await buildAnalysis(d1, rows, { ...baseQuery, harmFilter: 'repeated-ksi', schoolDistanceMetres: 500 });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].harm.ksiCollisions).toBe(2);
    expect(result.schoolCoverage[0].totalLocations).toBe(1);
  });

  it('keeps nearly-global school searches as world bboxes after expansion', async () => {
    const { database, d1 } = createSqliteD1();
    const bbox = { west: -179.999, south: 51, east: 179.999, north: 52 };
    insertCollision(database, { id: 'a', latitude: 51.5, longitude: 0, year: 2021 });
    insertCollision(database, { id: 'b', latitude: 51.5002, longitude: 0.0001, year: 2022 });
    insertCollision(database, { id: 'c', latitude: 51.4999, longitude: -0.0001, year: 2023 });
    insertSchool(database, { id: 'school-1', name: 'Central School', latitude: 51.5, longitude: 0 });
    const rows = await queryCollisionRows(d1, filters, bbox, 10_000);
    const result = await buildAnalysis(d1, rows, { ...baseQuery, bbox });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].schoolProximity.within500m).toBe(true);
    expect(result.schoolCoverage[0]).toMatchObject({ matchingLocations: 1, totalLocations: 1, percentage: 100 });
  });
});
