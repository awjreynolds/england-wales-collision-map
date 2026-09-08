import { describe, expect, it } from 'vitest';
import { recordsInViewport, summarizeCasualtySeverities, type ViewportBounds } from './viewport';
import type { CollisionRecord } from './model';

const collision = (id: string, latitude: number, longitude: number, overrides: Partial<CollisionRecord> = {}): CollisionRecord => ({
  id,
  date: '2024-01-01',
  year: 2024,
  latitude,
  longitude,
  severity: 'slight',
  localAuthority: 'Bristol',
  roadName: null,
  roadNumber: null,
  speedLimit: null,
  junctionDetail: null,
  casualtyCount: 3,
  fatalities: 1,
  seriousCasualties: 1,
  ksiCasualties: 2,
  pedestrianInvolved: null,
  cycleInvolved: null,
  motorcycleInvolved: null,
  sourceProperties: {},
  ...overrides,
});

describe('viewport analysis', () => {
  it('selects records by coordinates, including boundary points and wrapped longitudes', () => {
    const records = [
      collision('inside', 51.45, -2.59),
      collision('edge', 51.46, -2.58),
      collision('outside', 51.5, -2.5),
    ];
    const bounds: ViewportBounds = { west: -2.6, east: -2.58, south: 51.44, north: 51.46 };
    expect(recordsInViewport(records, bounds).map((record) => record.id)).toEqual(['inside', 'edge']);
    expect(recordsInViewport([
      collision('west', 0, 179.5),
      collision('east', 0, -179.5),
      collision('outside', 0, 0),
    ], { west: 170, east: -170, south: -1, north: 1 }).map((record) => record.id)).toEqual(['west', 'east']);
    expect(recordsInViewport([
      collision('wrapped-west', 0, -179),
      collision('wrapped-east', 0, 179),
      collision('outside', 0, 0),
    ], { west: 181, east: 541, south: -1, north: 1 }).map((record) => record.id)).toEqual(['wrapped-west', 'wrapped-east', 'outside']);
    expect(recordsInViewport([
      collision('inside', 0, 179),
      collision('outside', 0, 0),
    ], { west: 170, east: -170, south: -1, north: 1 }).map((record) => record.id)).toEqual(['inside']);
  });

  it('returns no records for an empty map window without turning zero into missing data', () => {
    expect(recordsInViewport([collision('outside', 51.45, -2.59)], { west: -2, east: -1, south: 52, north: 53 })).toEqual([]);
    const summary = summarizeCasualtySeverities([]);
    expect(summary).toEqual({ fatalities: null, fatalitiesUnknown: 0, serious: null, seriousUnknown: 0, slight: null, slightUnknown: 0 });
  });

  it('derives slightly injured people only when total and known fatal/serious counts exist', () => {
    const summary = summarizeCasualtySeverities([
      collision('complete', 51.45, -2.59),
      collision('unknown', 51.45, -2.59, { casualtyCount: 2, fatalities: null, seriousCasualties: 1, ksiCasualties: null }),
    ]);
    expect(summary.fatalities).toBe(1);
    expect(summary.serious).toBe(2);
    expect(summary.slight).toBe(1);
    expect(summary.slightUnknown).toBe(1);
    expect(summary.fatalitiesUnknown).toBe(1);
  });
});
