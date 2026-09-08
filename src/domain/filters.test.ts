import { describe, expect, it } from 'vitest';
import { filterRecords, summarizeRecords, type FilterState } from './filters';
import type { CollisionRecord } from './model';

const collision = (overrides: Partial<CollisionRecord> = {}): CollisionRecord => ({
  id: 'c-1', date: '2021-01-01', year: 2021, latitude: 51.45, longitude: -2.59, severity: 'slight',
  localAuthority: 'Bristol', roadName: null, roadNumber: 'A4', speedLimit: 30, junctionDetail: null,
  casualtyCount: 1, fatalities: 0, seriousCasualties: 0, ksiCasualties: 0,
  pedestrianInvolved: null, cycleInvolved: false, motorcycleInvolved: false, sourceProperties: {}, ...overrides,
});

const allFilters = (overrides: Partial<FilterState> = {}): FilterState => ({ years: [], authorities: [], severities: [], pedestrian: 'all', cycle: 'all', motorcycle: 'all', ...overrides });

describe('collision filters', () => {
  it('combines values within dimensions with OR and dimensions with AND', () => {
    const records = [
      collision({ id: 'a', year: 2021, severity: 'fatal', localAuthority: 'Bristol' }),
      collision({ id: 'b', year: 2022, severity: 'serious', localAuthority: 'North Somerset' }),
      collision({ id: 'c', year: 2022, severity: 'slight', localAuthority: 'Bristol', cycleInvolved: true }),
    ];
    expect(filterRecords(records, allFilters({ years: [2021, 2022], severities: ['fatal', 'serious'] })).map((record) => record.id)).toEqual(['a', 'b']);
    expect(filterRecords(records, allFilters({ authorities: ['Bristol'], cycle: 'yes' })).map((record) => record.id)).toEqual(['c']);
  });

  it('preserves unknown involvement as its own filter state', () => {
    const records = [collision({ id: 'unknown', cycleInvolved: null }), collision({ id: 'no', cycleInvolved: false }), collision({ id: 'yes', cycleInvolved: true })];
    expect(filterRecords(records, allFilters({ cycle: 'unknown' })).map((record) => record.id)).toEqual(['unknown']);
    expect(filterRecords(records, allFilters({ cycle: 'no' })).map((record) => record.id)).toEqual(['no']);
  });
});

describe('collision summary', () => {
  it('separates collision severity from casualty KSI totals', () => {
    const summary = summarizeRecords([
      collision({ id: 'fatal', severity: 'fatal', casualtyCount: 2, fatalities: 1, seriousCasualties: 1, ksiCasualties: 2 }),
      collision({ id: 'serious', severity: 'serious', casualtyCount: 3, fatalities: 0, seriousCasualties: 2, ksiCasualties: 2 }),
      collision({ id: 'unknown', severity: 'unknown', casualtyCount: null, fatalities: null, seriousCasualties: null, ksiCasualties: null }),
    ]);
    expect(summary.fatalCollisions).toBe(1);
    expect(summary.seriousCollisions).toBe(1);
    expect(summary.unknownSeverity).toBe(1);
    expect(summary.collisions).toBe(3);
    expect(summary.casualties).toBe(5);
    expect(summary.casualtiesUnknown).toBe(1);
    expect(summary.fatalitiesUnknown).toBe(1);
    expect(summary.seriousCasualtiesUnknown).toBe(1);
    expect(summary.ksiCasualties).toBe(4);
    expect(summary.ksiCasualtiesUnknown).toBe(1);
  });
});
