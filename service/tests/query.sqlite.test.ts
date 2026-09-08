import { describe, expect, it } from 'vitest';
import { createSqliteD1, insertCollision, insertSchool } from './helpers';
import { buildPredicate, summaryMetricSql } from '../src/db';
import { countFilteredRecords, queryCollisionRows, queryDynamicAggregates, querySchools, querySummary } from '../src/query';
import type { QueryFilters } from '../contract';

const filters: QueryFilters = { years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all' };

describe('national D1 query SQL', () => {
  it('binds LIMIT after every predicate parameter', async () => {
    const { database, d1 } = createSqliteD1();
    insertCollision(database, { id: 'b', latitude: 51.5, longitude: -2.6, year: 2022 });
    insertCollision(database, { id: 'a', latitude: 51.6, longitude: -2.5, year: 2021 });
    const rows = await queryCollisionRows(d1, { ...filters, years: [2022] }, undefined, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('b');
    expect(rows[0].slight_casualties).toBe(1);
  });

  it('binds school search, limit and offset in order', async () => {
    const { database, d1 } = createSqliteD1();
    insertSchool(database, { id: 's1', name: 'Alpha School', latitude: 51.5, longitude: -2.6 });
    insertSchool(database, { id: 's2', name: 'Beta School', latitude: 51.6, longitude: -2.5 });
    const rows = await querySchools(d1, 'School', undefined, 1, 1);
    expect(rows.map((row) => row.id)).toEqual(['s2']);
  });

  it('scopes school search to the selected country', async () => {
    const { database, d1 } = createSqliteD1();
    insertSchool(database, { id: 'england-school', name: 'Shared School', country: 'England', latitude: 51.5, longitude: -2.6 });
    insertSchool(database, { id: 'wales-school', name: 'Shared School', country: 'Wales', latitude: 51.6, longitude: -2.5 });
    const rows = await querySchools(d1, 'Shared', undefined, 200, 0, 'Wales');
    expect(rows.map((row) => row.id)).toEqual(['wales-school']);
  });

  it('groups aggregate cells by computed expressions', async () => {
    const { database, d1 } = createSqliteD1();
    insertCollision(database, { id: 'a', latitude: 51.2, longitude: -2.6, year: 2021, severity: 'fatal', casualty_count: 2, ksi_casualties: 1 });
    insertCollision(database, { id: 'b', latitude: 51.3, longitude: -2.5, year: 2022, severity: 'serious', casualty_count: 1 });
    insertCollision(database, { id: 'c', latitude: 52.4, longitude: -2.5, year: 2022, severity: 'slight', casualty_count: null });
    const rows = await queryDynamicAggregates(d1, filters, undefined, 1);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(3);
    expect(rows.find((row) => Number(row.latitude_cell) === 141)?.fatal_count).toBe(1);
  });

  it('keeps exact summary metrics and unknown casualty records', async () => {
    const { database, d1 } = createSqliteD1();
    insertCollision(database, { id: 'a', latitude: 51, longitude: -2, severity: 'fatal', casualty_count: null, fatalities: null, ksi_casualties: null });
    insertCollision(database, { id: 'b', latitude: 51, longitude: -2, severity: 'slight', casualty_count: 2, fatalities: 0, ksi_casualties: 0 });
    const result = await querySummary(d1, { filters, radiusMetres: 100, harmFilter: 'all' });
    expect(result.precomputed).toBe(false);
    expect(result.metrics.collisions).toBe(2);
    expect(result.metrics.collisionSeverity).toEqual({ fatal: 1, serious: 0, slight: 1, unknown: 0 });
    expect(result.metrics.casualties.total).toEqual({ value: 2, unknownRecords: 1 });
  });

  it('reports zero totals for an empty selection', async () => {
    const { d1 } = createSqliteD1();
    const result = await querySummary(d1, { filters: { ...filters, years: [2099] }, radiusMetres: 100, harmFilter: 'all' });
    expect(result.metrics.collisions).toBe(0);
    expect(result.metrics.casualties.total).toEqual({ value: 0, unknownRecords: 0 });
  });

  it('handles antimeridian and world bboxes without dropping records', async () => {
    const { database, d1 } = createSqliteD1();
    insertCollision(database, { id: 'east', latitude: 51, longitude: 179.5 });
    insertCollision(database, { id: 'west', latitude: 51, longitude: -179.5 });
    insertCollision(database, { id: 'middle', latitude: 51, longitude: 0 });
    const crossing = { west: 179, south: 50, east: -179, north: 52 };
    expect(await countFilteredRecords(d1, filters, crossing)).toBe(2);
    expect(await countFilteredRecords(d1, filters, { west: -180, south: -90, east: 180, north: 90, world: true })).toBe(3);
  });

  it('produces parameterized predicates with stable nullable filters', () => {
    const predicate = buildPredicate({ ...filters, pedestrian: 'unknown', years: [2022], authorities: ['E1'] }, { west: -3, south: 50, east: -2, north: 52 });
    expect(predicate.sql).toContain('year IN (?)');
    expect(predicate.sql).toContain('authority_code IN (?)');
    expect(predicate.sql).toContain('pedestrian_involved IS NULL');
    expect(summaryMetricSql(predicate).params).toEqual([2022, 'E1', 50, 52, -3, -2]);
  });
});
